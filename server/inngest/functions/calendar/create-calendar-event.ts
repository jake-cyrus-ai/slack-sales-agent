/**
 * Create Calendar Event Inngest Function
 *
 * Creates a Google Calendar event for a user asynchronously via Inngest.
 * Uses the SafeCalendarClient to ensure deletion is structurally impossible.
 */

import { inngest } from "../../client";
import { getSupabaseAdmin, getGoogleTokens, resolveOrgForUser } from "../../utils";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "create-calendar-event" });

export const createCalendarEvent = inngest.createFunction(
  {
    id: "create-calendar-event",
    retries: 1,
    concurrency: 5,
  },
  { event: "calendar/create-event" },
  async ({ event, step }) => {
    const {
      userId,
      summary,
      startDateTime,
      endDateTime,
      description,
      attendees,
      location,
      addVideoConference,
      organizationId,
    } = event.data;

    log.info({ summary, userId }, "Creating event");

    // Step 1: Get Google OAuth tokens
    const tokens = await step.run("get-google-tokens", async () => {
      const supabase = getSupabaseAdmin();

      const { data: credCheck, error: credError } = await supabase
        .from("calendar_credentials")
        .select("sync_status")
        .eq("user_id", userId)
        .maybeSingle();

      if (credError || !credCheck) {
        log.warn({ userId }, "No calendar credentials for user");
        return null;
      }

      if (credCheck.sync_status !== "active") {
        log.warn({ syncStatus: credCheck.sync_status }, "Credentials not active");
        return null;
      }

      return await getGoogleTokens(supabase, userId);
    });

    if (!tokens) {
      return {
        status: "failed",
        error: "No active Google credentials. User needs to connect Google Calendar.",
        userId,
      };
    }

    // Step 2: Create the calendar event via Google API
    const result = await step.run("create-event", async () => {
      const start = new Date(startDateTime);
      if (isNaN(start.getTime())) {
        throw new Error(`Invalid startDateTime: "${startDateTime}"`);
      }
      const end = endDateTime
        ? new Date(endDateTime)
        : new Date(start.getTime() + 30 * 60 * 1000);
      if (isNaN(end.getTime())) {
        throw new Error(`Invalid endDateTime: "${endDateTime}"`);
      }

      // Fetch user's timezone from profile
      const supabase = getSupabaseAdmin();
      const { data: profile } = await supabase
        .from("profiles")
        .select("timezone")
        .eq("user_id", userId)
        .single();
      const userTimezone = profile?.timezone || "UTC";

      const eventBody: any = {
        summary,
        start: { dateTime: start.toISOString(), timeZone: userTimezone },
        end: { dateTime: end.toISOString(), timeZone: userTimezone },
      };

      if (description) eventBody.description = description;
      if (location) eventBody.location = location;

      if (attendees && attendees.length > 0) {
        eventBody.attendees = attendees.map((email: string) => ({ email }));
      }

      if (addVideoConference) {
        eventBody.conferenceData = {
          createRequest: {
            requestId: `agent-${Date.now()}`,
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        };
      }

      const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
      if (attendees && attendees.length > 0) {
        url.searchParams.set("sendUpdates", "all");
      }
      if (addVideoConference) {
        url.searchParams.set("conferenceDataVersion", "1");
      }

      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(eventBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Calendar API error ${response.status}: ${errorText}`);
      }

      return await response.json();
    });

    // Step 3: Optionally store in local database for faster searching
    await step.run("store-event-locally", async () => {
      const supabase = getSupabaseAdmin();

      // Resolve org ID
      let orgId = organizationId;
      if (!orgId) {
        orgId = await resolveOrgForUser(userId);
      }

      await supabase.from("calendar_events").upsert(
        {
          user_id: userId,
          organization_id: orgId,
          google_event_id: result.id,
          summary: result.summary || summary,
          description: result.description || description || null,
          location: result.location || location || null,
          start_time: result.start?.dateTime || result.start?.date,
          end_time: result.end?.dateTime || result.end?.date,
          attendees: result.attendees || [],
          organizer: result.organizer || null,
          status: result.status || "confirmed",
          html_link: result.htmlLink || null,
          created: result.created || null,
          updated: result.updated || null,
        },
        { onConflict: "user_id,google_event_id", ignoreDuplicates: false }
      );
    });

    log.info({ eventId: result.id }, "Event created");

    return {
      status: "success",
      eventId: result.id,
      summary: result.summary,
      start: result.start?.dateTime || result.start?.date,
      end: result.end?.dateTime || result.end?.date,
      attendees: (result.attendees || []).map((a: any) => ({
        email: a.email,
        status: a.responseStatus,
      })),
      meetingLink:
        result.hangoutLink ||
        result.conferenceData?.entryPoints?.[0]?.uri ||
        null,
      htmlLink: result.htmlLink,
      userId,
    };
  }
);
