/**
 * Sales skill — email, calendar, contacts, Salesforce, Granola tools.
 */

import { salesTools } from '../../tools/index.js';
import { salesSystemPrompt } from '../../agent/system-prompt.js';
import { getConnectUrl } from '../connect-url.js';
import type { SkillDefinition } from '../types.js';

export const salesSkill: SkillDefinition = {
  manifest: {
    name: 'sales',
    description: 'Check emails, contacts, and deal activity',
    classificationHint:
      '"sales": Questions about deals, prospects, pipeline, specific companies, follow-ups, emails, drafting/sending emails, contact lookups, or CRM-type queries. This agent has Gmail, Calendar, Contacts, Salesforce CRM, meeting notes, and email drafting tools. Examples: "What\'s the latest with Ramp?", "Did I get a reply from Sarah?", "Send an email to jane@ramp.com about the demo", "What\'s my pipeline look like?"',
    triggers: [
      {
        type: 'intent',
        patterns: [
          /\b(?:deal|pipeline|prospect|follow[- ]?up|proposal|close|contract)\b/i,
          /\b(?:email|gmail|inbox|reply|respond|send|draft)\b/i,
          /\bwhat(?:'s| is) (?:the )?(?:latest|status|update) (?:with|on|from)\b/i,
          /\b(?:did .+ (?:reply|respond|email|get back))\b/i,
        ],
      },
    ],
    compositionRules: [
      {
        // "What's the latest/status with X" → also check meeting notes
        when: /\bwhat(?:'s| is) (?:the )?(?:latest|status|update) (?:with|on|from)\b/i,
        add: ['sales', 'transcript'],
      },
      {
        // "thinking/wondering about X" → also research them
        when: /\b(?:thinking about|wondering about|curious about|tell me about|look into)\b/i,
        add: ['sales', 'prospecting'],
      },
    ],
    workflowKind: 'deal_followup',
    requiredIntegration: {
      id: 'google',
      level: 'user',
      label: 'Google (Gmail & Calendar)',
      get connectHint() { return `Connect it here: ${getConnectUrl()}`; },
    },
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 1024,
    memory: { canRead: true, canWrite: true },
  },

  tools: (ctx) =>
    salesTools(
      ctx.userId,
      ctx.organizationId,
      ctx.slackContext,
      undefined,
      ctx.promptCtx.userTimezone,
      ctx.granolaScope,
    ),

  promptFragment: (ctx) =>
    salesSystemPrompt(ctx.user, ctx.promptCtx, ctx.userPreferences),
};
