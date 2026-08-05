/**
 * Backfill Usage Rollups — Vercel Workflow Scheduled Function
 *
 * Runs daily at 02:00 UTC. Calls the SQL function backfill_usage_rollups()
 * which idempotently UPSERTs the last 30 days into usage_org_daily and
 * usage_user_daily from the raw usage_events table.
 */

import { workflow } from "../../client";
import { getSupabaseAdmin } from "../../utils/supabase";

export const backfillUsageRollups = workflow.createFunction(
  {
    id: "backfill-usage-rollups",
    retries: 2,
  },
  { cron: "0 2 * * *" }, // every day at 02:00 UTC
  async ({ step, logger }) => {
        const result = await step.run("run-backfill", async () => {
            const supabase = getSupabaseAdmin();

      // Backfill last 30 days
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 30);

      const pStart = start.toISOString().slice(0, 10); // YYYY-MM-DD
      const pEnd = end.toISOString().slice(0, 10);

      const { error } = await supabase.rpc("backfill_usage_rollups", {
        p_start: pStart,
        p_end: pEnd,
      });

      if (error) {
        throw new Error(`backfill_usage_rollups RPC failed: ${error.message}`);
      }

      return { backfilledFrom: pStart, backfilledTo: pEnd };
    });

    logger.info("Usage rollups backfilled", result);
    return result;
  },
);
