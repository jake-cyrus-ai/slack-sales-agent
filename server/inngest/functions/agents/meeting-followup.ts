/**
 * Meeting Follow-Up — Inngest Function
 *
 * Triggered per meeting (fan-out from scan-new-meetings cron).
 * Source-agnostic: works with any meeting note provider that emits
 * "meeting/followup-ready" events with normalized data.
 *
 * Flow: triage (Haiku) → forceDomain → supervisor sub-agents → Slack DM.
 * Triage decides if enablement is needed (KB, docs, competitive intel)
 * or if sales alone can handle all action items (just draft emails).
 */

import { logger } from "../../../lib/logger";
import { inngest } from "../../client";
import { getSupabaseAdmin, getSupabaseForUser } from "../../utils/supabase";
import {
  decryptBotToken,
  sendSlackBlockMessage,
} from "../../utils/slack-helpers";
import {
  startWorkflowRun,
  logWorkflowStep,
  completeWorkflowRun,
} from "../../../src/lib/workflow-tracking.js";
import { runSupervisor } from "../../../src/agent/supervisor";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../../src/config.js";
import { getGoogleTokens, googleApiFetch } from "../../../src/services/token-manager.js";
import { localDateTimeToUTC } from "../../utils/timezone-helpers";

const log = logger.child({ fn: "meeting-followup" });

export const meetingFollowup = inngest.createFunction(
  {
    id: "meeting-followup",
    concurrency: { limit: 5 },
    retries: 2,
  },
  { event: "meeting/followup-ready" },
  async ({ event, step }) => {
    const {
      userId,
      organizationId,
      source,
      externalMeetingId,
      title,
      endTime,
      attendees,
      highlights,
      actionItems,
      rawNotes,
      transcriptUrl,
    } = event.data;

    // Step 0: Wait until the meeting has actually ended (+ 3 min buffer)
    // The scan may pick up meetings that are still in progress.
    const meetingEndTime = await step.run("resolve-meeting-end-time", async () => {
      // Look up the user's timezone — naive datetimes (no Z / no offset) from
      // upstream sources are wall-clock times in the user's local zone, not UTC.
      // Without this, a "2026-04-24T08:17:00" meeting in GMT-3 gets interpreted
      // as 08:17 UTC on the server and the wait-for-meeting-end sleep fires for
      // hours past the actual end.
      const userSupabase = getSupabaseForUser(userId);
      const { data: profileTz } = await userSupabase
        .from("profiles")
        .select("timezone")
        .eq("user_id", userId)
        .maybeSingle();
      const userTz = profileTz?.timezone || "UTC";

      const normalizedEndTime = normalizeTimestamp(endTime, userTz);

      // Try Google Calendar for the authoritative end time
      try {
        const tokens = await getGoogleTokens(userId);
        if (tokens) {
          // Search for the event by title in the time range around the meeting
          const meetingDate = new Date(normalizedEndTime);
          const timeMin = new Date(meetingDate.getTime() - 24 * 60 * 60 * 1000).toISOString();
          const timeMax = new Date(meetingDate.getTime() + 24 * 60 * 60 * 1000).toISOString();
          const searchUrl = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin}&timeMax=${timeMax}&q=${encodeURIComponent(title)}&singleEvents=true&maxResults=5`;
          const res = await googleApiFetch(searchUrl, tokens.accessToken);
          if (!res.ok) {
            log.warn(`Calendar API returned ${res.status} for end time lookup`);
          } else {
            const data = await res.json();
            // Prefer exact title match, fall back to substring if no exact match
            const titleLower = title.toLowerCase();
            const exactMatch = data.items?.find((e: any) =>
              e.summary?.toLowerCase() === titleLower
            );
            const match = exactMatch || data.items?.find((e: any) =>
              e.summary?.toLowerCase().includes(titleLower)
            );
            // Calendar API always returns dateTime with offset; parse as-is.
            if (match?.end?.dateTime) {
              return match.end.dateTime;
            }
          }
        }
      } catch (err) {
        log.warn({ err }, "Could not fetch calendar end time");
      }
      // Fallback: use the (timezone-normalized) endTime from the event data
      return normalizedEndTime;
    });

    // If the meeting hasn't ended yet, sleep until 3 min after it ends
    const endPlusBuffer = new Date(new Date(meetingEndTime).getTime() + 3 * 60 * 1000);
    if (endPlusBuffer.getTime() > Date.now()) {
      log.info(`Meeting "${title}" ends at ${meetingEndTime}, sleeping until ${endPlusBuffer.toISOString()}`);
      await step.sleepUntil("wait-for-meeting-end", endPlusBuffer);
    }

    // Step 1: Start workflow tracking
    const workflowRunId = await step.run("start-workflow-run", async () => {
      return startWorkflowRun({
        orgId: organizationId,
        userId,
        workflowKind: "meeting_followup",
        metadata: { source, externalMeetingId, title },
      });
    });

    // Step 2: Load user profile, Slack mapping, then workspace from mapping
    const context = await step.run("load-context", async () => {
      const userSupabase = getSupabaseForUser(userId); // RLS-enforced for user/org data
      const adminSupabase = getSupabaseAdmin(); // only for slack_workspaces (service-role-only table)

      const [profileResult, slackMappingResult] = await Promise.all([
        userSupabase.from("profiles").select("*").eq("user_id", userId).single(),
        userSupabase
          .from("slack_user_mappings")
          .select("slack_user_id, slack_workspace_id")
          .eq("agent_user_id", userId)
          .eq("organization_id", organizationId)
          .eq("is_active", true)
          .limit(1)
          .maybeSingle(),
      ]);

      // Surface PostgREST / RLS errors explicitly — otherwise `.data === null`
      // looks identical to "row not found" and the no_slack guard fires silently.
      // A rotated anon key (401) caused exactly this on dev on 2026-04-23.
      if (profileResult.error) {
        log.error({ err: profileResult.error, userId }, "profiles read failed in load-context");
      }
      if (slackMappingResult.error) {
        log.error({ err: slackMappingResult.error, userId, organizationId }, "slack_user_mappings read failed in load-context");
      }

      // slack_workspaces is service-role-only (bot tokens, no authenticated RLS policy)
      let workspace = null;
      if (slackMappingResult.data?.slack_workspace_id) {
        const { data } = await adminSupabase
          .from("slack_workspaces")
          .select("id, team_id, bot_token")
          .eq("id", slackMappingResult.data.slack_workspace_id)
          .eq("is_active", true)
          .single();
        workspace = data;
      }

      return {
        profile: profileResult.data,
        slackMapping: slackMappingResult.data,
        workspace,
      };
    });

    // Guard: no Slack mapping
    if (!context.slackMapping || !context.workspace) {
      if (workflowRunId) {
        await step.run("cancel-no-slack", () =>
          completeWorkflowRun({ workflowRunId: workflowRunId!, status: "cancelled", errorCode: "no_slack" })
        );
      }
      return { status: "skipped", reason: "no_slack_mapping" };
    }

    // Step 3: Decrypt bot token
    const botToken = await step.run("decrypt-bot-token", async () => {
      return decryptBotToken(context.workspace!.bot_token);
    });

    // Step 4: Open DM channel
    const dmChannelId = await step.run("open-dm-channel", async () => {
      const resp = await fetch("https://slack.com/api/conversations.open", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify({ users: context.slackMapping!.slack_user_id }),
      });
      if (!resp.ok) throw new Error(`conversations.open HTTP error: ${resp.status}`);
      const data = (await resp.json()) as any;
      if (!data.ok) throw new Error(`conversations.open failed: ${data.error}`);
      return data.channel.id as string;
    });

    // Step 5: Triage action items — decide which agents are needed
    const triage = await step.run("triage-action-items", async () => {
      if (!actionItems?.length) {
        return { needsEnablement: false, forceDomain: "sales" };
      }

      const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        messages: [{
          role: "user",
          content: `You are triaging post-meeting action items to decide what tools are needed.

Action items from the meeting "${title}":
${actionItems.map((a) => `- ${a}`).join("\n")}

Does ANY action item require looking up internal documents, knowledge base articles, case studies, competitive intelligence, pricing info, battle cards, or product comparisons?

Respond with ONLY valid JSON, no other text:
{"needsEnablement": true/false, "reasoning": "one sentence why"}`,
        }],
      });

      const text = response.content[0].type === "text" ? response.content[0].text : "";
      try {
        const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
        const needsEnablement = Boolean(parsed.needsEnablement);
        log.info(`Triage: needsEnablement=${needsEnablement} — ${parsed.reasoning || "no reason"}`);
        return {
          needsEnablement,
          forceDomain: needsEnablement ? "enablement,sales" : "sales",
        };
      } catch {
        log.warn("Triage parse failed, defaulting to enablement,sales");
        return { needsEnablement: true, forceDomain: "enablement,sales" };
      }
    });

    // Step 6: Generate follow-up via supervisor.
    // Pass empty threadTs so the supervisor doesn't post intermediate messages —
    // its returned response goes into a single block message below.
    const profile = context.profile;
    const followupResponse = await step.run("generate-followup", async () => {
      try {
        const result = await runSupervisor({
          messages: [],
          currentMessage: buildFollowupPrompt(title, endTime, attendees, highlights, actionItems, rawNotes),
          userId,
          organizationId,
          userName: profile ? `${profile.first_name || ""} ${profile.last_name || ""}`.trim() || null : null,
          userEmail: profile?.email || null,
          userCompany: profile?.company || null,
          slackContext: { channelId: dmChannelId, threadTs: "", botToken },
          forceDomain: triage.forceDomain,
          userTimezone: profile?.timezone || null,
        });
        return result.response;
      } catch (err) {
        log.error({ err }, "Supervisor failed, using fallback");
        return buildFallbackResponse(title, highlights, actionItems);
      }
    });

    // Log the generation step
    if (workflowRunId) {
      await step.run("log-followup-step", () =>
        logWorkflowStep({
          workflowRunId: workflowRunId!,
          orgId: organizationId,
          userId,
          stepName: "generate_followup",
        })
      );
    }

    // Step 7: Send single block message with header, highlights, next steps, action buttons
    const sendResult = await step.run("send-followup-message", async () => {
      const blocks = buildFollowupBlocks(title, endTime, attendees, highlights, followupResponse, transcriptUrl);
      const result = await sendSlackBlockMessage(
        botToken,
        dmChannelId,
        `Meeting Follow-Up: ${title}`,
        blocks,
        undefined,
        context.workspace!.team_id,
      );
      if (!result.ok) {
        log.warn({ err: result.error }, "Slack follow-up message failed");
      }
      return { ok: result.ok, ts: result.ts };
    });

    // Step 9: Update processed_meetings status
    await step.run("update-processed-meeting", async () => {
      const supabase = getSupabaseAdmin();
      await supabase
        .from("processed_meetings")
        .update({ status: "sent", workflow_run_id: workflowRunId })
        .eq("user_id", userId)
        .eq("source", source)
        .eq("external_meeting_id", externalMeetingId);
    });

    // Step 10: Complete workflow
    if (workflowRunId) {
      await step.run("complete-workflow", () =>
        completeWorkflowRun({ workflowRunId: workflowRunId!, status: "succeeded" })
      );
    }

    log.info(`Follow-up sent for "${title}" (${source})`);
    return { status: "followup_sent", title, source, messageTs: sendResult.ts };
  }
);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Return an ISO-8601 string in UTC for the given timestamp.
 *
 * If the input already carries timezone info (`Z` or `±HH:MM`), it represents
 * an absolute instant — parse it directly. Otherwise the input is a naive
 * wall-clock datetime, which we interpret as belonging to `tz`. JavaScript's
 * default for naive ISO strings is the *server's* local timezone, which on
 * a UTC server silently shifts a GMT-3 user's meeting by 3 hours.
 */
function normalizeTimestamp(value: string, tz: string): string {
  const hasTzInfo = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value);
  if (hasTzInfo) return new Date(value).toISOString();

  const match = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/);
  if (!match) return new Date(value).toISOString();
  const [, date, hh, mm] = match;
  return localDateTimeToUTC(date, parseInt(hh, 10), parseInt(mm, 10), tz).toISOString();
}

function buildFollowupPrompt(
  title: string,
  endTime: string,
  attendees: Array<{ name: string; email?: string }>,
  highlights: string[],
  actionItems: string[],
  rawNotes?: string,
): string {
  const attendeeList = (attendees || []).map((a) => a.email ? `${a.name} (${a.email})` : a.name).join(", ");

  return `This is an automated post-meeting workflow. You MUST generate proactive, specific follow-up actions — do NOT ask the user what they want help with.

A meeting just ended. Based on the notes below, take action:

Meeting: ${title}
Ended: ${endTime}
Attendees: ${attendeeList || "Not available"}

Highlights:
${highlights?.length > 0 ? highlights.map((h) => `- ${h}`).join("\n") : "None extracted"}

Action Items:
${actionItems?.length > 0 ? actionItems.map((a) => `- ${a}`).join("\n") : "None extracted"}

${rawNotes ? `Notes:\n${rawNotes}` : ""}

You MUST do the following (do not ask for confirmation, just do it):

1. RESEARCH FIRST: For each action item, search for the relevant content before drafting:
   - If an attendee asked for a document, case study, or one-pager → search shareable docs and the knowledge base to find it
   - If an attendee asked about pricing, competitive comparisons, or product capabilities → search the knowledge base for battle cards, pricing docs, or feature comparisons and include the actual information in the email body
   - If an attendee asked about a competitor → search for competitive intelligence and write a substantive comparison, don't just say "attached is the comparison"

2. DRAFT EMAILS: For each action item that requires sending information to an attendee, use gmail_draft to create a ready-to-send draft. The email body MUST include the actual content you found — real pricing, real feature comparisons, real document links. Never draft a vague email promising to "send over" something without including it.

3. RESPOND: Your response will be rendered as a single Slack section under a "Your Next Steps" header. Format:
   - Open with one short line of context (e.g. blockers found, competitive urgency) — only if non-obvious. Skip if everything is straightforward.
   - Then a "*Immediate Actions:*" header followed by a bulleted list. Each bullet: *Action — recipient/owner* — one sentence on what to do and why it matters.
   - Optional closing one-liner: a single specific question offering the next step (e.g. "Want me to draft the email to Sarah once you have the MSA?").

4. HARD LIMITS:
   - Maximum 4 bullets in Immediate Actions. Pick the most important.
   - No preamble like "Here's a summary of the meeting" or "Based on the notes" — jump straight to context or actions.
   - No restating highlights — they appear in a separate section above your response.
   - Never respond with generic questions like "What would you like help with?".`;
}

function buildFallbackResponse(
  title: string,
  highlights: string[] | undefined,
  actionItems: string[] | undefined,
): string {
  const parts: string[] = [];

  if (highlights && highlights.length > 0) {
    parts.push("*Key highlights:*");
    parts.push(...highlights.map((h) => `- ${markdownToMrkdwn(h)}`));
  }

  if (actionItems && actionItems.length > 0) {
    parts.push("");
    parts.push("*Action items:*");
    parts.push(...actionItems.map((a) => `- ${a}`));
  }

  if (parts.length === 0) {
    parts.push(`Meeting "${title}" completed. No highlights or action items were extracted.`);
  }

  return parts.join("\n");
}

/** Convert standard Markdown to Slack mrkdwn */
function markdownToMrkdwn(text: string): string {
  return text
    // Bold: **text** or __text__ → *text*
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "*$1*")
    // Italic: _text_ stays the same, *text* stays the same (already valid)
    // Strikethrough: ~~text~~ → ~text~
    .replace(/~~(.+?)~~/g, "~$1~")
    // Bullet lists: "- item" → "• item"
    .replace(/^- /gm, "• ")
    // Headers: ### text → *text*
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
}

const MAX_HIGHLIGHTS_SHOWN = 5;

function buildFollowupBlocks(
  title: string,
  endTime: string,
  attendees: Array<{ name: string; email?: string }> | undefined,
  highlights: string[] | undefined,
  supervisorResponse: string,
  transcriptUrl?: string,
): any[] {
  const attendeeNames = (attendees || []).map((a) => a.name).filter(Boolean).join(", ");

  const formattedTime = (() => {
    try {
      return new Date(endTime).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return endTime;
    }
  })();

  const contextParts = [attendeeNames, formattedTime].filter(Boolean);
  if (transcriptUrl) contextParts.push(`<${transcriptUrl}|View transcript>`);
  const contextText = contextParts.join(" · ");

  const topHighlights = (highlights || []).slice(0, MAX_HIGHLIGHTS_SHOWN);
  const highlightText = topHighlights.length > 0
    ? topHighlights.map((h) => `• ${markdownToMrkdwn(h)}`).join("\n")
    : "_No highlights extracted._";

  const actionValue = JSON.stringify({ title, attendees: attendees || [] });

  return [
    {
      type: "header",
      text: { type: "plain_text", text: `Meeting Follow-Up: ${title}`.slice(0, 150), emoji: true },
    },
    ...(contextText
      ? [{ type: "context", elements: [{ type: "mrkdwn", text: contextText }] }]
      : []),
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Key Highlights*\n${highlightText}` },
    },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Your Next Steps*\n${markdownToMrkdwn(supervisorResponse)}` },
    },
    { type: "divider" },
    {
      type: "actions",
      block_id: "meeting_followup_actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Send Drafted Emails", emoji: true },
          style: "primary",
          action_id: "meeting_send_drafts",
          value: actionValue,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Schedule Follow-Up", emoji: true },
          action_id: "meeting_schedule",
          value: actionValue,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Dismiss", emoji: true },
          action_id: "meeting_dismiss",
          value: actionValue,
        },
      ],
    },
  ];
}
