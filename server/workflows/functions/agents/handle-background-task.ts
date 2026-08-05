/**
 * Background Task Handler — runs a supervisor agent for fire-and-forget tasks.
 *
 * Event: agent/background-task
 * Triggered by: deal-actions (deal_send_followup), meeting-actions (meeting_send_drafts, meeting_schedule)
 *
 * Accepts a structured payload with an internal userId + natural-language message,
 * runs the supervisor, and posts the result back to Slack.
 */

import { workflow } from "../../client";
import { getSupabaseForUser } from "../../utils/supabase";
import { sendSlackMessage, updateSlackMessage, sendSlackBlockMessage } from "../../utils/slack-helpers";
import { runSupervisor } from "../../../src/agent/supervisor";
import { buildPreferenceInstructions } from "../../../src/agent/system-prompt";
import { formatMessageForSlack } from "../../../src/slack/formatter";
import { trackUsageEvent } from "../../../src/lib/usage-tracking";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "handle-background-task" });

export interface BackgroundTaskData {
  userId: string;
  organizationId: string | null;
  botToken: string;
  message: string;
  domainSignals?: Record<string, number> | null;
  context: {
    channelId: string;
    threadTs: string;
  };
}

export const handleBackgroundTask = workflow.createFunction(
  {
    id: "handle-background-task",
    retries: 2,
  },
  { event: "agent/background-task" },
  async ({ event, step }) => {
        const { userId, organizationId, botToken, message, domainSignals, context } =
      event.data as unknown as BackgroundTaskData;

    const { channelId, threadTs } = context;

    // Step 1: Post thinking message + load user preferences
    const prepared = await step.run("prepare", async () => {
            const userSupabase = getSupabaseForUser(userId);

      let thinkingTs: string | null = null;
      try {
        const result = await sendSlackMessage(botToken, channelId, "I'm thinking :thinking_face:", threadTs);
        if (result.ok) thinkingTs = result.ts || null;
        else log.warn({ error: result.error }, "thinking message failed");
      } catch (err) {
        log.warn({ err }, "thinking message error");
      }

      const { data: profile } = await userSupabase
        .from("profiles")
        .select("first_name, last_name, email, company, timezone")
        .eq("user_id", userId)
        .single();

      let userPreferencesStr: string | null = null;
      try {
        const { data: userPrefs } = await userSupabase
          .from("user_preferences")
          .select("preference_key, preference_value, confidence_score")
          .eq("user_id", userId)
          .gte("confidence_score", 0.6);

        const { data: userCtx } = await userSupabase
          .from("user_context")
          .select("*")
          .eq("user_id", userId)
          .maybeSingle();

        if ((userPrefs && userPrefs.length > 0) || userCtx) {
          userPreferencesStr = buildPreferenceInstructions(userPrefs || [], userCtx || null) || null;
        }
      } catch (err) {
        log.warn({ err }, "Failed to load user preferences");
      }

      return { thinkingTs, profile, userPreferences: userPreferencesStr };
    });

    const userName = prepared.profile
      ? `${prepared.profile.first_name || ""} ${prepared.profile.last_name || ""}`.trim() || null
      : null;

    // Step 2: Run supervisor
    const agentStartTime = Date.now();
    const agentResult = await step.run("run-agent", async () => {
            let progressStopped = false;
      const pendingProgressUpdates: Promise<unknown>[] = [];
      const onProgress = prepared.thinkingTs
        ? (status: string) => {
            if (progressStopped) return;
            const p = updateSlackMessage(botToken, channelId, prepared.thinkingTs!, status).catch(
              (err) => log.warn({ err }, "progress update failed"),
            );
            pendingProgressUpdates.push(p);
          }
        : undefined;

      const result = await runSupervisor({
        messages: [],
        currentMessage: message,
        userId,
        organizationId: organizationId || null,
        userName,
        userEmail: prepared.profile?.email || null,
        userCompany: prepared.profile?.company || null,
        slackContext: { channelId, threadTs, botToken },
        domainSignals: domainSignals || null,
        userPreferences: prepared.userPreferences || null,
        userTimezone: prepared.profile?.timezone || null,
        onProgress,
      });

      progressStopped = true;
      await Promise.allSettled(pendingProgressUpdates);

      return result;
    });

    if (organizationId) {
      trackUsageEvent({
        orgId: organizationId,
        userId,
        eventType: "task",
        eventName: "background_task",
        runtimeMs: Date.now() - agentStartTime,
      });
    }

    // Step 3: Post result to Slack
    await step.run("post-result", async () => {
            const blocks = formatMessageForSlack(
        agentResult.response,
        agentResult.sources,
        agentResult.confidence,
        agentResult.hasConflicts,
      );

      if (prepared.thinkingTs) {
        const result = await updateSlackMessage(botToken, channelId, prepared.thinkingTs, agentResult.response, blocks);
        if (!result.ok) {
          log.error({ error: result.error }, "chat.update failed, falling back to postMessage");
          await sendSlackBlockMessage(botToken, channelId, agentResult.response, blocks, threadTs);
        }
      } else {
        const result = await sendSlackBlockMessage(botToken, channelId, agentResult.response, blocks, threadTs);
        if (!result.ok) {
          log.error({ error: result.error }, "Slack API error");
          throw new Error(`Slack API error: ${result.error}`);
        }
      }
    });

    return { status: "ok" };
  },
);
