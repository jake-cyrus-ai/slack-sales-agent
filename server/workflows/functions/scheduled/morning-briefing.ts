/**
 * Morning Daily Briefing — Scheduled Vercel Workflow Functions
 *
 * Runs every hour. For each user whose local time is ~8 AM, sends a
 * Slack DM with their daily briefing:
 *   - Today's meetings (with external attendee highlights)
 *   - Deals needing attention (stalled, low health, milestone due)
 *   - Pending email drafts awaiting approval
 *   - Key activity summary
 *
 * Architecture: scan-users cron → fan-out per-user briefing events
 *
 * Safeguards:
 * - Timezone-aware: only briefs users at ~8 AM local time
 * - Dedup: checks briefing_log to avoid double-sends same day
 * - Graceful: skips users without Slack or calendar
 */

import { workflow } from "../../client";
import { getSupabaseAdmin, getSupabaseForUser } from "../../utils";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "morning-briefing" });
import {
  decryptBotToken,
  sendSlackBlockMessage,
} from "../../utils/slack-helpers";
import { generateClaudeMessage } from "../../utils/llm/clients";
import { trackUsageEvent } from "../../../src/lib/usage-tracking";
import { getGoogleTokens, googleApiFetch } from "../../../src/services/token-manager";
import { isSalesforceConfigured, getSalesforceConnection } from "../../../src/salesforce/client";
import {
  getLocalDate,
  getLocalMidnight,
  getLocalHour,
  getLocalDayOfWeek,
} from "../../utils/timezone-helpers";

// ─── Scanner: find users due for a morning briefing ──────────────────────────

export const scanMorningBriefings = workflow.createFunction(
  {
    id: "scan-morning-briefings",
    retries: 2,
  },
  { cron: "0 * * * *" }, // Every hour at :00
  async ({ step }) => {
        log.info("Scanning for users due for briefing");

    // Step 1: Get all active users with Slack connections
    const eligibleUsers = await step.run("find-eligible-users", async () => {
            const supabase = getSupabaseAdmin();

      const { data: mappings, error } = await supabase
        .from("slack_user_mappings")
        .select("agent_user_id, slack_user_id, slack_workspace_id, organization_id")
        .eq("is_active", true);

      if (error || !mappings?.length) {
        log.info("No active Slack users found");
        return [];
      }

      // Get profiles with timezones
      const userIds = mappings.map((m) => m.agent_user_id);
      const { data: profiles } = await supabase
        .from("profiles")
        .select("user_id, timezone, first_name")
        .in("user_id", userIds);

      const profileMap = new Map((profiles || []).map((p: any) => [p.user_id, p]));

      // Deduplicate: keep one mapping per user (last linked wins)
      const byUser = new Map<string, typeof mappings[number]>();
      for (const m of mappings) {
        byUser.set(m.agent_user_id, m);
      }

      return Array.from(byUser.values())
        .map((m) => ({
          userId: m.agent_user_id,
          slackUserId: m.slack_user_id,
          slackWorkspaceId: m.slack_workspace_id,
          organizationId: m.organization_id,
          timezone: profileMap.get(m.agent_user_id)?.timezone || "America/New_York",
          firstName: profileMap.get(m.agent_user_id)?.first_name || null,
        }))
        .filter((u) => {
          // Only users whose local time is 8 AM on a business day
          const localHour = getLocalHour(u.timezone);
          const localDay = getLocalDayOfWeek(u.timezone);
          return localHour === 8 && localDay >= 1 && localDay <= 5; // Mon–Fri
        });
    });

    if (eligibleUsers.length === 0) {
      return { processed: 0, message: "No users at 8 AM local time" };
    }

    // Step 2: Dedup — skip users already briefed today (in their local timezone)
    const toBrief = await step.run("deduplicate", async () => {
            const supabase = getSupabaseAdmin();

      const userIds = eligibleUsers.map((u) => u.userId);
      // Query with a 48h window to cover all timezones, then filter client-side
      const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const { data: alreadySent } = await supabase
        .from("briefing_log")
        .select("user_id, sent_at")
        .in("user_id", userIds)
        .gte("sent_at", cutoff);

      // Build a set of users who were already briefed on their local date
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

    if (toBrief.length === 0) {
      return { processed: 0, message: "All eligible users already briefed today" };
    }

    // Step 3: Fan out individual briefing events
    await step.sendEvent(
      "fan-out-briefings",
      toBrief.map((user) => ({
        name: "briefing/send-daily" as const,
        data: {
          userId: user.userId,
          slackUserId: user.slackUserId,
          slackWorkspaceId: user.slackWorkspaceId,
          organizationId: user.organizationId,
          firstName: user.firstName,
          timezone: user.timezone,
        },
      }))
    );

    log.info({ count: toBrief.length }, "Queued daily briefings");
    return { processed: toBrief.length };
  }
);

// ─── Per-user briefing delivery ──────────────────────────────────────────────

export const sendDailyBriefing = workflow.createFunction(
  {
    id: "send-daily-briefing",
    concurrency: { limit: 5 },
    retries: 2,
  },
  { event: "briefing/send-daily" },
  async ({ event, step }) => {
        const { userId, slackUserId, slackWorkspaceId, organizationId, firstName, timezone } = event.data;
    const userTz = timezone || "America/New_York";

    // Step 1: Fetch today's meetings + yesterday's meetings from Google Calendar
    const calendarData = await step.run("fetch-calendar-live", async () => {
            const tokens = await getGoogleTokens(userId);
      if (!tokens) {
        log.info("No Google tokens for user, skipping calendar");
        return { todayMeetings: [], yesterdayMeetings: [] };
      }

      // Compute day boundaries in the user's timezone
      const todayStart = getLocalMidnight(userTz, 0);
      const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000 - 1);
      const yesterdayStart = getLocalMidnight(userTz, -1);
      const yesterdayEnd = new Date(todayStart.getTime() - 1);

      const fetchEvents = async (timeMin: Date, timeMax: Date) => {
        try {
          const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin.toISOString())}&timeMax=${encodeURIComponent(timeMax.toISOString())}&maxResults=25&singleEvents=true&orderBy=startTime`;
          const res = await googleApiFetch(url, tokens.accessToken);
          if (!res.ok) return [];
          const data = await res.json();
          return (data.items || [])
            .filter((e: any) => e.status !== "cancelled")
            .map((e: any) => ({
              summary: e.summary || "(No title)",
              start_time: e.start?.dateTime || e.start?.date,
              end_time: e.end?.dateTime || e.end?.date,
              attendees: (e.attendees || []).map((a: any) => ({
                email: a.email,
                name: a.displayName,
                status: a.responseStatus,
              })),
              location: e.location,
              description: e.description?.slice(0, 200),
            }));
        } catch (err) {
          log.error({ err }, "Calendar fetch error");
          return [];
        }
      };

      const [todayMeetings, yesterdayMeetings] = await Promise.all([
        fetchEvents(todayStart, todayEnd),
        fetchEvents(yesterdayStart, yesterdayEnd),
      ]);

      return { todayMeetings, yesterdayMeetings };
    });

    // Step 2: Fetch recent emails from Gmail (last 2 days, sent + received)
    const recentEmails = await step.run("fetch-recent-emails", async () => {
            const tokens = await getGoogleTokens(userId);
      if (!tokens) return [];

      try {
        const twoDaysAgo = new Date();
        twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
        const afterEpoch = Math.floor(twoDaysAgo.getTime() / 1000);
        const query = encodeURIComponent(`after:${afterEpoch} (in:inbox OR in:sent) -category:promotions -category:social`);
        const listUrl = `https://www.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=15`;
        const listRes = await googleApiFetch(listUrl, tokens.accessToken);
        if (!listRes.ok) return [];
        const listData = await listRes.json();
        const messageIds = (listData.messages || []).map((m: any) => m.id);
        if (messageIds.length === 0) return [];

        // Fetch headers for each message (batch of first 10)
        const emails = await Promise.all(
          messageIds.slice(0, 10).map(async (id: string) => {
            const msgUrl = `https://www.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`;
            const msgRes = await googleApiFetch(msgUrl, tokens.accessToken);
            if (!msgRes.ok) return null;
            const msg = await msgRes.json();
            const headers = msg.payload?.headers || [];
            const getHeader = (name: string) => headers.find((h: any) => h.name === name)?.value || "";
            return {
              subject: getHeader("Subject"),
              from: getHeader("From"),
              to: getHeader("To"),
              date: getHeader("Date"),
              snippet: msg.snippet,
              labelIds: msg.labelIds || [],
            };
          })
        );

        return emails.filter(Boolean);
      } catch (err) {
        log.error({ err }, "Gmail fetch error");
        return [];
      }
    });

    // Step 3: Fetch active accounts + deals from Salesforce
    const crmData = await step.run("fetch-crm-data", async () => {
            if (!isSalesforceConfigured()) return { accounts: [], deals: [] };

      try {
        const conn = await getSalesforceConnection(organizationId);

        // Active accounts sorted by recent activity
        const accountResult = await conn.query(`
          SELECT Id, Name, Industry, Website, NumberOfEmployees,
                 OwnerId, Owner.Name, LastModifiedDate
          FROM Account
          WHERE LastModifiedDate >= LAST_N_DAYS:30
          ORDER BY LastModifiedDate DESC
          LIMIT 10
        `);
        const accounts = (accountResult.records || []).map((r: any) => ({
          name: r.Name,
          industry: r.Industry,
          website: r.Website,
          employees: r.NumberOfEmployees,
          owner: r.Owner?.Name,
          lastModified: r.LastModifiedDate,
        }));

        // Open deals
        const dealResult = await conn.query(`
          SELECT Id, Name, StageName, Amount, CloseDate, Probability,
                 Account.Name, NextStep, LastModifiedDate
          FROM Opportunity
          WHERE IsClosed = false
          ORDER BY LastModifiedDate DESC
          LIMIT 15
        `);
        const deals = (dealResult.records || []).map((r: any) => ({
          name: r.Name,
          account: r.Account?.Name,
          stage: r.StageName,
          amount: r.Amount,
          closeDate: r.CloseDate,
          probability: r.Probability,
          nextStep: r.NextStep,
          lastModified: r.LastModifiedDate,
        }));

        return { accounts, deals };
      } catch (err) {
        log.error({ err }, "Salesforce fetch error");
        return { accounts: [], deals: [] };
      }
    });

    // Step 4: Get Slack bot token and open DM
    const slackContext = await step.run("setup-slack", async () => {
            const supabase = getSupabaseAdmin();

      const { data: workspace } = await supabase
        .from("slack_workspaces")
        .select("bot_token")
        .eq("id", slackWorkspaceId)
        .eq("is_active", true)
        .maybeSingle();

      if (!workspace?.bot_token) {
        return null;
      }

      const botToken = await decryptBotToken(workspace.bot_token);

      const dmResp = await fetch("https://slack.com/api/conversations.open", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify({ users: slackUserId }),
      });
      const dmData = await dmResp.json() as any;
      if (!dmData.ok) {
        throw new Error(`Failed to open DM: ${dmData.error}`);
      }

      return { botToken, dmChannelId: dmData.channel.id };
    });

    if (!slackContext) {
      log.warn({ userId }, "No active workspace for user, skipping");
      return { status: "skipped", reason: "no_workspace" };
    }

    // Step 5: Generate LLM briefing with full context
    const briefingSummary = await step.run("generate-briefing", async () => {
            const todayStr = new Date().toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });

      const prompt = `You are a concise executive sales assistant. Generate a morning briefing for ${firstName || "the user"} for ${todayStr}.

You have the following data. Use ONLY what is available — do not fabricate information.

TODAY'S SCHEDULE:
${calendarData.todayMeetings.length === 0 ? "No meetings scheduled" : JSON.stringify(calendarData.todayMeetings.map((m: any) => ({
  title: m.summary,
  start: m.start_time,
  end: m.end_time,
  attendees: (m.attendees || []).map((a: any) => a.name || a.email).join(", "),
  description: m.description,
})), null, 2)}

ACTIVE CRM ACCOUNTS (recently updated):
${crmData.accounts.length === 0 ? "No CRM data available" : JSON.stringify(crmData.accounts, null, 2)}

OPEN DEALS:
${crmData.deals.length === 0 ? "No open deals" : JSON.stringify(crmData.deals, null, 2)}

YESTERDAY'S MEETINGS:
${calendarData.yesterdayMeetings.length === 0 ? "None" : JSON.stringify(calendarData.yesterdayMeetings.map((m: any) => ({
  title: m.summary,
  attendees: (m.attendees || []).map((a: any) => a.name || a.email).join(", "),
})), null, 2)}

RECENT EMAIL ACTIVITY (last 2 days):
${recentEmails.length === 0 ? "No recent emails" : JSON.stringify(recentEmails.map((e: any) => ({
  subject: e.subject,
  from: e.from,
  snippet: e.snippet,
})), null, 2)}

Generate the briefing in EXACTLY this structure. Use Slack mrkdwn formatting (bold = *text*, italic = _text_, NEVER use **text**).

*Daily Briefing — ${todayStr}*

*Today's Schedule*
For each meeting, output:
[start time] - [end time]: [meeting title] (with [attendee first names])
• One bullet of relevant context — connect to CRM deal if there's a match, otherwise note the meeting purpose

*Active Accounts*
List CRM accounts with industry and employee count. Sort by most recently updated. Format:
• *Account Name* — Industry | Employees: N
  Stage: [deal stage] | Amount: $X | Close: [date]

*Recent Activity Highlights*
Summarize key items from yesterday's meetings and recent emails. Focus on sales-relevant conversations. 2-4 bullets max.

*Action Items for Today*
Generate 3-5 specific, actionable items based on the data above. Be concrete — reference specific people, deals, accounts.

*Next Steps*
One sentence summarizing the top priority for the day.

Rules:
- Use Slack mrkdwn: *bold* (single asterisk), _italic_, \`code\`. NEVER **double asterisks**.
- Times in 12-hour format (8:45 AM, not 08:45)
- Be specific and actionable. No fluff.
- If a section has no data, write "No data available" and move on.`;

      const response = await generateClaudeMessage(
        [{ role: "user", content: prompt }],
        { model: "claude-sonnet-4-20250514", temperature: 0.4, maxTokens: 1200 }
      );

      if (organizationId) {
        await trackUsageEvent({
          orgId: organizationId,
          userId,
          eventType: "prompt",
          eventName: "morning-briefing-summary",
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          tokensIn: response.usage?.input_tokens ?? 0,
          tokensOut: response.usage?.output_tokens ?? 0,
        });
      }

      const content = response.content[0];
      return content.type === "text" ? content.text : null;
    });

    // Step 6: Build and send Slack message
    const sendResult = await step.run("send-briefing-message", async () => {
            const blocks = buildBriefingBlocks(briefingSummary);

      const result = await sendSlackBlockMessage(
        slackContext.botToken,
        slackContext.dmChannelId,
        `Good morning${firstName ? `, ${firstName}` : ""}! Here's your daily briefing.`,
        blocks
      );

      if (!result.ok) {
        log.error({ err: result.error }, "Slack send failed");
      }

      return result;
    });

    // Step 7: Log the briefing to prevent duplicates
    await step.run("log-briefing", async () => {
            const supabase = getSupabaseForUser(userId); // RLS-enforced; user can write own briefing log
      await supabase.from("briefing_log").insert({
        user_id: userId,
        organization_id: organizationId,
        sent_at: new Date().toISOString(),
        content_summary: {
          todayMeetings: calendarData.todayMeetings.length,
          yesterdayMeetings: calendarData.yesterdayMeetings.length,
          recentEmails: recentEmails.length,
          accounts: crmData.accounts.length,
          deals: crmData.deals.length,
        },
      });
    });

    return {
      status: "sent",
      userId,
      todayMeetings: calendarData.todayMeetings.length,
      accounts: crmData.accounts.length,
      deals: crmData.deals.length,
      messageTs: sendResult.ts,
    };
  }
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Timezone helpers (getLocalDate, getLocalMidnight, getLocalHour, getLocalDayOfWeek)
// are imported from ../../utils/timezone-helpers

function buildBriefingBlocks(briefingSummary: string | null): any[] {
  const blocks: any[] = [];

  if (briefingSummary) {
    // Split by major sections (lines starting with *Header*) to avoid Slack's
    // "Show more" collapse which triggers on tall single-block messages.
    const sections = splitBySectionHeaders(briefingSummary);
    for (const section of sections) {
      // Each section gets its own block to avoid height-based collapse
      if (section.length <= 3000) {
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: section },
        });
      } else {
        // Fallback: chunk oversized sections by line
        const chunks = splitMrkdwnBySection(section, 2900);
        for (const chunk of chunks) {
          blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: chunk },
          });
        }
      }
    }
  } else {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "No briefing data available today." },
    });
  }

  // Footer
  blocks.push(
    { type: "divider" },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Briefing generated at ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })} | Powered by Sales Agent` },
      ],
    }
  );

  return blocks;
}

/** Split mrkdwn text at *Bold Header* lines so each major section is its own Slack block. */
function splitBySectionHeaders(text: string): string[] {
  // Match lines that are a bold header: starts with * and ends with *
  const lines = text.split("\n");
  const sections: string[] = [];
  let current = "";

  for (const line of lines) {
    const isSectionHeader = /^\*[^*]+\*\s*$/.test(line.trim()) && current.length > 0;
    if (isSectionHeader) {
      sections.push(current.trimEnd());
      current = line;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }
  if (current) sections.push(current.trimEnd());
  return sections;
}

/** Split mrkdwn text into chunks at section boundaries (*Section Header*) to stay under Slack's 3000 char block limit. */
function splitMrkdwnBySection(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    if (current.length + line.length + 1 > maxLen && current.length > 0) {
      chunks.push(current.trimEnd());
      current = line;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }
  if (current) chunks.push(current.trimEnd());
  return chunks;
}
