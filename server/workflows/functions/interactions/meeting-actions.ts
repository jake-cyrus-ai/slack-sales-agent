/**
 * Meeting follow-up Slack action handlers.
 *
 * Handles: meeting_send_drafts, meeting_schedule, meeting_dismiss
 */

import { registerActions, ActionContext, ActionResult } from "../../utils/action-registry";
import { updateSlackMessage } from "../../utils/slack-helpers";
import { trackUsageEvent } from "../../../src/lib/usage-tracking";
import { getSupabaseAdmin, withOrgScope } from "../../utils/supabase";

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
    body: JSON.stringify({ channel, ts, text: "Meeting action completed", blocks }),
  });
}

async function handleMeetingAction(ctx: ActionContext): Promise<ActionResult> {
  const { actionId, actionValue, botToken, channelId, messageTs, userMapping, step } = ctx;

  let parsed: { title: string; attendees: Array<{ name: string; email?: string }> };
  try {
    parsed = JSON.parse(actionValue);
  } catch {
    return { status: "error", reason: "invalid_meeting_action_value" };
  }

  const organizationId = userMapping.organization_id;

  if (actionId === "meeting_send_drafts") {
    await step.run("update-sending-drafts", async () => {
            await updateSlackMessageWithBlocks(botToken, channelId, messageTs, [
        { type: "section", text: { type: "mrkdwn", text: `*${parsed.title}* — Sending drafts for approval... :hourglass_flowing_sand:` } },
      ]);
    });

    await step.sendEvent("trigger-send-drafts", {
      name: "agent/background-task" as const,
      data: {
        userId: userMapping.agent_user_id,
        organizationId,
        botToken,
        message: `Send the email drafts I prepared for the meeting "${parsed.title}". Use gmail_send for each draft so I can approve them.`,
        domainSignals: { sales: 5 },
        context: { channelId, threadTs: messageTs },
      },
    });

    if (organizationId) {
      trackUsageEvent({ orgId: organizationId, userId: userMapping.agent_user_id, eventType: "task", eventName: "meeting_send_drafts" });
    }

    return { status: "send_drafts_triggered" };
  }

  if (actionId === "meeting_schedule") {
    await step.run("update-scheduling", async () => {
            await updateSlackMessageWithBlocks(botToken, channelId, messageTs, [
        { type: "section", text: { type: "mrkdwn", text: `*${parsed.title}* — Scheduling follow-up... :hourglass_flowing_sand:` } },
      ]);
    });

    const attendeeNames = parsed.attendees.map((a) => a.email || a.name).join(", ");

    await step.sendEvent("trigger-schedule", {
      name: "agent/background-task" as const,
      data: {
        userId: userMapping.agent_user_id,
        organizationId,
        botToken,
        message: `Schedule a 30-minute follow-up meeting with ${attendeeNames} for next week regarding "${parsed.title}".`,
        domainSignals: { sales: 3 },
        context: { channelId, threadTs: messageTs },
      },
    });

    if (organizationId) {
      trackUsageEvent({ orgId: organizationId, userId: userMapping.agent_user_id, eventType: "task", eventName: "meeting_schedule" });
    }

    return { status: "schedule_triggered" };
  }

  if (actionId === "meeting_update_crm") {
    let crmParsed: { dealId: string; title: string };
    try {
      crmParsed = JSON.parse(actionValue);
    } catch {
      return { status: "error", reason: "invalid_crm_action_value" };
    }

    await step.run("update-crm-notes-manual", async () => {
            const supabase = getSupabaseAdmin();
      const meetingNote = `\n\n---\nMeeting notes updated via Slack action for "${crmParsed.title}"`;

      const { data: deal } = await withOrgScope(
        supabase.from("deals").select("notes").eq("id", crmParsed.dealId),
        organizationId
      ).single();

      const existing = deal?.notes || "";
      await withOrgScope(
        supabase.from("deals").update({
          notes: existing + meetingNote,
          last_activity: new Date().toISOString().split("T")[0],
        }).eq("id", crmParsed.dealId),
        organizationId
      );

      await updateSlackMessageWithBlocks(botToken, channelId, messageTs, [
        { type: "section", text: { type: "mrkdwn", text: `CRM notes updated for "${crmParsed.title}" :white_check_mark:` } },
      ]);
    });

    if (organizationId) {
      trackUsageEvent({ orgId: organizationId, userId: userMapping.agent_user_id, eventType: "task", eventName: "meeting_update_crm" });
    }

    return { status: "crm_updated" };
  }

  if (actionId === "meeting_dismiss") {
    await step.run("dismiss-meeting-followup", async () => {
            await updateSlackMessageWithBlocks(botToken, channelId, messageTs, [
        { type: "section", text: { type: "mrkdwn", text: `*${parsed.title}* — Dismissed.` } },
      ]);
    });

    return { status: "dismissed" };
  }

  return { status: "unknown_meeting_action", actionId };
}

// Register on import
registerActions("meeting_", handleMeetingAction);
