/**
 * Deep Research Agent — Inngest function for async prospecting research.
 *
 * Runs the prospecting skill asynchronously and posts a follow-up message
 * to the same Slack thread when complete.
 */

import { inngest } from "../../client";
import { registry } from "../../../src/skills/registry.js";
import { allSkills } from "../../../src/skills/definitions/index.js";
import { buildPromptContext, type UserInfo } from "../../../src/agent/system-prompt.js";
import { GranolaClientScope } from "../../../src/services/granola-client.js";
import { getMemoryService } from "../../../src/services/memory/index.js";
import { HumanMessage } from "@langchain/core/messages";
import { getSupabaseForUser } from "../../utils/supabase";
import { trackUsageEvent } from "../../../src/lib/usage-tracking";
import type { SkillContext } from "../../../src/skills/types.js";

export const deepResearchAgent = inngest.createFunction(
  {
    id: "deep-research-agent",
    retries: 1,
  },
  { event: "agent/deep-research" },
  async ({ event, step }) => {
    const { agent, userId, organizationId, query, slackContext, runId } = event.data as {
      agent: string;
      userId: string;
      organizationId: string | null;
      query: string;
      slackContext: { channelId: string; threadTs: string; botToken?: string };
      runId: string;
    };

    // Step 1: Load user profile
    const userProfile = await step.run("load-user-profile", async () => {
      const supabase = getSupabaseForUser(userId); // RLS-enforced; can only read own profile
      const { data } = await supabase
        .from("profiles")
        .select("first_name, last_name, email, company, timezone, title")
        .eq("user_id", userId)
        .single();

      return {
        name: data ? [data.first_name, data.last_name].filter(Boolean).join(" ") : null,
        email: data?.email || null,
        company: data?.company || null,
        title: data?.title || null,
        timezone: data?.timezone || null,
      };
    });

    // Step 2: Run the prospecting skill
    const result = await step.run("run-prospecting-agent", async () => {
      registry.loadAll(allSkills);
      const skill = registry.resolve('prospecting')!;

      const user: UserInfo = {
        name: userProfile.name,
        email: userProfile.email,
        company: userProfile.company,
        title: userProfile.title || null,
      };
      const ctx = buildPromptContext(userProfile.timezone);

      const skillCtx: SkillContext = {
        userId,
        organizationId,
        user,
        promptCtx: ctx,
        userPreferences: null,
        slackContext,
        granolaScope: new GranolaClientScope(),
        userTimezone: userProfile.timezone,
        memoryService: getMemoryService(),
      };

      const prospectingAgent = skill.createAgent(skillCtx);

      const agentResult = await Promise.race([
        prospectingAgent.invoke({
          messages: [new HumanMessage(query)],
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Deep research timed out after 120s")), 120_000)
        ),
      ]);

      const aiMessages = agentResult.messages.filter((m: any) => m._getType() === "ai");
      const lastAI = aiMessages[aiMessages.length - 1];
      return typeof lastAI?.content === "string"
        ? lastAI.content
        : "Research completed but no summary was generated.";
    });

    // Step 3: Post follow-up to Slack thread
    await step.run("post-to-slack", async () => {
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${slackContext.botToken}`,
        },
        body: JSON.stringify({
          channel: slackContext.channelId,
          thread_ts: slackContext.threadTs,
          text: result,
        }),
      });
    });

    // Track usage
    if (organizationId) {
      trackUsageEvent({
        orgId: organizationId,
        userId,
        eventType: "task",
        eventName: "deep_research",
      });
    }

    return { status: "completed", runId };
  }
);
