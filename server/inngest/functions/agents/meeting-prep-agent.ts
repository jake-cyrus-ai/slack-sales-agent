/**
 * Meeting Prep Agent - Inngest Function
 *
 * Autonomous meeting preparation workflow:
 * 1. Fetch meeting details live from Google Calendar API
 * 2. Resolve user context (profile, Slack, workspace)
 * 3. Run supervisor agent with real tools (Exa, Mem0, KB, contacts, etc.)
 * 4. Deliver prep brief via Slack DM
 *
 * Uses the same runSupervisor() pipeline as interactive Slack chat,
 * so the prep is based on real data from connected integrations.
 */

import { logger } from "../../../lib/logger";
import { inngest } from "../../client";
import { getSupabaseAdmin } from "../../utils/supabase";
import { resolveOrgForUser } from "../../utils/tenant-resolver";
import { getGoogleTokens, googleApiFetch } from "../../../src/services/token-manager.js";
import {
  decryptBotToken,
  sendSlackBlockMessage,
} from "../../utils/slack-helpers";
import { runSupervisor } from "../../../src/agent/supervisor";
import {
  startWorkflowRun,
  logWorkflowStep,
  completeWorkflowRun,
} from "../../../src/lib/workflow-tracking.js";

const log = logger.child({ fn: "meeting-prep-agent" });

/**
 * Split a markdown body into chunks that each fit Slack's section.text.text
 * limit (3000 chars). Splits at paragraph boundaries when possible; falls
 * back to a hard cut at `maxLen` for paragraphs that exceed the limit alone.
 *
 * Returns at least one chunk: a single space `" "` when the input is empty,
 * because Slack rejects sections with empty text but a space renders as
 * nothing. (We could omit the section entirely instead, but a one-space
 * placeholder keeps the surrounding dividers laid out the way the brief
 * was designed.)
 */
function chunkForSlackSection(input: string, maxLen: number): string[] {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return [" "];

  const paragraphs = trimmed.split(/\n{2,}/);
  const chunks: string[] = [];
  let buffer = "";

  const flush = () => {
    if (buffer) {
      chunks.push(buffer);
      buffer = "";
    }
  };

  for (const para of paragraphs) {
    if (para.length > maxLen) {
      flush();
      // Hard-cut a single oversized paragraph into maxLen-sized slices.
      for (let i = 0; i < para.length; i += maxLen) {
        chunks.push(para.slice(i, i + maxLen));
      }
      continue;
    }
    const candidate = buffer ? `${buffer}\n\n${para}` : para;
    if (candidate.length > maxLen) {
      flush();
      buffer = para;
    } else {
      buffer = candidate;
    }
  }
  flush();
  return chunks.length > 0 ? chunks : [" "];
}

export const meetingPrepAgent = inngest.createFunction(
  {
    id: "meeting-prep-agent",
    retries: 2,
    idempotency: "event.data.userId + '-' + event.data.eventId",
  },
  { event: "calendar/meeting-prep" },
  async ({ event, step }) => {
    const {
      userId,
      eventId,
      organizationId,
      autoDeliver = false,
    } = event.data;

    // Step 1: Get org + start workflow tracking
    const actualOrgId = await step.run("get-organization", async () => {
      if (organizationId) return organizationId;
      return resolveOrgForUser(userId);
    });

    const workflowRunId = await step.run("start-workflow-run", async () => {
      if (!actualOrgId) return null;
      return startWorkflowRun({
        orgId: actualOrgId,
        userId,
        workflowKind: "meeting_prep",
        metadata: { eventId },
      });
    });

    // Step 2: Fetch meeting details from Google Calendar API
    const meeting = await step.run("fetch-meeting-details", async () => {
      const tokens = await getGoogleTokens(userId);
      if (!tokens) throw new Error(`No Google tokens for user ${userId}`);

      const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`;
      const res = await googleApiFetch(url, tokens.accessToken);
      if (!res.ok) throw new Error(`Calendar API failed for event ${eventId}: ${res.status}`);

      const calEvent = await res.json();
      return {
        summary: calEvent.summary || "(No title)",
        startTime: calEvent.start?.dateTime || calEvent.start?.date,
        endTime: calEvent.end?.dateTime || calEvent.end?.date,
        attendees: (calEvent.attendees || []).map((a: any) => ({
          email: a.email,
          name: a.displayName || a.email?.split("@")[0],
          organizer: a.organizer,
        })),
        description: calEvent.description?.slice(0, 500),
        htmlLink: calEvent.htmlLink,
      };
    });

    // Step 3: Resolve user context + Slack mapping
    const context = await step.run("resolve-context", async () => {
      const supabase = getSupabaseAdmin();

      const [profileResult, slackMappingResult] = await Promise.all([
        supabase
          .from("profiles")
          .select("email, first_name, last_name, company, title, timezone")
          .eq("user_id", userId)
          .maybeSingle(),
        supabase
          .from("slack_user_mappings")
          .select("slack_user_id, slack_workspace_id")
          .eq("agent_user_id", userId)
          .eq("organization_id", actualOrgId)
          .eq("is_active", true)
          .limit(1)
          .maybeSingle(),
      ]);

      const profile = profileResult.data;
      const slackMapping = slackMappingResult.data;

      let botToken: string | null = null;
      if (slackMapping) {
        const { data: workspace } = await supabase
          .from("slack_workspaces")
          .select("bot_token")
          .eq("id", slackMapping.slack_workspace_id)
          .eq("is_active", true)
          .maybeSingle();
        if (workspace?.bot_token) {
          botToken = await decryptBotToken(workspace.bot_token);
        }
      }

      return {
        profile,
        slackMapping,
        botToken,
      };
    });

    if (!context.slackMapping || !context.botToken) {
      if (workflowRunId) {
        await step.run("cancel-no-slack", () =>
          completeWorkflowRun({ workflowRunId: workflowRunId!, status: "cancelled", errorCode: "no_slack" })
        );
      }
      return { status: "skipped", reason: "no_slack_mapping" };
    }

    // Step 4: Open DM channel
    const dmChannelId = await step.run("open-dm-channel", async () => {
      const resp = await fetch("https://slack.com/api/conversations.open", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${context.botToken}`,
        },
        body: JSON.stringify({ users: context.slackMapping!.slack_user_id }),
      });
      const data = await resp.json() as any;
      if (!data.ok) throw new Error(`conversations.open failed: ${data.error}`);
      return data.channel.id as string;
    });

    // Step 5: Build meeting prep prompt and run through supervisor with real tools
    const profile = context.profile;
    const attendeeList = meeting.attendees
      .map((a: any) => `${a.name} (${a.email})${a.organizer ? " [organizer]" : ""}`)
      .join(", ");

    const prepPrompt = `Prep me for my upcoming meeting.

Meeting: ${meeting.summary}
Time: ${meeting.startTime}
Attendees: ${attendeeList}
${meeting.description ? `Description: ${meeting.description}` : ""}

Research the external attendees and their companies. Look up any relevant deals, past conversations, or context from our CRM and knowledge base. Check if we've had any recent meetings or email threads with these people.

Give me a concise prep brief covering:
- Who I'm meeting with and their background
- Any active deals or past interactions with their company
- Key talking points based on what we know
- Potential objections or concerns to prepare for
- Suggested next steps to propose

Format for Slack (use *bold* not **bold**, use _italic_ not __italic__).`;

    const prepBrief = await step.run("generate-prep-via-supervisor", async () => {
      try {
        const result = await runSupervisor({
          messages: [],
          currentMessage: prepPrompt,
          userId,
          organizationId: actualOrgId,
          userName: profile ? `${profile.first_name || ""} ${profile.last_name || ""}`.trim() || null : null,
          userEmail: profile?.email || null,
          userCompany: profile?.company || null,
          slackContext: { channelId: dmChannelId, threadTs: "", botToken: context.botToken! },
          domainSignals: { sales: 2, prospecting: 2, knowledge: 1 },
          userTimezone: profile?.timezone || null,
        });
        return result.response;
      } catch (err) {
        log.error({ err }, "Supervisor failed");
        return `I wasn't able to complete full research for your meeting "${meeting.summary}" with ${attendeeList}. Please ask me in Slack for a manual prep.`;
      }
    });

    // Sanitize: strip duplicate title heading & convert markdown → Slack mrkdwn
    const sanitizedBrief = prepBrief
      // Remove leading heading that duplicates the Slack header block
      .replace(/^#{1,3}\s*Meeting Prep:.*\n+/i, "")
      // Convert ### / ## headings to bold
      .replace(/^#{1,3}\s+(.+)$/gm, "*$1*")
      // Convert **text** to *text* (Slack bold)
      .replace(/\*\*(.+?)\*\*/g, "*$1*")

    // Log the generation step
    if (workflowRunId && actualOrgId) {
      await step.run("log-prep-step", () =>
        logWorkflowStep({
          workflowRunId: workflowRunId!,
          orgId: actualOrgId!,
          userId,
          stepName: "generate_prep",
          metadata: { attendeeCount: meeting.attendees.length },
        })
      );
    }

    // Step 6: Deliver via Slack DM
    const sendResult = await step.run("deliver-slack-dm", async () => {
      const startTime = new Date(meeting.startTime);
      const minutesUntil = Math.round((startTime.getTime() - Date.now()) / 60000);
      const timeLabel = minutesUntil > 0
        ? `in ${minutesUntil} minute${minutesUntil !== 1 ? "s" : ""}`
        : "now";

      const attendeeNames = meeting.attendees
        .map((a: any) => a.name)
        .slice(0, 3)
        .join(", ");
      const moreCount = meeting.attendees.length > 3 ? ` +${meeting.attendees.length - 3} more` : "";

      // Slack's section.text.text has a hard 3000-char limit. LLM-generated
      // briefs routinely exceed it — Slack rejects the whole payload with
      // `invalid_blocks` when ANY block goes over. Chunk the brief at safe
      // paragraph boundaries (or hard-cut if a single paragraph is huge),
      // and skip section emission entirely if the brief came back empty.
      const SLACK_SECTION_TEXT_MAX = 2900; // leave 100 chars of headroom
      const briefChunks = chunkForSlackSection(sanitizedBrief, SLACK_SECTION_TEXT_MAX);

      const blocks: any[] = [
        {
          type: "header",
          text: { type: "plain_text", text: `Meeting Prep: ${meeting.summary}`, emoji: true },
        },
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: `Starting ${timeLabel} | ${attendeeNames}${moreCount}` },
          ],
        },
        { type: "divider" },
        ...briefChunks.map((text) => ({
          type: "section",
          text: { type: "mrkdwn", text },
        })),
        { type: "divider" },
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: `Prep generated by Sales Agent using your connected integrations` },
          ],
        },
      ];

      // Add calendar link if available
      if (meeting.htmlLink) {
        blocks.push({
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Open in Calendar", emoji: true },
              url: meeting.htmlLink,
              action_id: "meeting_open_calendar",
            },
          ],
        });
      }

      const result = await sendSlackBlockMessage(
        context.botToken!,
        dmChannelId,
        `Meeting prep for "${meeting.summary}" starting ${timeLabel}`,
        blocks
      );

      if (!result.ok) {
        log.error({ err: result.error }, "Slack delivery failed");
      }
      return result;
    });

    // Step 7: Write to meeting_prep_cache so the scan-upcoming-meetings dedup works
    await step.run("cache-meeting-prep", async () => {
      const supabase = getSupabaseAdmin();

      // Upsert calendar_events row to get a stable UUID for the FK
      const { data: calRow, error: calErr } = await supabase
        .from("calendar_events")
        .upsert(
          {
            user_id: userId,
            google_event_id: eventId,
            summary: meeting.summary,
            start_time: meeting.startTime,
            end_time: meeting.endTime || meeting.startTime,
            attendees: meeting.attendees,
            organization_id: actualOrgId || undefined,
          },
          { onConflict: "user_id,google_event_id" }
        )
        .select("id")
        .single();

      if (calErr || !calRow) {
        log.error({ err: calErr }, "Failed to upsert calendar_events for prep cache");
        return;
      }

      const { error: cacheErr } = await supabase
        .from("meeting_prep_cache")
        .upsert(
          {
            user_id: userId,
            event_id: calRow.id,
            prep_content: sanitizedBrief,
            generated_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            generation_method: "langgraph_agent",
            organization_id: actualOrgId || undefined,
          },
          { onConflict: "event_id" }
        );

      if (cacheErr) {
        log.error({ err: cacheErr }, "Failed to write meeting_prep_cache");
      }
    });

    // Step 8: Complete workflow
    if (workflowRunId) {
      await step.run("complete-workflow-run", () =>
        completeWorkflowRun({ workflowRunId: workflowRunId!, status: "succeeded" })
      );
    }

    log.info(`Delivered prep for event ${eventId} to user ${userId}`);
    return {
      status: "completed",
      eventId,
      messageTs: sendResult.ts,
      workflowRunId,
    };
  }
);
