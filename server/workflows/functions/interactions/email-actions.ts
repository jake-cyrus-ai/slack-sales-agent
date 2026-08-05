/**
 * Email approval Slack action handlers.
 *
 * Handles: email_approve, email_reject, email_show_full,
 *          view_auto_sent_email, flag_auto_sent_email
 */

import { registerActions, ActionContext, ActionResult } from "../../utils/action-registry";
import { getSupabaseAdmin, withOrgScope } from "../../utils/supabase";
import { trackUsageEvent } from "../../../src/lib/usage-tracking";
import { writeFeedbackEvent } from "../../utils/feedback-capture";
import { sendEmail } from "../email/send-email";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "email-actions" });

async function updateSlackMessageWithBlocks(
  botToken: string,
  channel: string,
  ts: string,
  blocks: any[],
): Promise<void> {
  await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel, ts, text: "Email action completed", blocks }),
  });
}

async function sendSlackMessage(
  botToken: string,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<void> {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel, text, thread_ts: threadTs }),
  });
}

async function updateSlackMessage(
  botToken: string,
  channel: string,
  ts: string,
  text: string,
): Promise<void> {
  await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel, ts, text }),
  });
}

async function handleEmailAction(ctx: ActionContext): Promise<ActionResult> {
  const { actionId, actionValue: draftId, botToken, channelId, messageTs, slackUserId, userMapping, step } = ctx;
  const organizationId = userMapping.organization_id;

  // Get the draft
  const draft = await step.run("get-draft", async () => {
          const supabase = getSupabaseAdmin();
    const { data, error } = await withOrgScope(
      supabase.from("email_auto_response_drafts").select("*").eq("id", draftId),
      organizationId
    ).maybeSingle();

    if (error || !data) {
      log.error({ draftId }, "Draft not found");
      return null;
    }
    return data;
  });

  if (!draft) {
    await updateSlackMessage(botToken, channelId, messageTs, "Draft not found. It may have been processed already.");
    return { status: "error", reason: "draft_not_found" };
  }

  if (draft.status !== "pending") {
    await updateSlackMessage(botToken, channelId, messageTs, `This draft has already been ${draft.status}.`);
    return { status: "skipped", reason: "already_processed" };
  }

  if (actionId === "email_approve") {
    await step.sendEvent("send-approval", {
      name: "email/approval-response",
      data: { draftId, action: "approve", slackUserId },
    });

    // Agent-tool-created drafts have no incoming_email_id — send directly
    if (!draft.incoming_email_id) {
      await step.invoke("send-agent-email", {
        function: sendEmail,
        data: {
          to: draft.to_email,
          subject: draft.subject,
          body: draft.body,
          userId: draft.user_id,
        },
      });

      await step.run("mark-agent-draft-sent", async () => {
              const supabase = getSupabaseAdmin();
        await withOrgScope(
          supabase
            .from("email_auto_response_drafts")
            .update({ status: "sent", sent_at: new Date().toISOString() })
            .eq("id", draftId),
          organizationId
        );
      });
    }

    await step.run("update-slack-approved", async () => {
            await updateSlackMessageWithBlocks(botToken, channelId, messageTs, [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Email approved and sent!*\n\n*To:* ${draft.to_email}\n*Subject:* ${draft.subject}`,
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Sent by <@${slackUserId}> at <!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} {time}|${new Date().toISOString()}>`,
            },
          ],
        },
      ]);
    });

    if (userMapping.organization_id) {
      trackUsageEvent({ orgId: userMapping.organization_id, userId: userMapping.agent_user_id, eventType: "task", eventName: "email_approve" });
      writeFeedbackEvent({
        userId: userMapping.agent_user_id,
        organizationId: userMapping.organization_id,
        domain: "email_draft",
        signalType: "approval",
        agentOutput: { subject: draft.subject, body: (draft.body || "").slice(0, 1500), to: draft.to_email },
        context: { classification: draft.classification, confidence: draft.confidence_score, recipient: draft.to_email },
        sourceRef: { table: "email_auto_response_drafts", id: draftId },
      });
    }

    return { status: "approved", draftId };
  }

  if (actionId === "email_reject") {
    await step.sendEvent("send-rejection", {
      name: "email/approval-response",
      data: { draftId, action: "reject", slackUserId },
    });

    await step.run("update-slack-rejected", async () => {
            await updateSlackMessageWithBlocks(botToken, channelId, messageTs, [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Email cancelled*\n\n*To:* ${draft.to_email}\n*Subject:* ${draft.subject}\n\n_Draft discarded._`,
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Cancelled by <@${slackUserId}> at <!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} {time}|${new Date().toISOString()}>`,
            },
          ],
        },
      ]);
    });

    if (userMapping.organization_id) {
      trackUsageEvent({ orgId: userMapping.organization_id, userId: userMapping.agent_user_id, eventType: "task", eventName: "email_reject" });
      writeFeedbackEvent({
        userId: userMapping.agent_user_id,
        organizationId: userMapping.organization_id,
        domain: "email_draft",
        signalType: "rejection",
        agentOutput: { subject: draft.subject, body: (draft.body || "").slice(0, 1500), to: draft.to_email },
        context: { classification: draft.classification, confidence: draft.confidence_score, recipient: draft.to_email },
        sourceRef: { table: "email_auto_response_drafts", id: draftId },
      });
    }

    return { status: "rejected", draftId };
  }

  if (actionId === "email_show_full") {
    await step.run("show-full-draft", async () => {
            await sendSlackMessage(
        botToken,
        channelId,
        `*Full Email Draft:*\n\n*To:* ${draft.to_email}\n*Subject:* ${draft.subject}\n\n\`\`\`${draft.body}\`\`\``,
        messageTs,
      );
    });

    if (userMapping.organization_id) {
      trackUsageEvent({ orgId: userMapping.organization_id, userId: userMapping.agent_user_id, eventType: "task", eventName: "email_show_full" });
    }

    return { status: "shown_full", draftId };
  }

  if (actionId === "edit_email") {
    const { triggerId } = ctx;
    if (!triggerId) {
      return { status: "error", reason: "no_trigger_id" };
    }

    await step.run("open-edit-modal", async () => {
            await fetch("https://slack.com/api/views.open", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify({
          trigger_id: triggerId,
          view: {
            type: "modal",
            callback_id: "edit_email_modal",
            private_metadata: JSON.stringify({ draftId, channelId, messageTs, botToken }),
            title: { type: "plain_text", text: "Edit Email Draft" },
            submit: { type: "plain_text", text: "Save Changes" },
            close: { type: "plain_text", text: "Cancel" },
            blocks: [
              {
                type: "input",
                block_id: "subject_block",
                label: { type: "plain_text", text: "Subject" },
                element: {
                  type: "plain_text_input",
                  action_id: "subject_input",
                  initial_value: draft.subject || "",
                },
              },
              {
                type: "input",
                block_id: "body_block",
                label: { type: "plain_text", text: "Email Body" },
                element: {
                  type: "plain_text_input",
                  action_id: "body_input",
                  multiline: true,
                  initial_value: draft.body || "",
                },
              },
            ],
          },
        }),
      });
    });

    return { status: "edit_modal_opened", draftId };
  }

  return { status: "unknown_email_action", actionId };
}

// =============================================================================
// Autonomous email post-send action handlers
// =============================================================================

async function handleAutoSentEmailAction(ctx: ActionContext): Promise<ActionResult> {
  const { actionId, actionValue, botToken, channelId, messageTs, slackUserId, userMapping, step } = ctx;

  // actionValue is JSON with draftId
  let draftId: string;
  try {
    const parsed = JSON.parse(actionValue);
    draftId = parsed.draftId || parsed;
  } catch {
    // Fall back to raw value (for simple string values)
    draftId = actionValue;
  }

  // Get the auto-sent draft
  const draft = await step.run("get-auto-sent-draft", async () => {
          const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("email_auto_response_drafts")
      .select("*")
      .eq("id", draftId)
      .maybeSingle();

    if (error || !data) {
      log.error({ draftId }, "Auto-sent draft not found");
      return null;
    }
    return data;
  });

  if (!draft) {
    await updateSlackMessage(botToken, channelId, messageTs, "Draft not found.");
    return { status: "error", reason: "draft_not_found" };
  }

  if (actionId === "view_auto_sent_email") {
    await step.run("show-auto-sent-full", async () => {
            const reasoning = draft.agent_reasoning
        ? `\n\n*Agent Reasoning:* ${draft.agent_reasoning}`
        : "";
      const confidence = draft.confidence_score
        ? `\n*Confidence:* ${Math.round(draft.confidence_score * 100)}%`
        : "";

      await sendSlackMessage(
        botToken,
        channelId,
        `*Full Auto-Sent Email:*\n\n*To:* ${draft.to_email}\n*Subject:* ${draft.subject}${confidence}${reasoning}\n\n\`\`\`${draft.body}\`\`\``,
        messageTs,
      );
    });

    if (userMapping.organization_id) {
      trackUsageEvent({ orgId: userMapping.organization_id, userId: userMapping.agent_user_id, eventType: "task", eventName: "view_auto_sent_email" });
    }

    return { status: "shown_auto_sent", draftId };
  }

  if (actionId === "flag_auto_sent_email") {
    await step.run("flag-auto-sent-email", async () => {
            const supabase = getSupabaseAdmin();
      await supabase
        .from("email_auto_response_drafts")
        .update({
          status: "flagged",
          flagged_at: new Date().toISOString(),
        })
        .eq("id", draftId);
    });

    await step.run("update-slack-flagged", async () => {
            await updateSlackMessageWithBlocks(botToken, channelId, messageTs, [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Auto-Reply Flagged*\n\nThe auto-reply to *${draft.to_email}* has been flagged for review.\n*Subject:* ${draft.subject}`,
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Flagged by <@${slackUserId}> at <!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} {time}|${new Date().toISOString()}>`,
            },
          ],
        },
      ]);
    });

    if (userMapping.organization_id) {
      trackUsageEvent({ orgId: userMapping.organization_id, userId: userMapping.agent_user_id, eventType: "task", eventName: "flag_auto_sent_email" });
    }

    return { status: "flagged", draftId };
  }

  return { status: "unknown_auto_email_action", actionId };
}

// Register on import
registerActions("email_", handleEmailAction);
registerActions("view_auto_sent_email", handleAutoSentEmailAction);
registerActions("flag_auto_sent_email", handleAutoSentEmailAction);
