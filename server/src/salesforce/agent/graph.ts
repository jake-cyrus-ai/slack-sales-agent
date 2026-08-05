/**
 * Salesforce Agent — ReAct agent with tool calling via LangGraph.
 *
 * Uses createReactAgent for flexible, conversational tool use. Can be:
 *   - Invoked standalone via runSalesforceAgent()
 *   - Embedded as a subgraph in a larger supervisor graph
 *   - Its tools can be extracted and given to other agents
 */

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { allSfdcTools } from '../tools/index.js';
import { salesforceSystemPrompt } from './prompts.js';
import { createLLM } from '../../lib/llm-retry.js';
import { createLoopDetectionHook } from '../../lib/loop-detection.js';
import type { UserInfo, PromptContext } from '../../agent/system-prompt.js';

function getLlm() {
  return createLLM({ model: 'claude-haiku-4-5-20251001' });
}

export function buildSalesforceGraph(
  organizationId: string,
  user?: UserInfo,
  ctx?: PromptContext,
  preferences?: string | null,
  tools?: StructuredToolInterface[],
) {
  return createReactAgent({
    llm: getLlm(),
    tools: tools || allSfdcTools(organizationId, user?.email),
    messageModifier: salesforceSystemPrompt(user, ctx, preferences),
    preModelHook: createLoopDetectionHook(),
  });
}
