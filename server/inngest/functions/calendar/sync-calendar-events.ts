/**
 * Sync Calendar Events Inngest Function
 * 
 * Syncs Google Calendar events for a user and stores them in the database.
 * Migrated from Supabase Edge Functions to Inngest.
 */

import { inngest } from "../../client";
import { getSupabaseAdmin, getGoogleTokens, refreshAccessToken, resolveOrgForUser } from "../../utils";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "sync-calendar-events" });

export const syncCalendarEvents = inngest.createFunction(
  { 
    id: "sync-calendar-events",
    retries: 1,
    concurrency: 5,
  },
  { event: "calendar/sync" },
  async ({ event, step }) => {
    const { userId, organizationId } = event.data;

    log.info({ userId }, "Starting sync for user");

    try {
      // Step 1: Get Google OAuth tokens
      const tokens = await step.run("get-google-tokens", async () => {
        const supabase = getSupabaseAdmin();
        
        // First check if credentials exist
        let query = supabase
          .from('calendar_credentials')
          .select('sync_status, last_error, last_error_at')
          .eq('user_id', userId);
        if (organizationId) {
          query = query.eq('organization_id', organizationId);
        }
        const { data: credCheck, error: credError } = await query.maybeSingle();

        if (credError) {
          log.error({ err: credError, userId }, "Error checking credentials for user");
          return null;
        }

        if (!credCheck) {
          log.warn({ userId }, "No calendar credentials found for user");
          return null;
        }

        if (credCheck.sync_status !== 'active') {
          log.warn({ userId, syncStatus: credCheck.sync_status }, "User has credentials but status is not active");
          if (credCheck.last_error) {
            log.warn({ lastError: credCheck.last_error, lastErrorAt: credCheck.last_error_at }, "Last error");
          }
          return null;
        }

        return await getGoogleTokens(supabase, userId, organizationId);
      });

      if (!tokens) {
        await step.run("mark-sync-skipped", async () => {
          const supabase = getSupabaseAdmin();
          await supabase
            .from("calendar_credentials")
            .update({ 
              last_sync_attempt: new Date().toISOString(),
              last_error: "No active Google credentials - user may need to re-authenticate",
              last_error_at: new Date().toISOString(),
            })
            .eq("user_id", userId);
        });

        return {
          status: 'skipped',
          userId,
          reason: 'No active Google credentials found',
          message: 'User needs to authenticate with Google Calendar',
        };
      }

      // Step 2: Fetch calendar events from Google (with 401 retry via token refresh)
      const events = await step.run("fetch-calendar-events", async () => {
        const now = new Date();
        const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const twoMonthsFromNow = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

        const params = new URLSearchParams({
          timeMin: oneMonthAgo.toISOString(),
          timeMax: twoMonthsFromNow.toISOString(),
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: "250",
        });

        const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`;

        const fetchEvents = async (accessToken: string) => {
          return fetch(url, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
        };

        let response = await fetchEvents(tokens.accessToken);

        // On 401, attempt a token refresh and retry once before failing
        if (response.status === 401 && tokens.refreshToken) {
          log.info({ userId }, "Got 401, attempting token refresh for user");
          try {
            const newAccessToken = await refreshAccessToken(
              tokens.refreshToken,
              undefined,
              undefined,
              { userId, calendarEmail: tokens.calendarEmail }
            );

            // Persist the refreshed token so subsequent syncs don't hit the same 401
            const supabase = getSupabaseAdmin();
            const { data: encrypted } = await supabase.rpc('encrypt_token', { token: newAccessToken });
            if (encrypted) {
              await supabase
                .from('calendar_credentials')
                .update({
                  access_token_encrypted: encrypted,
                  token_expiry: new Date(Date.now() + 3600 * 1000).toISOString(),
                  last_error: null,
                  last_error_at: null,
                })
                .eq('user_id', userId);
            }

            response = await fetchEvents(newAccessToken);
          } catch (refreshErr) {
            log.error({ err: refreshErr, userId }, "Token refresh failed for user");
            throw new Error(`Authentication error: Token refresh failed after 401`);
          }
        }

        if (!response.ok) {
          const errorText = await response.text();
          let errorJson;
          try {
            errorJson = JSON.parse(errorText);
          } catch {
            errorJson = { error: errorText };
          }

          log.error({ userId, status: response.status, error: errorJson }, "Failed to fetch calendar events for user");

          // Check for auth errors
          if (response.status === 401 || response.status === 403) {
            throw new Error(`Authentication error: ${errorText}`);
          }

          throw new Error(`Failed to fetch calendar events: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        return data.items || [];
      });

      log.info({ eventCount: events.length }, "Fetched events");

      // Step 3: Get user's organization for multi-tenant isolation
      const actualOrgId = await step.run("get-organization", async () => {
        if (organizationId) return organizationId;
        return resolveOrgForUser(userId);
      });

      // Step 4: Upsert events to database
      const syncResult = await step.run("upsert-events", async () => {
        const supabase = getSupabaseAdmin();

        const eventsToUpsert = events.map((e: any) => ({
          user_id: userId,
          organization_id: actualOrgId, // Multi-tenant isolation
          google_event_id: e.id,
          summary: e.summary || "Untitled Event",
          description: e.description || null,
          location: e.location || null,
          start_time: e.start?.dateTime || e.start?.date,
          end_time: e.end?.dateTime || e.end?.date,
          attendees: e.attendees || [],
          organizer: e.organizer || null,
          status: e.status || "confirmed",
          html_link: e.htmlLink || null,
          created: e.created || null,
          updated: e.updated || null,
        }));

        const { data, error } = await supabase
          .from("calendar_events")
          .upsert(eventsToUpsert, {
            onConflict: "user_id,google_event_id",
            ignoreDuplicates: false,
          })
          .select();

        if (error) {
          throw new Error(`Failed to upsert events: ${error.message}`);
        }

        // Update last sync time
        await supabase
          .from("calendar_credentials")
          .update({ 
            last_sync: new Date().toISOString(),
            last_error: null,
            last_error_at: null,
          })
          .eq("user_id", userId);

        return data?.length || 0;
      });

      log.info({ syncedCount: syncResult, userId }, "Synced events for user");

      return { 
        status: 'success',
        eventsSynced: syncResult,
        userId 
      };
    } catch (error: any) {
      log.error({ err: error, userId }, "Error syncing calendar for user");

      // Handle permanent OAuth errors only — transient failures (rate limits,
      // 5xx, network blips) should throw and let Inngest retry.
      if (error.message?.includes('invalid_grant') || error.message?.includes('invalid_client')) {
        await step.run("mark-credentials-invalid", async () => {
          const supabase = getSupabaseAdmin();
          
          await supabase
            .from("calendar_credentials")
            .update({ 
              sync_status: "auth_required",
              last_error: error.message,
              last_error_at: new Date().toISOString(),
            })
            .eq("user_id", userId);

          log.info({ userId }, "Marked credentials as requiring re-authentication for user");
        });

        return {
          status: 'auth_required',
          userId,
          error: 'User needs to re-authenticate with Google Calendar',
        };
      }

      // For other errors, throw to trigger retry
      throw error;
    }
  }
);
