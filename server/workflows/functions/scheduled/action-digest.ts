/**
 * Autonomous Action Digest — Scheduled Vercel Workflow Functions
 *
 * Runs every hour. For each user whose local time is 5 PM on a weekday
 * and whose org has autonomous mode enabled, sends a Slack DM summarizing
 * all autonomous actions taken today.
 *
 * Architecture: scan-users cron → fan-out per-user digest events
 *
 * Safeguards:
 * - Only fires when autonomous mode is ON and there were actions today
 * - Zero actions = no message (no noise)
 * - Dedup via digest_log table (same pattern as briefing_log)
 */

import { workflow } from "../../client";
import { getSupabaseAdmin } from "../../utils";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "action-digest" });
import {
  decryptBotToken,
  sendSlackBlockMessage,
} from "../../utils/slack-helpers";
import { getActivitySummary, type ActivitySummary } from "../../utils/activity-summary";
import { isAutonomousModeEnabled } from "../../utils/feature-flags";
import {
  getLocalHour,
  getLocalDayOfWeek,
  getLocalDate,
} from "../../utils/timezone-helpers";

// ─── Scanner: find users due for an action digest ───────────────────────────

export const scanActionDigests = workflow.createFunction(
  {
    id: "scan-action-digests",
    retries: 2,
  },
  { cron: "0 * * * *" }, // Every hour at :00
  async ({ step }) => {
        log.info("Scanning for users due for digest");

    // Step 1: Get all active users with Slack connections
    const eligibleUsers = await step.run("find-eligible-users", async () => {
            const supabase = getSupabaseAdmin();

      const { data: mappings, error } = await supabase
        .from("slack_user_mappings")
        .select("agent_user_id, slack_user_id, slack_workspace_id, organization_id")
        .eq("is_active", true);

      if (error || !mappings?.length) {
        return [];
      }

      const userIds = mappings.map((m) => m.agent_user_id);
      const { data: profiles } = await supabase
        .from("profiles")
        .select("user_id, timezone, first_name")
        .in("user_id", userIds);

      const profileMap = new Map((profiles || []).map((p: any) => [p.user_id, p]));

      // Deduplicate: one mapping per user
      const byUser = new Map<string, typeof mappings[number]>();
      for (const m of mappings) {
        byUser.set(m.agent_user_id, m);
      }

      // Filter: users at 5 PM local on a weekday
      const candidates = Array.from(byUser.values())
        .map((m) => ({
          userId: m.agent_user_id,
          slackUserId: m.slack_user_id,
          slackWorkspaceId: m.slack_workspace_id,
          organizationId: m.organization_id,
          timezone: profileMap.get(m.agent_user_id)?.timezone || "America/New_York",
          firstName: profileMap.get(m.agent_user_id)?.first_name || null,
        }))
        .filter((u) => {
          const localHour = getLocalHour(u.timezone);
          const localDay = getLocalDayOfWeek(u.timezone);
          return localHour === 17 && localDay >= 1 && localDay <= 5; // 5 PM, Mon–Fri
        });

      // Filter: only orgs with autonomous mode enabled
      const orgChecks = new Map<string, boolean>();
      const results: typeof candidates = [];
      for (const c of candidates) {
        if (!orgChecks.has(c.organizationId)) {
          orgChecks.set(c.organizationId, await isAutonomousModeEnabled(c.organizationId));
        }
        if (orgChecks.get(c.organizationId)) {
          results.push(c);
        }
      }

      return results;
    });

    if (eligibleUsers.length === 0) {
      return { processed: 0, message: "No users at 5 PM local with autonomous mode" };
    }

    // Step 2: Dedup — skip users already digested today
    const toDigest = await step.run("deduplicate", async () => {
            const supabase = getSupabaseAdmin();

      const userIds = eligibleUsers.map((u) => u.userId);
      const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const { data: alreadySent } = await supabase
        .from("digest_log")
        .select("user_id, sent_at")
        .in("user_id", userIds)
        .gte("sent_at", cutoff);

      const sentToday = new Set<string>();
      for (const row of alreadySent || []) {
        const user = eligibleUsers.find((u) => u.userId === row.user_id);
        if (!user) continue;
        const localDate = getLocalDate(row.sent_at, user.timezone);
        const todayLocal = getLocalDate(new Date().toISOString(), user.timezone);
        if (localDate === todayLocal) sentToday.add(row.user_id);
      }
      return eligibleUsers.filter((u) => !sentToday.has(u.userId));
    });

    if (toDigest.length === 0) {
      return { processed: 0, message: "All eligible users already digested today" };
    }

    // Step 3: Fan out individual digest events
    await step.sendEvent(
      "fan-out-digests",
      toDigest.map((user) => ({
        name: "digest/send-daily" as const,
        data: {
          userId: user.userId,
          slackUserId: user.slackUserId,
          slackWorkspaceId: user.slackWorkspaceId,
          organizationId: user.organizationId,
          firstName: user.firstName,
        },
      })),
    );

    return { processed: toDigest.length };
  },
);

// ─── Per-user digest sender ─────────────────────────────────────────────────

export const sendActionDigest = workflow.createFunction(
  {
    id: "send-action-digest",
    retries: 2,
  },
  { event: "digest/send-daily" },
  async ({ event, step }) => {
        const { userId, slackUserId, slackWorkspaceId, organizationId, firstName } = event.data;

    // Step 1: Get user timezone and activity summary
    const summary = await step.run("get-activity-summary", async () => {
            const supabase = getSupabaseAdmin();
      const { data: profile } = await supabase
        .from("profiles")
        .select("timezone")
        .eq("user_id", userId)
        .single();

      const tz = profile?.timezone || "America/New_York";
      return getActivitySummary(organizationId, userId, tz);
    });

    // Skip if zero actions today
    if (summary.totalActions === 0) {
      return { status: "skipped", reason: "no_actions_today" };
    }

    // Step 2: Get Slack workspace
    const workspace = await step.run("get-workspace", async () => {
            const supabase = getSupabaseAdmin();
      const { data } = await supabase
        .from("slack_workspaces")
        .select("id, bot_token")
        .eq("id", slackWorkspaceId)
        .eq("is_active", true)
        .single();
      return data;
    });

    if (!workspace?.bot_token) {
      return { status: "skipped", reason: "no_workspace" };
    }

    // Step 3: Decrypt bot token + open DM
    const botToken = await step.run("decrypt-bot-token", async () => {
            return decryptBotToken(workspace.bot_token);
    });

    const dmChannelId = await step.run("open-dm-channel", async () => {
            const resp = await fetch("https://slack.com/api/conversations.open", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify({ users: slackUserId }),
      });
      const data = (await resp.json()) as any;
      if (!data.ok) throw new Error(`conversations.open failed: ${data.error}`);
      return data.channel.id as string;
    });

    // Step 4: Build and send the digest message
    await step.run("send-digest-message", async () => {
            const blocks = buildDigestBlocks(summary as ActivitySummary, firstName);
      await sendSlackBlockMessage(
        botToken,
        dmChannelId,
        `Today's Autonomous Actions — ${summary.totalActions} actions taken`,
        blocks,
      );
    });

    // Step 5: Log to digest_log for dedup
    await step.run("log-digest", async () => {
            const supabase = getSupabaseAdmin();
      await supabase.from("digest_log").insert({
        user_id: userId,
        organization_id: organizationId,
        sent_at: new Date().toISOString(),
        content_summary: {
          emails: summary.autoSentEmails.length,
          deals: summary.nudgedDeals.length,
          meetings: summary.meetingFollowups.length,
          reminders: summary.firedReminders.length,
          total: summary.totalActions,
        },
      });
    });

    return { status: "sent", totalActions: summary.totalActions };
  },
);

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildDigestBlocks(summary: ActivitySummary, firstName: string | null): any[] {
  const greeting = firstName ? `${firstName}, here's` : "Here's";
  const blocks: any[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "Today's Autonomous Actions", emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${greeting} what Sales Agent did on your behalf today.`,
      },
    },
    { type: "divider" },
  ];

  // Emails auto-sent
  if (summary.autoSentEmails.length > 0) {
    const lines = summary.autoSentEmails.map((e) => {
      const conf = e.confidenceScore ? ` (${(e.confidenceScore * 100).toFixed(0)}% confidence)` : "";
      return `\u2022 ${e.subject} \u2192 ${e.recipientEmail}${conf}`;
    });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Emails Auto-Sent (${summary.autoSentEmails.length})*\n${lines.join("\n")}`,
      },
    });
  }

  // Deals nudged
  if (summary.nudgedDeals.length > 0) {
    const lines = summary.nudgedDeals.map((d) => {
      const value = d.dealValue ? ` ($${Number(d.dealValue).toLocaleString()})` : "";
      const contact = d.contactEmail ? ` \u2192 ${d.contactEmail}` : "";
      return `\u2022 ${d.companyName}${value}${contact}`;
    });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Deals Nudged (${summary.nudgedDeals.length})*\n${lines.join("\n")}`,
      },
    });
  }

  // Meetings followed up
  if (summary.meetingFollowups.length > 0) {
    const lines = summary.meetingFollowups.map((m) => {
      return `\u2022 ${m.meetingTitle || "Untitled meeting"}`;
    });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Meetings Followed Up (${summary.meetingFollowups.length})*\n${lines.join("\n")}`,
      },
    });
  }

  // Reminders fired
  if (summary.firedReminders.length > 0) {
    const lines = summary.firedReminders.map((r) => {
      return `\u2022 ${r.reminderText} (${r.status})`;
    });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Reminders Fired (${summary.firedReminders.length})*\n${lines.join("\n")}`,
      },
    });
  }

  // Guardrails usage
  const gu = summary.guardrailsUsage;
  if (gu.maxEmailsPerDay) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Guardrails: ${gu.emailsSentToday}/${gu.maxEmailsPerDay} emails used today`,
        },
      ],
    });
  }

  // Footer
  blocks.push(
    { type: "divider" },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Digest for ${summary.date} \u00b7 Autonomous Mode: ON \u00b7 Powered by Sales Agent`,
        },
      ],
    },
  );

  return blocks;
}
