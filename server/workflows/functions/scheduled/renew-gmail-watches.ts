/**
 * Renew Gmail Watches — Scheduled Vercel Workflow Function
 *
 * Gmail push-notification watches (users.me.watch) expire 7 days after
 * registration. Without renewal the real-time email pipeline silently goes
 * dark and only the 5-minute polling fallback remains.
 *
 * Runs every 12 hours: finds active watch subscriptions expiring within the
 * next 2 days (or already expired) and re-invokes email/ensure-gmail-watch per
 * user. ensure-gmail-watch is idempotent — it no-ops when the watch is still
 * valid for more than an hour — so proactive invocation is safe.
 */

import { workflow } from "../../client";
import { getSupabaseAdmin } from "../../utils";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "renew-gmail-watches" });

// Renew watches expiring within this window. Gmail watches last ~7 days; a
// 2-day lead time leaves room for retries before the watch actually lapses.
const RENEWAL_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

export const renewGmailWatches = workflow.createFunction(
  {
    id: "renew-gmail-watches",
    retries: 2,
  },
  { cron: "0 */12 * * *" }, // Every 12 hours
  async ({ step }) => {
        // Step 1: Find active watches expiring soon (or already expired).
    const expiringWatches = await step.run("find-expiring-watches", async () => {
            const supabase = getSupabaseAdmin();
      const cutoff = new Date(Date.now() + RENEWAL_WINDOW_MS).toISOString();

      const { data, error } = await supabase
        .from("gmail_watch_subscriptions")
        .select("user_id, expiration")
        .eq("is_active", true)
        .lt("expiration", cutoff);

      if (error) {
        log.error({ err: error }, "Failed to query gmail_watch_subscriptions");
        throw error;
      }

      return data ?? [];
    });

    if (expiringWatches.length === 0) {
      log.info("No Gmail watches expiring within the renewal window");
      return { renewed: 0 };
    }

    log.info(
      { count: expiringWatches.length },
      "Renewing Gmail watches expiring soon",
    );

    // Step 2: Fan out an idempotent ensure-gmail-watch event per user.
    await step.sendEvent(
      "fan-out-watch-renewals",
      expiringWatches.map((w) => ({
        name: "email/ensure-gmail-watch" as const,
        data: { userId: w.user_id },
      })),
    );

    return { renewed: expiringWatches.length };
  },
);
