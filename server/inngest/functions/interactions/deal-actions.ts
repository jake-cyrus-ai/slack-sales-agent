/**
 * Deal nudge Slack action handlers.
 *
 * Handles: deal_send_followup, deal_snooze_3d, deal_mark_lost, deal_dismiss
 */

import { registerActions, ActionContext, ActionResult } from "../../utils/action-registry";
import { getSupabaseAdmin, withOrgScope } from "../../utils/supabase";
import { trackUsageEvent } from "../../../src/lib/usage-tracking";
import { startWorkflowRun } from "../../../src/lib/workflow-tracking";

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
    body: JSON.stringify({ channel, ts, text: "Deal action completed", blocks }),
  });
}

async function handleDealAction(ctx: ActionContext): Promise<ActionResult> {
  const { actionId, actionValue, botToken, channelId, messageTs, slackUserId, userMapping, step } = ctx;

  let parsed: { dealId: string; userId: string; organizationId: string };
  try {
    parsed = JSON.parse(actionValue);
  } catch {
    return { status: "error", reason: "invalid_deal_action_value" };
  }

  const { dealId, organizationId } = parsed;

  // Authorization: verify the clicking user owns this deal
  if (parsed.userId !== userMapping.agent_user_id) {
    await updateSlackMessageWithBlocks(botToken, channelId, messageTs, [
      { type: "section", text: { type: "mrkdwn", text: "You don't have permission to act on this deal." } },
    ]);
    return { status: "error", reason: "unauthorized" };
  }

  // Verify deal still exists and is Active
  const dealData = await step.run("check-deal-status", async () => {
    const supabase = getSupabaseAdmin();
    const { data, error } = await withOrgScope(
      supabase.from("deals").select("id, status, company_name, contact_name, stage, value").eq("id", dealId),
      organizationId
    ).single();
    if (error || !data) return null;
    return data;
  });

  if (!dealData || dealData.status !== "Active") {
    await updateSlackMessageWithBlocks(botToken, channelId, messageTs, [
      { type: "section", text: { type: "mrkdwn", text: "This deal is no longer active." } },
    ]);
    return { status: "skipped", reason: "deal_not_active" };
  }

  if (actionId === "deal_send_followup") {
    await step.run("update-generating", async () => {
      await updateSlackMessageWithBlocks(botToken, channelId, messageTs, [
        { type: "section", text: { type: "mrkdwn", text: `*${dealData.company_name}* — Generating follow-up email... :hourglass_flowing_sand:` } },
      ]);
    });

    await step.sendEvent("trigger-followup-email", {
      name: "agent/background-task" as const,
      data: {
        userId: userMapping.agent_user_id,
        organizationId,
        botToken,
        message: `Draft a follow-up email for the deal with ${dealData.company_name}. Contact: ${dealData.contact_name || "primary contact"}. The deal is in ${dealData.stage || "the current"} stage, valued at ${dealData.value ? `$${Number(dealData.value).toLocaleString()}` : "an undisclosed amount"}. The deal has stalled — write a professional re-engagement email to move things forward.`,
        domainSignals: { sales: 5 },
        context: { channelId, threadTs: messageTs },
      },
    });

    await step.run("update-followup-sent", async () => {
      await updateSlackMessageWithBlocks(botToken, channelId, messageTs, [
        {
          type: "section",
          text: { type: "mrkdwn", text: `*${dealData.company_name}* — Follow-up email is being drafted. Check this channel for the approval card.` },
        },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `Requested by <@${slackUserId}>` }],
        },
      ]);
    });

    if (userMapping.organization_id) {
      await trackUsageEvent({ orgId: userMapping.organization_id, userId: userMapping.agent_user_id, eventType: "task", eventName: "deal_send_followup" });
    }

    return { status: "followup_triggered", dealId };
  }

  if (actionId === "deal_snooze_3d") {
    await step.run("snooze-deal", async () => {
      await startWorkflowRun({
        orgId: organizationId,
        userId: userMapping.agent_user_id,
        dealId,
        workflowKind: "deal_followup",
        metadata: { snoozed: true, snoozedBy: slackUserId },
      });
    });

    await step.run("update-snoozed", async () => {
      await updateSlackMessageWithBlocks(botToken, channelId, messageTs, [
        {
          type: "section",
          text: { type: "mrkdwn", text: `*${dealData.company_name}* — Snoozed for 3 days. You'll be reminded again after that.` },
        },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `Snoozed by <@${slackUserId}>` }],
        },
      ]);
    });

    if (userMapping.organization_id) {
      await trackUsageEvent({ orgId: userMapping.organization_id, userId: userMapping.agent_user_id, eventType: "task", eventName: "deal_snooze" });
    }

    return { status: "snoozed", dealId };
  }

  if (actionId === "deal_mark_lost") {
    await step.run("mark-deal-lost", async () => {
      const supabase = getSupabaseAdmin();
      await withOrgScope(
        supabase.from("deals").update({ status: "Lost", updated_at: new Date().toISOString() }).eq("id", dealId),
        organizationId
      );
    });

    await step.run("update-marked-lost", async () => {
      await updateSlackMessageWithBlocks(botToken, channelId, messageTs, [
        {
          type: "section",
          text: { type: "mrkdwn", text: `*${dealData.company_name}* — Deal marked as Lost.` },
        },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `Marked by <@${slackUserId}>` }],
        },
      ]);
    });

    if (userMapping.organization_id) {
      await trackUsageEvent({ orgId: userMapping.organization_id, userId: userMapping.agent_user_id, eventType: "task", eventName: "deal_mark_lost" });
    }

    return { status: "marked_lost", dealId };
  }

  if (actionId === "deal_dismiss") {
    await step.run("update-dismissed", async () => {
      await updateSlackMessageWithBlocks(botToken, channelId, messageTs, [
        {
          type: "section",
          text: { type: "mrkdwn", text: `*${dealData.company_name}* — Dismissed.` },
        },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `Dismissed by <@${slackUserId}>` }],
        },
      ]);
    });

    return { status: "dismissed", dealId };
  }

  return { status: "unknown_deal_action", actionId };
}

// Register on import
registerActions("deal_", handleDealAction);

/**
 * Legacy export for backward compatibility with existing tests.
 * Maps the old {userId} interface to the new {slackUserId} ActionContext.
 */
export async function handleDealNudgeAction(args: {
  actionId: string;
  actionValue: string;
  botToken: string;
  channelId: string;
  messageTs: string;
  userId: string;
  userMapping: { agent_user_id: string; organization_id: string };
  step: any;
}): Promise<ActionResult> {
  return handleDealAction({
    actionId: args.actionId,
    actionValue: args.actionValue,
    botToken: args.botToken,
    channelId: args.channelId,
    messageTs: args.messageTs,
    slackUserId: args.userId,
    userMapping: args.userMapping,
    step: args.step,
  });
}
