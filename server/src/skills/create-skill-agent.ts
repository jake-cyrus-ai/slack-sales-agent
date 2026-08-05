/**
 * Shared agent factory for standard ReAct-based skills.
 *
 * Reads model/temperature/maxTokens from the skill manifest,
 * applies ephemeral cache control, and uses promptFragment().
 *
 * Skills that need custom agent creation (salesforce, conversational)
 * keep their own createAgent and bypass this factory.
 */

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { SystemMessage } from '@langchain/core/messages';
import { createLLM } from '../lib/llm-retry.js';
import { createLoopDetectionHook } from '../lib/loop-detection.js';
import type { SkillDefinition, SkillContext } from './types.js';
import type { StructuredToolInterface } from '@langchain/core/tools';

export function createSkillAgent(
  skill: SkillDefinition,
  ctx: SkillContext,
  tools: StructuredToolInterface[],
) {
  const llm = createLLM({
    model: skill.manifest.model,
    temperature: skill.manifest.temperature,
    maxTokens: skill.manifest.maxTokens,
  });

  const systemPrompt = skill.promptFragment(ctx);
  const messageModifier = new SystemMessage({
    content: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
  });

  return createReactAgent({ llm, tools, messageModifier, preModelHook: createLoopDetectionHook() });
}
