/**
 * Salesforce module — public entry point.
 *
 * Exports:
 *   - buildSalesforceGraph()   — compiled ReAct agent for subgraph integration
 *   - getSalesforceTools()     — tool array for adding to other agents
 *   - runSalesforceAgent()     — convenience function for standalone use
 *   - isSalesforceConfigured   — config check
 */

import { HumanMessage, AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { buildSalesforceGraph } from './agent/graph.js';
import { buildPromptContext } from '../agent/system-prompt.js';
import type { UserInfo } from '../agent/system-prompt.js';
import { allSfdcTools, readSfdcTools, writeSfdcTools } from './tools/index.js';

export { isSalesforceConfigured, isSalesforceConfiguredForOrg } from './client.js';
export { buildSalesforceGraph } from './agent/graph.js';
export { allSfdcTools, readSfdcTools, writeSfdcTools } from './tools/index.js';

export function getSalesforceTools(organizationId: string, actorEmail?: string | null) {
  return allSfdcTools(organizationId, actorEmail);
}

export interface SalesforceAgentResult {
  response: string;
  messages: BaseMessage[];
}

export interface RunSalesforceAgentOptions {
  query: string;
  organizationId: string;
  history?: Array<{ role: string; content: string }>;
  user?: UserInfo;
  preferences?: string | null;
}

/**
 * Run the Salesforce agent with a query and optional conversation history.
 * Returns the agent's text response and the full message history (for multi-turn).
 */
export async function runSalesforceAgent(
  queryOrOptions: string | RunSalesforceAgentOptions,
  history: Array<{ role: string; content: string }> = [],
): Promise<SalesforceAgentResult> {
  const opts = typeof queryOrOptions === 'string'
    ? { query: queryOrOptions, organizationId: '', history, user: undefined, preferences: undefined }
    : queryOrOptions;

  if (!opts.organizationId) {
    throw new Error('organizationId is required to run the Salesforce agent');
  }

  const user = opts.user || { name: null, email: null, company: null, title: null };
  const ctx = buildPromptContext();
  const graph = buildSalesforceGraph(opts.organizationId, user, ctx, opts.preferences);

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
