/**
 * Prospecting skill — Exa web research, long-term memory, Slack history.
 */

import { prospectingTools } from '../../tools/index.js';
import { prospectingAgentPrompt } from '../../agent/system-prompt.js';
import type { SkillDefinition } from '../types.js';

export const prospectingSkill: SkillDefinition = {
  manifest: {
    name: 'prospecting',
    description: 'Research people, companies, or market info from the web',
    classificationHint:
      '"prospecting": Requests to research people, companies, market trends, or external information using web search, OR to interact with Slack users — DMs, group chats, channel invites, or looping someone into a thread. Examples: "Research the CTO of Stripe", "DM Jake about the deal", "Create a group chat with Sarah and Mike", "Add @Ali to this channel", "Loop Sarah into this thread", "Tag Mike here"',
    triggers: [
      {
        type: 'intent',
        patterns: [
          /\b(?:research|look\s*up|find (?:info|information|out)|who is|tell me about)\b/i,
          /\b(?:linkedin|background|funding|news)\b/i,
          /\b(?:what (?:does|is) .+ (?:do|company))\b/i,
          /\b(?:deep research|prep for|prepare for)\b/i,
          /\b(?:dm|direct message|message|slack|group chat|group dm)\b/i,
          /\b(?:add .+ to .+ channel|invite .+ to|loop .+ in|tag .+ in|pull .+ into)\b/i,
        ],
      },
    ],
    compositionRules: [
      {
        // "research X then draft/send" → also activate email tools
        when: /(?=.*\b(?:research|look up|find out)\b)(?=.*\bthen\b)(?=.*\b(?:draft|send|email|write)\b)/i,
        add: ['prospecting', 'sales'],
        sequential: true,
      },
    ],
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 1024,
    recursionLimit: 11,
    workflowKind: 'deep_research',
    aliases: ['research'],
    memory: { canRead: true, canWrite: true },
  },

  tools: (ctx) =>
    prospectingTools(ctx.userId, ctx.organizationId, ctx.slackContext.botToken || ''),

  promptFragment: (ctx) =>
    prospectingAgentPrompt(ctx.user, ctx.promptCtx, ctx.userPreferences),
};
