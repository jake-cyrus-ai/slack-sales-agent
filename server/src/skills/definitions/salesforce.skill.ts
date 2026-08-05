/**
 * Salesforce skill — CRM queries, opportunity management, account lookups.
 *
 * Only loads when Salesforce OAuth is configured (connected app env vars set).
 * Fixes pre-existing bug: supervisor was passing UserInfo where organizationId expected.
 */

import { buildSalesforceGraph } from '../../salesforce/agent/graph.js';
import { isSalesforceConfigured } from '../../salesforce/client.js';
import { allSfdcTools } from '../../salesforce/tools/index.js';
import { salesforceSystemPrompt } from '../../salesforce/agent/prompts.js';
import { getConnectUrl } from '../connect-url.js';
import { createSaveSalesforceRuleTool } from '../../tools/save-salesforce-rule.js';
import { createRecallSalesforceRulesTool } from '../../tools/recall-salesforce-rules.js';
import { createDeleteSalesforceRuleTool } from '../../tools/delete-salesforce-rule.js';
import { createListSalesforceRulesTool } from '../../tools/list-salesforce-rules.js';
import type { SkillDefinition } from '../types.js';

export const salesforceSkill: SkillDefinition = {
  manifest: {
    name: 'salesforce',
    description: 'Query or update Salesforce CRM records',
    classificationHint:
      '"salesforce": Requests to query, read, write, or look up information in Salesforce (SFDC). Examples: "What accounts do we have in Salesforce?", "Update the Acme deal stage to Closed Won", "Log a call in Salesforce"',
    triggers: [
      {
        type: 'intent',
        patterns: [/\b(?:salesforce|sfdc)\b/i],
      },
    ],
    model: 'claude-haiku-4-5-20251001',
    workflowKind: 'salesforce_query',
    isAvailable: () => isSalesforceConfigured(),
    requiredIntegration: {
      id: 'salesforce',
      level: 'org',
      label: 'Salesforce',
      get connectHint() { return `An admin can connect it here: ${getConnectUrl()}`; },
    },
    memory: { canRead: true, useSkillNamespace: true },
  },

  tools: (ctx) => {
    if (!ctx.organizationId) throw new Error('Salesforce skill requires an organization context');
    return [
      ...allSfdcTools(ctx.organizationId, ctx.user.email),
      createSaveSalesforceRuleTool(ctx.userId, ctx.organizationId),
      createRecallSalesforceRulesTool(ctx.userId, ctx.organizationId),
      createDeleteSalesforceRuleTool(ctx.userId, ctx.organizationId),
      createListSalesforceRulesTool(ctx.userId, ctx.organizationId),
    ];
  },

  promptFragment: (ctx) =>
    salesforceSystemPrompt(ctx.user, ctx.promptCtx, ctx.userPreferences),

  createAgent: (ctx, tools?) => {
    if (!ctx.organizationId) throw new Error('Salesforce skill requires an organization context');
    return buildSalesforceGraph(ctx.organizationId, ctx.user, ctx.promptCtx, ctx.userPreferences, tools);
  },
};
