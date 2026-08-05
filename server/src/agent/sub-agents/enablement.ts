import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { SystemMessage } from "@langchain/core/messages";
import { createLLM } from "../../lib/llm-retry.js";
import { createLoopDetectionHook } from "../../lib/loop-detection.js";
import {
  enablementAgentPrompt,
  type UserInfo,
  type PromptContext,
} from "../system-prompt.js";
import { enablementTools } from "../../tools/index.js";

export function createEnablementAgent(
  userId: string,
  organizationId: string | null,
  user: UserInfo,
  ctx: PromptContext,
) {
  const tools = enablementTools(userId, organizationId);
  const systemPrompt = enablementAgentPrompt(user, ctx);

  const llm = createLLM({ model: "claude-haiku-4-5-20251001", temperature: 0 });

  const messageModifier = new SystemMessage({
    content: [
      { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
    ],
  });

  // createReactAgent's preModelHook type parameter is narrower than the
  // hook's generic BaseMessage state; cast is safe — the shape is compatible.
  return createReactAgent({
    llm,
    tools,
    messageModifier,
    preModelHook: createLoopDetectionHook() as Parameters<typeof createReactAgent>[0]['preModelHook'],
  });
}
