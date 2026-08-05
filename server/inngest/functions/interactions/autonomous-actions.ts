/**
 * Autonomous workflow Slack action handlers.
 *
 * Handles: confirm_auto_send, cancel_auto_send,
 *          confirm_auto_followup, cancel_auto_followup
 */

import { registerActions, ActionContext, ActionResult } from "../../utils/action-registry";
import { getSupabaseAdmin } from "../../utils/supabase";
import { writeFeedbackEvent } from "../../utils/feedback-capture";
import { trackUsageEvent } from "../../../src/lib/usage-tracking";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "autonomous-actions" });

async function updateSlackMessageWithBlocks(
  botToken: string,
  channel: string,
  ts: string,
  blocks: any[],
): Promise<void> {
  const resp = await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel, ts, text: "Autonomous action completed", blocks }),
  });
  const data = await resp.json() as any;
  if (!data.ok) {
    log.error({ error: data.error }, "Slack chat.update failed");
  }
}

// ── Auto-send confirmation (email response agent + approval fast-path) ──

async function handleAutoSendAction(ctx: ActionContext): Promise<ActionResult> {
  const { actionId, actionValue: draftId, botToken, channelId, messageTs, slackUserId, step } = ctx;

  const confirmAction = actionId === "confirm_auto_send" ? "confirm" : "cancel";

  // Send the confirmation event to unblock the waiting workflow
  await step.sendEvent("send-auto-send-confirmation", {
    name: "email/auto-send-confirmation" as const,
    data: {
      draftId,
      action: confirmAction,
      slackUserId,
    },
  });

  // Update the Slack message to reflect the action
  const statusText = confirmAction === "confirm"
    ? "Sending email now..."
    : "Auto-send cancelled. Falling back to manual approval.";

  await step.run("update-auto-send-message", async () => {
    await updateSlackMessageWithBlocks(botToken, channelId, messageTs, [
      {
        type: "section",
        text: { type: "mrkdwn", text: statusText },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Action by <@${slackUserId}>` }],
      },
    ]);
  });

  return { status: confirmAction, type: "auto_send_email", draftId };
}

// Register both confirm and cancel prefixes
registerActions("confirm_auto_send", handleAutoSendAction);
registerActions("cancel_auto_send", handleAutoSendAction);

// ── Auto-followup confirmation (stalled deal nudge) ──

async function handleAutoFollowupAction(ctx: ActionContext): Promise<ActionResult> {
  const { actionId, actionValue, botToken, channelId, messageTs, slackUserId, step } = ctx;

  let parsed: { dealId: string; userId: string; organizationId: string };
  try {
    parsed = JSON.parse(actionValue);
  } catch {
    return { status: "error", reason: "invalid_followup_action_value" };
  }

  const confirmAction = actionId === "confirm_auto_followup" ? "confirm" : "cancel";

  await step.sendEvent("send-auto-followup-confirmation", {
    name: "deal/auto-followup-confirmation" as const,
    data: {
      dealId: parsed.dealId,
      action: confirmAction,
      slackUserId,
    },
  });

  const statusText = confirmAction === "confirm"
    ? "Sending follow-up email now..."
    : "Follow-up cancelled.";

  await step.run("update-auto-followup-message", async () => {
    await updateSlackMessageWithBlocks(botToken, channelId, messageTs, [
      {
        type: "section",
        text: { type: "mrkdwn", text: statusText },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Action by <@${slackUserId}>` }],
      },
    ]);
  });

  return { status: confirmAction, type: "auto_followup", dealId: parsed.dealId };
}

registerActions("confirm_auto_followup", handleAutoFollowupAction);
registerActions("cancel_auto_followup", handleAutoFollowupAction);

// ── Flag auto-sent email (user reports an issue with auto-sent response) ──

async function handleFlagAutoSent(ctx: ActionContext): Promise<ActionResult> {
  const { actionValue: draftId, botToken, channelId, messageTs, slackUserId, userMapping, step } = ctx;

  const draft = await step.run("load-flagged-draft", async () => {
    const supabase = getSupabaseAdmin();
    const { data } = await supabase
      .from("email_auto_response_drafts")
      .select("subject, body, to_email, classification, confidence_score, user_id, organization_id")
      .eq("id", draftId)
      .maybeSingle();
    return data;
  });

  if (!draft) {
    return { status: "error", reason: "draft_not_found" };
  }

  const orgId = userMapping?.organization_id || draft.organization_id;
  const userId = userMapping?.agent_user_id || draft.user_id;

  // Record the flag as a feedback event
  if (orgId) {
    writeFeedbackEvent({
      userId,
      organizationId: orgId,
      domain: "email_draft",
      signalType: "flag",
      agentOutput: { subject: draft.subject, body: (draft.body || "").slice(0, 1500), to: draft.to_email },
      context: { classification: draft.classification, confidence: draft.confidence_score, recipient: draft.to_email },
      sourceRef: { table: "email_auto_response_drafts", id: draftId },
    });
    trackUsageEvent({ orgId, userId, eventType: "task", eventName: "email_flag_issue" });
  }

  await step.run("update-slack-flagged", async () => {
    await updateSlackMessageWithBlocks(botToken, channelId, messageTs, [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Issue flagged* for auto-sent email to ${draft.to_email}\n_The team will review this response._`,
        },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Flagged by <@${slackUserId}>` }],
      },
    ]);
  });

  return { status: "flagged", draftId };
}

registerActions("flag_auto_sent_email", handleFlagAutoSent);

// ── View auto-sent email (show full response in thread) ──

async function handleViewAutoSent(ctx: ActionContext): Promise<ActionResult> {
  const { actionValue: draftId, botToken, channelId, messageTs, userMapping, step } = ctx;

  const draft = await step.run("load-view-draft", async () => {
    const supabase = getSupabaseAdmin();
    const { data } = await supabase
      .from("email_auto_response_drafts")
      .select("subject, body, to_email, user_id")
      .eq("id", draftId)
      .maybeSingle();
    return data;
  });

  if (!draft) {
    return { status: "error", reason: "draft_not_found" };
  }

  // Verify the requesting user owns this draft
  if (userMapping?.agent_user_id && draft.user_id && draft.user_id !== userMapping.agent_user_id) {
    return { status: "error", reason: "unauthorized" };
  }

  await step.run("post-full-response", async () => {
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({
        channel: channelId,
        text: `*Full Auto-Sent Email:*\n\n*To:* ${draft.to_email}\n*Subject:* ${draft.subject}\n\n\`\`\`${draft.body}\`\`\``,
        thread_ts: messageTs,
      }),
    });
  });

  return { status: "shown", draftId };
}

registerActions("view_auto_sent_email", handleViewAutoSent);
