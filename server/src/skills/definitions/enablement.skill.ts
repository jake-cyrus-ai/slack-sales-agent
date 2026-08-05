/**
 * Enablement skill — knowledge base, shareable docs, Google Drive.
 */

import { enablementTools } from '../../tools/index.js';
import { enablementAgentPrompt } from '../../agent/system-prompt.js';
import type { SkillDefinition } from '../types.js';

export const enablementSkill: SkillDefinition = {
  manifest: {
    name: 'enablement',
    description: 'Search knowledge base, docs, and sales materials',
    classificationHint:
      '"enablement": Questions about internal processes, pricing, product info, competitive intel, company docs, sales playbooks, shareable materials, or documents to share with prospects. This agent searches the knowledge base and shareable document library. Examples: "What\'s our Enterprise pricing?", "Do we have a SOC2 report?", "How do we handle the Salesforce objection?", "Do we have a case study for Acme?", "Send me the MSA template"',
    triggers: [
      {
        type: 'intent',
        patterns: [
          /\b(?:pricing|price|cost|tier|plan|enterprise|soc\s*2|security|compliance)\b/i,
          /\b(?:playbook|process|objection|competitor|battle\s*card)\b/i,
          /\b(?:doc|document|knowledge\s*base|kb|internal|wiki)\b/i,
          /\b(?:how do we|what(?:'s| is) our|do we have)\b/i,
          /\b(?:case study|one-pager|datasheet|white paper)\b/i,
        ],
      },
    ],
    compositionRules: [
      {
        // KB question + meeting/call context → also search transcripts
        when: /(?=.*\b(?:pricing|objection|process|playbook|case study|competitor)\b)(?=.*\b(?:meeting|call|discussed|talked about|mentioned)\b)/i,
        add: ['enablement', 'transcript'],
      },
    ],
    model: 'claude-haiku-4-5-20251001',
    workflowKind: 'knowledge_query',
    aliases: ['knowledge'],
    memory: { canRead: true },
  },

  tools: (ctx) => enablementTools(ctx.userId, ctx.organizationId),

  promptFragment: (ctx) =>
    enablementAgentPrompt(ctx.user, ctx.promptCtx, ctx.userPreferences),
};
