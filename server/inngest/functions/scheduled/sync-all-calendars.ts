/**
 * Sync All Calendars - Scheduled Inngest Function
 * 
 * Syncs Google Calendar events for all users with active calendar connections.
 * Runs every hour via Inngest cron trigger.
 * 
 * Migrated from: supabase/functions/sync-all-calendars
 */

import { inngest } from "../../client";
import { getSupabaseAdmin } from "../../utils";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "sync-all-calendars" });

export const syncAllCalendars = inngest.createFunction(
  { 
    id: "sync-all-calendars",
    retries: 2,
  },
  { cron: "0 * * * *" }, // Every hour at minute 0
  async ({ step }) => {
    log.info("Starting scheduled calendar sync");

    // Step 1: Get all users with active calendar credentials
    const users = await step.run("get-users-with-calendars", async () => {
      const supabase = getSupabaseAdmin();
      
      const { data: credentials, error: credsError } = await supabase
        .from("calendar_credentials")
        .select("user_id, calendar_email, sync_status")
        .eq("sync_status", "active");

      if (credsError) {
        log.error({ err: credsError }, "Error fetching credentials");
        throw credsError;
      }

      if (!credentials || credentials.length === 0) {
        log.info("No active calendar credentials found");
        return [];
      }

      log.info({ count: credentials.length }, "Found users with active calendars");
      return credentials.map(c => ({
        userId: c.user_id,
        calendarEmail: c.calendar_email,
      }));
    });

    if (users.length === 0) {
      return { 
        message: "No active calendars to sync", 
        synced: 0,
      };
    }

    // Step 2: Fan out calendar sync events for each user
    await step.sendEvent("fan-out-sync", users.map(user => ({
      name: "calendar/sync",
      data: { userId: user.userId },
    })));

    log.info({ count: users.length }, "Triggered sync for users");

    return { 
      message: "Calendar sync initiated",
      total: users.length,
      usersQueued: users.length,
    };
  }
);
