/**
 * Reminders Scanner + Delivery — Scheduled Inngest Functions
 *
 * Runs every 5 minutes. Finds reminders where trigger_at <= now() and status = 'pending',
 * atomically marks them as 'firing' to prevent double-fire, then fans out delivery events.
 *
 * Delivery: opens Slack DM and sends a message with Dismiss / Snooze buttons.
 */

import { inngest } from "../../client";
import { getSupabaseAdmin } from "../../utils";
import {
  decryptBotToken,
  sendSlackBlockMessage,
} from "../../utils/slack-helpers";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "scan-reminders" });

// ─── Scanner: find due reminders ────────────────────────────────────────────

export const scanDueReminders = inngest.createFunction(
  {
    id: "scan-due-reminders",
    retries: 1,
  },
  { cron: "*/5 * * * *" }, // Every 5 minutes
  async ({ step }) => {
    // Step 1: Atomically claim due reminders (prevents double-fire on overlapping runs)
    const dueReminders = await step.run("claim-due-reminders", async () => {
      const supabase = getSupabaseAdmin();

      // Find pending reminders that are due
      const { data: pending } = await supabase
        .from("reminders")
        .select("id, user_id, organization_id, reminder_text")
        .eq("status", "pending")
        .lte("trigger_at", new Date().toISOString())
        .limit(50);

      if (!pending?.length) return [];

      // Atomically update to 'firing' status
      const ids = pending.map((r) => r.id);
      await supabase
        .from("reminders")
        .update({ status: "firing" })
        .in("id", ids)
        .eq("status", "pending"); // WHERE status = 'pending' prevents races

      return pending;
    });

    if (dueReminders.length === 0) {
      return { processed: 0 };
    }

    // Step 2: Fan out delivery events
    await step.sendEvent(
      "fan-out-reminders",
      dueReminders.map((r) => ({
        name: "reminder/fire" as const,
        data: {
          reminderId: r.id,
          userId: r.user_id,
          organizationId: r.organization_id,
          reminderText: r.reminder_text,
        },
      })),
    );

    return { processed: dueReminders.length };
  },
);

// ─── Per-reminder delivery ──────────────────────────────────────────────────

export const fireReminder = inngest.createFunction(
  {
    id: "fire-reminder",
    retries: 2,
    idempotency: "event.data.reminderId",
  },
  { event: "reminder/fire" },
  async ({ event, step }) => {
    const { reminderId, userId, organizationId, reminderText } = event.data;

    // Step 1: Get Slack mapping
    const slackContext = await step.run("get-slack-context", async () => {
      const supabase = getSupabaseAdmin();

      const { data: mapping } = await supabase
        .from("slack_user_mappings")
        .select("slack_user_id, slack_workspace_id")
        .eq("agent_user_id", userId)
        .eq("organization_id", organizationId)
        .eq("is_active", true)
        .limit(1)
        .maybeSingle();

      if (!mapping) return null;

      const { data: workspace } = await supabase
        .from("slack_workspaces")
        .select("id, bot_token")
        .eq("id", mapping.slack_workspace_id)
        .eq("is_active", true)
        .maybeSingle();

      if (!workspace?.bot_token) return null;

      return {
        slackUserId: mapping.slack_user_id,
        botToken: workspace.bot_token,
      };
    });

    if (!slackContext) {
      // No Slack — mark as sent anyway (user may check in Activity page)
      await step.run("mark-sent-no-slack", async () => {
        const supabase = getSupabaseAdmin();
        await supabase
          .from("reminders")
          .update({ status: "sent" })
          .eq("id", reminderId);
      });
      log.info({ userId, reminderId }, "No Slack for user, reminder marked sent");
      return { status: "sent_no_slack" };
    }

    // Step 2: Decrypt token + open DM
    const botToken = await step.run("decrypt-bot-token", async () => {
      return decryptBotToken(slackContext.botToken);
    });

    const dmChannelId = await step.run("open-dm-channel", async () => {
      const resp = await fetch("https://slack.com/api/conversations.open", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify({ users: slackContext.slackUserId }),
      });
      const data = (await resp.json()) as any;
      if (!data.ok) throw new Error(`conversations.open failed: ${data.error}`);
      return data.channel.id as string;
    });

    // Step 3: Send reminder message with action buttons
    const sendResult = await step.run("send-reminder-message", async () => {
      const blocks = buildReminderBlocks(reminderId, reminderText);
      return sendSlackBlockMessage(
        botToken,
        dmChannelId,
        `Reminder: ${reminderText}`,
        blocks,
      );
    });

    // Step 4: Update status to 'sent'
    await step.run("update-status-sent", async () => {
      const supabase = getSupabaseAdmin();
      await supabase
        .from("reminders")
        .update({
          status: "sent",
          slack_message_ts: sendResult.ts || null,
        })
        .eq("id", reminderId);
    });

    return { status: "sent", reminderId };
  },
);

// ��─ Helpers ──────────────────────────────────────────────────────────────────

function buildReminderBlocks(reminderId: string, reminderText: string): any[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Reminder", emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${reminderText}*` },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Set earlier \u00b7 Powered by Sales Agent`,
        },
      ],
    },
    { type: "divider" },
    {
      type: "actions",
      block_id: "reminder_actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Dismiss", emoji: true },
          action_id: "reminder_dismiss",
          value: reminderId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Snooze 1h", emoji: true },
          action_id: "reminder_snooze_1h",
          value: reminderId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Snooze Tomorrow", emoji: true },
          action_id: "reminder_snooze_tomorrow",
          value: reminderId,
        },
      ],
    },
  ];
}
