/**
 * Feedback capture utility — shared helper for writing feedback events.
 *
 * Every signal capture point (email approve/reject/edit, chat correction,
 * deal action, reminder action) calls writeFeedbackEvent() to record the
 * signal and optionally trigger the learning pipeline when enough events
 * accumulate.
 */

import { getSupabaseAdmin } from "./supabase";
import { workflow } from "../client";
import { logger } from "../../lib/logger";

const log = logger.child({ util: "feedback-capture" });

const LEARNING_THRESHOLD = 5; // trigger extraction after this many unprocessed events

export interface FeedbackEventParams {
  userId: string;
  organizationId: string;
  domain: string;       // email_draft, email_approval, deal_action, meeting_prep, chat, reminder
  signalType: string;   // edit, correction, rejection, approval, flag, revert, ignore
  agentOutput?: Record<string, unknown> | null;
  userAction?: Record<string, unknown> | null;
  delta?: Record<string, unknown> | null;
  context?: Record<string, unknown> | null;
  sourceRef?: { table: string; id: string } | null;
}

/**
 * Write a feedback event and check if the learning pipeline should run.
 *
 * Fire-and-forget: logs errors but never throws, so callers don't need
 * to handle failures (same pattern as trackUsageEvent).
 */
export async function writeFeedbackEvent(params: FeedbackEventParams): Promise<void> {
  try {
    const supabase = getSupabaseAdmin();

    const { error } = await supabase.from("feedback_events").insert({
      user_id: params.userId,
      organization_id: params.organizationId,
      domain: params.domain,
      signal_type: params.signalType,
      agent_output: params.agentOutput ?? null,
      user_action: params.userAction ?? null,
      delta: params.delta ?? null,
      context: params.context ?? null,
      source_ref: params.sourceRef ?? null,
    });

    if (error) {
      log.error({ err: error.message }, "insert failed");
      return;
    }

    // Check if unprocessed count hit threshold → trigger learning extraction
    const { count } = await supabase
      .from("feedback_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", params.userId)
      .eq("organization_id", params.organizationId)
      .eq("processed", false);

    if (count && count >= LEARNING_THRESHOLD) {
      await workflow.send({
        name: "feedback/extract-learnings",
        data: {
          userId: params.userId,
          organizationId: params.organizationId,
        },
      });
      log.info({ count, userId: params.userId }, "Threshold reached, triggered learning extraction");
    }
  } catch (err) {
    log.error({ err }, "unexpected error");
  }
}
