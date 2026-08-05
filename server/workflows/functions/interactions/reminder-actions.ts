/**
 * Reminder Slack action handlers.
 *
 * Handles: reminder_dismiss, reminder_snooze_1h, reminder_snooze_tomorrow
 *
 * Registered via action-registry prefix "reminder_".
 */

import { registerActions, ActionContext, ActionResult } from "../../utils/action-registry";
import { getSupabaseAdmin } from "../../utils/supabase";
import { getLocalMidnight } from "../../utils/timezone-helpers";

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
    body: JSON.stringify({
      channel,
      ts,
      text,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text },
        },
      ],
    }),
  });
}

async function handleReminderAction(ctx: ActionContext): Promise<ActionResult> {
  const { actionId, actionValue: reminderId, botToken, channelId, messageTs, userMapping } = ctx;

  const supabase = getSupabaseAdmin();

  if (actionId === "reminder_dismiss") {
    await supabase
      .from("reminders")
      .update({ status: "dismissed" })
      .eq("id", reminderId);

    await updateSlackMessage(botToken, channelId, messageTs, "~Reminder dismissed.~");

    return { status: "ok", ok: true };
  }

  if (actionId === "reminder_snooze_1h") {
    const newTrigger = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await supabase
      .from("reminders")
      .update({
        status: "pending",
        trigger_at: newTrigger,
        snoozed_until: newTrigger,
      })
      .eq("id", reminderId);

    const timeStr = new Date(newTrigger).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    await updateSlackMessage(botToken, channelId, messageTs, `Snoozed for 1 hour. Will remind again at ~${timeStr}.`);

    return { status: "ok", ok: true };
  }

  if (actionId === "reminder_snooze_tomorrow") {
    // Get user's timezone to set tomorrow 9 AM local
    const userId = userMapping?.agent_user_id;
    let tz = "America/New_York";

    if (userId) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("timezone")
        .eq("user_id", userId)
        .single();
      tz = profile?.timezone || tz;
    }

    // Tomorrow 9 AM local time
    const tomorrowMidnight = getLocalMidnight(tz, 1);
    const tomorrow9am = new Date(tomorrowMidnight.getTime() + 9 * 60 * 60 * 1000);
    const newTrigger = tomorrow9am.toISOString();

    await supabase
      .from("reminders")
      .update({
        status: "pending",
        trigger_at: newTrigger,
        snoozed_until: newTrigger,
      })
      .eq("id", reminderId);

    await updateSlackMessage(botToken, channelId, messageTs, "Snoozed until tomorrow at 9 AM.");

    return { status: "ok", ok: true };
  }

  return { status: "error", ok: false, error: `Unknown reminder action: ${actionId}` };
}

// Register all reminder_ prefixed actions
registerActions("reminder_", handleReminderAction);
