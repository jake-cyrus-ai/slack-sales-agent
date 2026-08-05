/**
 * Scan Upcoming Meetings — Scheduled Inngest Function
 *
 * Runs every 5 minutes. For each Slack-connected user, checks Google Calendar
 * for meetings starting in the next 15 minutes that haven't had prep delivered,
 * then fans out meeting-prep events.
 *
 * Uses live Google Calendar API (not cached Supabase tables).
 *
 * Safeguards:
 * - Dedup: skips meetings that already have a meeting_prep_cache entry
 * - Only preps meetings with external attendees
 */

import { inngest } from "../../client";
import { getSupabaseAdmin } from "../../utils";
import { getGoogleTokens, googleApiFetch } from "../../../src/services/token-manager.js";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "scan-upcoming-meetings" });

const LOOKAHEAD_MINUTES = 15;

export const scanUpcomingMeetings = inngest.createFunction(
  {
    id: "scan-upcoming-meetings",
    retries: 2,
  },
  { cron: "*/5 * * * *" }, // Every 5 minutes
  async ({ step }) => {
    log.info("Scanning for meetings starting soon");

    // Step 1: Get all Slack-connected users with Google tokens
    const eligibleUsers = await step.run("find-eligible-users", async () => {
      const supabase = getSupabaseAdmin();

      const { data: mappings, error } = await supabase
        .from("slack_user_mappings")
        .select("agent_user_id, slack_user_id, slack_workspace_id, organization_id")
        .eq("is_active", true);

      if (error || !mappings?.length) return [];

      // Get user emails for external attendee filtering
      const userIds = mappings.map((m) => m.agent_user_id);
      const { data: profiles } = await supabase
        .from("profiles")
        .select("user_id, email")
        .in("user_id", userIds);

      const emailMap = new Map((profiles || []).map((p: any) => [p.user_id, p.email]));

      return mappings
        .filter((m) => emailMap.has(m.agent_user_id))
        .map((m) => ({
          userId: m.agent_user_id,
          slackUserId: m.slack_user_id,
          slackWorkspaceId: m.slack_workspace_id,
          organizationId: m.organization_id,
          email: emailMap.get(m.agent_user_id)!,
        }));
    });

    if (eligibleUsers.length === 0) {
      return { processed: 0, message: "No eligible users" };
    }

    // Step 2: Fetch upcoming meetings from Google Calendar for each user
    const allMeetings: {
      userId: string;
      organizationId: string;
      calendarEventId: string;
      summary: string;
      startTime: string;
      attendees: { email: string; name?: string }[];
    }[] = [];

    for (const user of eligibleUsers) {
      const userMeetings = await step.run(`fetch-calendar-${user.userId.slice(-8)}`, async () => {
        const tokens = await getGoogleTokens(user.userId);
        if (!tokens) return [];

        const now = new Date();
        const windowEnd = new Date(now.getTime() + LOOKAHEAD_MINUTES * 60 * 1000);

        try {
          const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(now.toISOString())}&timeMax=${encodeURIComponent(windowEnd.toISOString())}&maxResults=10&singleEvents=true&orderBy=startTime`;
          const res = await googleApiFetch(url, tokens.accessToken);
          if (!res.ok) return [];

          const data = await res.json();
          const userDomain = user.email.split("@")[1]?.toLowerCase();

          return (data.items || [])
            .filter((e: any) => e.status !== "cancelled")
            .filter((e: any) => {
              // Only meetings with external attendees
              const attendees = e.attendees || [];
              return attendees.some((a: any) => {
                const domain = a.email?.split("@")[1]?.toLowerCase();
                return domain && domain !== userDomain;
              });
            })
            .map((e: any) => ({
              userId: user.userId,
              organizationId: user.organizationId,
              calendarEventId: e.id,
              summary: e.summary || "(No title)",
              startTime: e.start?.dateTime || e.start?.date,
              attendees: (e.attendees || []).map((a: any) => ({
                email: a.email,
                name: a.displayName,
              })),
            }));
        } catch (err) {
          log.error({ userId: user.userId, err }, "Calendar fetch error for user");
          return [];
        }
      });

      allMeetings.push(...userMeetings);
    }

    if (allMeetings.length === 0) {
      return { processed: 0, message: "No upcoming meetings with external attendees" };
    }

    log.info({ meetings: allMeetings.length, users: eligibleUsers.length }, "Found meetings across users");

    // Step 3: Dedup — filter out meetings that already have prep delivered.
    // The Inngest event `id` field only deduplicates within a short window,
    // so across multiple 5-min cron runs the same meeting would fire ~3 times.
    // Instead, check meeting_prep_cache via calendar_events for a real dedup.
    const newMeetings = await step.run("dedup-already-prepped", async () => {
      const supabase = getSupabaseAdmin();
      const googleEventIds = allMeetings.map((m) => m.calendarEventId);

      // Find calendar_events that already have a meeting_prep_cache entry
      const { data: alreadyPrepped } = await supabase
        .from("calendar_events")
        .select("google_event_id, meeting_prep_cache!inner(id)")
        .in("google_event_id", googleEventIds);

      const preppedSet = new Set(
        (alreadyPrepped || []).map((row: any) => row.google_event_id)
      );

      return allMeetings.filter((m) => !preppedSet.has(m.calendarEventId));
    });

    if (newMeetings.length === 0) {
      log.info({ count: allMeetings.length }, "All meetings already prepped, skipping");
      return { processed: 0, message: "All meetings already prepped" };
    }

    // Step 4: Fan out meeting-prep events for unprepped meetings only
    await step.sendEvent(
      "fan-out-meeting-prep",
      newMeetings.map((meeting) => ({
        name: "calendar/meeting-prep" as const,
        id: `meeting-prep-${meeting.userId}-${meeting.calendarEventId}`,
        data: {
          userId: meeting.userId,
          eventId: meeting.calendarEventId,
          organizationId: meeting.organizationId,
          requireApproval: false,
          autoDeliver: true,
        },
      }))
    );

    log.info({ queued: newMeetings.length, alreadyPrepped: allMeetings.length - newMeetings.length }, "Queued meeting prep jobs");

    return {
      processed: allMeetings.length,
    };
  }
);
