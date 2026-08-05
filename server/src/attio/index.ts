/**
 * Attio module — public entry point.
 *
 * Exports:
 *   - buildAttioGraph()       — compiled ReAct agent for subgraph integration
 *   - getAttioTools()         — tool array for adding to other agents
 *   - runAttioAgent()         — convenience function for standalone use
 *   - hasAttioConnection      — check if org has active Attio credentials
 */

import { HumanMessage, AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { buildAttioGraph } from './agent/graph.js';
import { buildPromptContext } from '../agent/system-prompt.js';
import type { UserInfo } from '../agent/system-prompt.js';
import { allAttioTools, readAttioTools, writeAttioTools } from './tools/index.js';

export { hasAttioConnection } from '../services/attio-client.js';
export { buildAttioGraph } from './agent/graph.js';
export { allAttioTools, readAttioTools, writeAttioTools } from './tools/index.js';

export function getAttioTools(organizationId: string) {
  return allAttioTools(organizationId);
}

export interface AttioAgentResult {
  response: string;
  messages: BaseMessage[];
}

export interface RunAttioAgentOptions {
  query: string;
  history?: Array<{ role: string; content: string }>;
  user?: UserInfo;
  preferences?: string | null;
  organizationId: string;
}

/**
 * Run the Attio agent with a query and optional conversation history.
 * Returns the agent's text response and the full message history (for multi-turn).
 */
export async function runAttioAgent(
  queryOrOptions: string | RunAttioAgentOptions,
  history: Array<{ role: string; content: string }> = [],
): Promise<AttioAgentResult> {
  const opts = typeof queryOrOptions === 'string'
    ? { query: queryOrOptions, history, user: undefined, preferences: undefined, organizationId: '' }
    : queryOrOptions;

  const user = opts.user || { name: null, email: null, company: null, title: null };
  const ctx = buildPromptContext();
  const graph = buildAttioGraph(opts.organizationId, user, ctx, opts.preferences);

  const messages: BaseMessage[] = (opts.history || []).map((m) =>
    m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content),
  );
  messages.push(new HumanMessage(opts.query));

  const result = await graph.invoke({ messages });

  const aiMessages = result.messages.filter((m: BaseMessage) => m._getType() === 'ai');
  const lastAI = aiMessages[aiMessages.length - 1];
  const responseText =
    typeof lastAI?.content === 'string'
      ? lastAI.content
      : lastAI?.content
        ? JSON.stringify(lastAI.content)
        : 'No response generated.';

  return {
    response: responseText,
    messages: result.messages,
  };
}
