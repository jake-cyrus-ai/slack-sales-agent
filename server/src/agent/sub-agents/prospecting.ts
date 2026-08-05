import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { SystemMessage } from "@langchain/core/messages";
import { createLLM } from "../../lib/llm-retry.js";
import { createLoopDetectionHook } from "../../lib/loop-detection.js";
import {
  prospectingAgentPrompt,
  type UserInfo,
  type PromptContext,
} from "../system-prompt.js";
import { prospectingTools } from "../../tools/index.js";

export function createProspectingAgent(
  userId: string,
  organizationId: string | null,
  botToken: string,
  user: UserInfo,
  ctx: PromptContext,
) {
  const tools = prospectingTools(userId, organizationId, botToken);
  const systemPrompt = prospectingAgentPrompt(user, ctx);

  const llm = createLLM({ model: "claude-sonnet-4-20250514", temperature: 0 });

  const messageModifier = new SystemMessage({
    content: [
      { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
    ],
  });

  return createReactAgent({
    llm,
    tools,
    messageModifier,
    preModelHook: createLoopDetectionHook() as Parameters<typeof createReactAgent>[0]['preModelHook'],
  });
}
