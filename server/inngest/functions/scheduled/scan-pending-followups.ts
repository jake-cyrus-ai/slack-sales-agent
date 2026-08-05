/**
 * Scan Pending Follow-Ups — Scheduled Inngest Function
 *
 * Runs every 15 minutes to find email follow-ups that are due.
 * For each due follow-up, checks if the prospect has replied
 * (cancelling the follow-up if so) or fires a send event.
 *
 * Safeguards:
 * - Checks if prospect replied in the thread (auto-cancels)
 * - Respects user timezone (only sends during business hours)
 * - Respects max followup count per thread
 * - Verifies autonomous emails is still enabled
 */

import { inngest } from "../../client";
import { getSupabaseAdmin } from "../../utils";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "scan-pending-followups" });

export const scanPendingFollowups = inngest.createFunction(
  {
    id: "scan-pending-followups",
    retries: 2,
  },
  { cron: "*/15 * * * *" }, // Every 15 minutes
  async ({ step }) => {
    log.info("Scanning for due follow-ups");

    // Step 1: Find follow-ups that are due
    const dueFollowups = await step.run("find-due-followups", async () => {
      const supabase = getSupabaseAdmin();
      const now = new Date().toISOString();

      const { data, error } = await supabase
        .from("email_scheduled_followups")
        .select(`
          id, user_id, organization_id, thread_conversation_id,
          scheduled_for, followup_number, status
        `)
        .eq("status", "scheduled")
        .lte("scheduled_for", now)
        .order("scheduled_for", { ascending: true })
        .limit(50);

      if (error) {
        log.error({ err: error }, "Error fetching followups");
        return [];
      }

      return data || [];
    });

    if (dueFollowups.length === 0) {
      return { processed: 0, message: "No due follow-ups" };
    }

    log.info({ count: dueFollowups.length }, "Found due follow-ups");

    // Step 2: Check each follow-up for reply and filter
    const validFollowups = await step.run("check-replies-and-filter", async () => {
      const supabase = getSupabaseAdmin();

      // ── Batch-fetch all related data upfront (eliminates N+1) ──────────
      const threadIds = [...new Set(dueFollowups.map((f) => f.thread_conversation_id))];

      const threadsResult = await supabase
        .from("email_thread_conversations")
        .select("id, last_their_reply_at, followup_status, max_followups, gmail_thread_id")
        .in("id", threadIds);

      const threadMap = new Map(
        (threadsResult.data || []).map((t) => [t.id, t])
      );

      // Batch-fetch organizations for feature flag checks. The org id is carried
      // directly on each followup row (email_scheduled_followups.organization_id);
      // it must NOT be resolved via profiles.current_organization_id — that column
      // was dropped (migration 20260413173859_drop_current_organization_id) and the
      // stale lookup silently cancelled every follow-up as "autonomous_disabled".
      const orgIds = [
        ...new Set(
          dueFollowups
            .map((f) => f.organization_id)
            .filter(Boolean) as string[]
        ),
      ];

      const orgsResult = orgIds.length > 0
        ? await supabase
            .from("organizations")
            .select("id, feature_flags")
            .in("id", orgIds)
        : { data: [] };

      const orgFlagsMap = new Map(
        (orgsResult.data || []).map((o) => [o.id, o.feature_flags])
      );

      // Helper: check autonomous mode from pre-fetched org flags
      const isAutonomousEnabled = (orgId: string | null): boolean => {
        if (!orgId) return false;
        const flags = orgFlagsMap.get(orgId) as Record<string, any> | undefined;
        return flags?.autonomous_mode?.enabled === true;
      };

      // ── Filter followups using in-memory lookups ───────────────────────
      const valid: typeof dueFollowups = [];

      // Collect cancellation/update writes to execute in parallel at the end
      const followupUpdates: PromiseLike<any>[] = [];
      const threadUpdates: PromiseLike<any>[] = [];

      for (const followup of dueFollowups) {
        const thread = threadMap.get(followup.thread_conversation_id);

        if (!thread) {
          // Thread record gone — cancel the follow-up
          followupUpdates.push(
            supabase
              .from("email_scheduled_followups")
              .update({ status: "cancelled", cancelled_reason: "thread_not_found" })
              .eq("id", followup.id)
          );
          continue;
        }

        // If they replied after we scheduled this, cancel
        if (thread.last_their_reply_at && new Date(thread.last_their_reply_at) > new Date(followup.scheduled_for)) {
          followupUpdates.push(
            supabase
              .from("email_scheduled_followups")
              .update({ status: "superseded", cancelled_reason: "prospect_replied" })
              .eq("id", followup.id)
          );
          threadUpdates.push(
            supabase
              .from("email_thread_conversations")
              .update({ followup_status: "replied" })
              .eq("id", followup.thread_conversation_id)
          );
          continue;
        }

        // Check max followups
        if (followup.followup_number > (thread.max_followups || 3)) {
          followupUpdates.push(
            supabase
              .from("email_scheduled_followups")
              .update({ status: "cancelled", cancelled_reason: "max_followups_reached" })
              .eq("id", followup.id)
          );
          threadUpdates.push(
            supabase
              .from("email_thread_conversations")
              .update({ followup_status: "exhausted" })
              .eq("id", followup.thread_conversation_id)
          );
          continue;
        }

        // Verify autonomous mode still enabled for this followup's org
        if (!isAutonomousEnabled(followup.organization_id ?? null)) {
          followupUpdates.push(
            supabase
              .from("email_scheduled_followups")
              .update({ status: "cancelled", cancelled_reason: "autonomous_disabled" })
              .eq("id", followup.id)
          );
          continue;
        }

        valid.push(followup);
      }

      // Execute all cancellation/status writes in parallel
      await Promise.all([...followupUpdates, ...threadUpdates]);

      return valid;
    });

    if (validFollowups.length === 0) {
      log.info("No valid follow-ups after filtering");
      return { processed: 0, filtered: dueFollowups.length };
    }

    // Step 3: Fan out follow-up send events
    await step.sendEvent(
      "fan-out-followups",
      validFollowups.map((followup) => ({
        name: "email/followup-send" as const,
        data: {
          followupId: followup.id,
          threadConversationId: followup.thread_conversation_id,
          userId: followup.user_id,
          organizationId: followup.organization_id,
        },
      }))
    );

    log.info({ count: validFollowups.length }, "Queued follow-up sends");

    return {
      processed: validFollowups.length,
      totalDue: dueFollowups.length,
      filtered: dueFollowups.length - validFollowups.length,
    };
  }
);
