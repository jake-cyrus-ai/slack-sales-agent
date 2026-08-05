/**
 * Transcript skill — Granola meeting notes search and retrieval.
 */

import { transcriptTools } from '../../tools/index.js';
import { transcriptAgentPrompt } from '../../agent/system-prompt.js';
import { getConnectUrl } from '../connect-url.js';
import type { SkillDefinition } from '../types.js';

export const transcriptSkill: SkillDefinition = {
  manifest: {
    name: 'transcript',
    description: 'Search meeting notes and transcripts',
    classificationHint:
      '"transcript": Questions about meeting notes, transcripts, what was discussed, action items, or meeting recaps. This agent searches Granola meeting recordings and notes. Examples: "What was discussed in yesterday\'s meeting?", "Show me the meeting notes from the Acme call", "What action items came out of the board meeting?", "What did they say about pricing in the last call?"',
    triggers: [
      {
        type: 'intent',
        patterns: [
          /\b(?:meeting notes|meeting summary|meeting recap|meeting highlights)\b/i,
          /\b(?:granola|transcript|what was discussed|action items from)\b/i,
          /\b(?:next steps|action items|takeaways|key points|decisions)\b.*\b(?:call|meeting|sync|standup)\b/i,
          /\b(?:call|meeting|sync|standup)\b.*\b(?:next steps|action items|what was discussed|notes|takeaways)\b/i,
        ],
      },
    ],
    compositionRules: [
      {
        // "prep me for meeting/call" → also research attendees and check emails
        when: /(?=.*\b(?:prep|prepare)\s+(?:me\s+)?(?:for)\b)(?=.*\b(?:meeting|call|sync|demo)\b)/i,
        add: ['transcript', 'prospecting', 'sales'],
      },
    ],
    requiredIntegration: {
      id: 'granola',
      level: 'user',
      label: 'Granola',
      get connectHint() { return `Connect it here: ${getConnectUrl()}`; },
    },
    model: 'claude-haiku-4-5-20251001',
    recursionLimit: 11,
    workflowKind: 'transcript_query',
  },

  tools: (ctx) => transcriptTools(ctx.userId, ctx.granolaScope),

  promptFragment: (ctx) =>
    transcriptAgentPrompt(ctx.user, ctx.promptCtx, ctx.userPreferences),
};
