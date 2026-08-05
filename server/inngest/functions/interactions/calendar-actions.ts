/**
 * Calendar Slack action handlers.
 *
 * Handles: calendar_delete_confirm, calendar_delete_cancel
 *
 * These actions are triggered when a user clicks the Approve/Cancel buttons
 * on a calendar delete confirmation message posted by the calendar_delete tool.
 */

import { registerActions, ActionContext, ActionResult } from "../../utils/action-registry";
import { getSupabaseAdmin } from "../../utils/supabase";
import { trackUsageEvent } from "../../../src/lib/usage-tracking";
import { getGoogleTokens } from "../../utils/google/auth-helper";
import { googleApiFetch } from "../../../src/services/token-manager.js";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "calendar-actions" });

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
    body: JSON.stringify({ channel, ts, text: "Calendar action completed", blocks }),
  });
}

async function handleCalendarAction(ctx: ActionContext): Promise<ActionResult> {
  const { actionId, actionValue: pendingActionId, botToken, channelId, messageTs, slackUserId, userMapping, step } = ctx;

  const supabase = getSupabaseAdmin();

  // Fetch the pending action
  const pendingAction = await step.run("get-pending-action", async () => {
    const { data, error } = await supabase
      .from("pending_actions")
      .select("*")
      .eq("id", pendingActionId)
      .maybeSingle();

    if (error || !data) {
      log.error({ pendingActionId, err: error }, "Pending action not found");
      return null;
    }
    return data;
  });

  if (!pendingAction) {
    await updateSlackMessageWithBlocks(botToken, channelId, messageTs, [
      { type: "section", text: { type: "mrkdwn", text: "This action has expired or was already processed." } },
    ]);
    return { status: "not_found" };
  }

  if (pendingAction.status !== "pending") {
    await updateSlackMessageWithBlocks(botToken, channelId, messageTs, [
      { type: "section", text: { type: "mrkdwn", text: `This action was already ${pendingAction.status}.` } },
    ]);
    return { status: "already_processed" };
  }

  const payload = pendingAction.payload as {
    eventId: string;
    summary: string;
    start: string;
    end: string;
    attendees?: string[];
    organizer?: string;
  };

  // Handle cancel
  if (actionId === "calendar_delete_cancel") {
    await step.run("mark-rejected", async () => {
      await supabase
        .from("pending_actions")
        .update({
          status: "rejected",
          resolved_at: new Date().toISOString(),
          resolved_by: slackUserId,
        })
        .eq("id", pendingActionId);
    });

    await step.run("update-slack-cancelled", async () => {
      await updateSlackMessageWithBlocks(botToken, channelId, messageTs, [
        {
          type: "section",
          text: { type: "mrkdwn", text: `*Cancelled* — "${payload.summary}" was not deleted.` },
        },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `Cancelled by <@${slackUserId}>` }],
        },
      ]);
    });

    return { status: "cancelled", eventId: payload.eventId };
  }

  // Handle confirm — actually delete the event
  if (actionId === "calendar_delete_confirm") {
    const deleteResult = await step.run("delete-calendar-event", async () => {
      const supabaseAdmin = getSupabaseAdmin();
      const tokens = await getGoogleTokens(supabaseAdmin, pendingAction.user_id);
      if (!tokens) {
        return { success: false, error: "Google Calendar not connected." };
      }

      try {
        const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(payload.eventId)}?sendUpdates=all`;
        const res = await fetch(url, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
          },
        });

        if (res.status === 204 || res.status === 200) {
          return { success: true };
        }

        if (res.status === 404) {
          return { success: false, error: "Event was already deleted." };
        }

        const errorText = await res.text();
        return { success: false, error: `Calendar API error ${res.status}: ${errorText}` };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    // Mark action as approved regardless of API result
    await step.run("mark-approved", async () => {
      await supabase
        .from("pending_actions")
        .update({
          status: deleteResult.success ? "approved" : "rejected",
          resolved_at: new Date().toISOString(),
          resolved_by: slackUserId,
        })
        .eq("id", pendingActionId);
    });

    // Update Slack message
    await step.run("update-slack-result", async () => {
      if (deleteResult.success) {
        await updateSlackMessageWithBlocks(botToken, channelId, messageTs, [
          {
            type: "section",
            text: { type: "mrkdwn", text: `*Deleted* — "${payload.summary}" has been removed from your calendar.` },
          },
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: `Deleted by <@${slackUserId}>` }],
          },
        ]);
      } else {
        await updateSlackMessageWithBlocks(botToken, channelId, messageTs, [
          {
            type: "section",
            text: { type: "mrkdwn", text: `*Failed to delete* — ${deleteResult.error}` },
          },
        ]);
      }
    });

    // Track usage
    trackUsageEvent({
      orgId: userMapping.organization_id,
      userId: userMapping.agent_user_id,
      eventType: "task",
      eventName: "calendar_delete",
    });

    return { status: deleteResult.success ? "deleted" : "failed", eventId: payload.eventId };
  }

  return { status: "unknown_action" };
}

registerActions("calendar_delete_", handleCalendarAction);
