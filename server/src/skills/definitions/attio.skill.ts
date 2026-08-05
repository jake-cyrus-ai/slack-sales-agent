/**
 * Attio skill — CRM queries, deal management, notes, tasks.
 *
 * Always registered (no isAvailable gate) because Attio availability is
 * per-org (DB credentials), not per-server (env vars). Tools handle
 * missing credentials at runtime with clear error messages.
 */

import { buildAttioGraph } from '../../attio/agent/graph.js';
import { allAttioTools } from '../../attio/tools/index.js';
import { attioSystemPrompt } from '../../attio/agent/prompts.js';
import { getConnectUrl } from '../connect-url.js';
import type { SkillDefinition } from '../types.js';

export const attioSkill: SkillDefinition = {
  manifest: {
    name: 'attio',
    description: 'Query or update Attio CRM records',
    classificationHint:
      '"attio": Requests to query, read, write, or look up information in Attio CRM. Examples: "What companies are in Attio?", "Look up Acme in Attio", "What deals do we have in Attio?", "Create a note in Attio for Ramp", "What\'s in our CRM?" (when user has Attio connected)',
    triggers: [
      {
        type: 'intent',
        patterns: [
          /\b(?:attio)\b/i,
          /\b(?:move|update|change)\b.*\b(?:deal|stage|pipeline)\b/i,
          /\b(?:create|add|log)\b.*\b(?:note|task|deal)\b.*\b(?:in|on|to|for)\b/i,
        ],
      },
    ],
    model: 'claude-haiku-4-5-20251001',
    workflowKind: 'attio_query',
    requiredIntegration: {
      id: 'attio',
      level: 'org',
      label: 'Attio CRM',
      get connectHint() { return `An admin can connect it here: ${getConnectUrl()}`; },
    },
  },

  tools: (ctx) => {
    if (!ctx.organizationId) throw new Error('Attio skill requires an organization context');
    return allAttioTools(ctx.organizationId, ctx.user.email);
  },

  promptFragment: (ctx) =>
    attioSystemPrompt(ctx.user, ctx.promptCtx, ctx.userPreferences),

  createAgent: (ctx, _tools?) => {
    if (!ctx.organizationId) throw new Error('Attio skill requires an organization context');
    return buildAttioGraph(ctx.organizationId, ctx.user, ctx.promptCtx, ctx.userPreferences);
  },
};
