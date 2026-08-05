/**
 * Calendar skill — schedule lookup, event creation/update/delete.
 */

import { calendarAgentTools } from '../../tools/index.js';
import { calendarAgentPrompt } from '../../agent/system-prompt.js';
import { getConnectUrl } from '../connect-url.js';
import type { SkillDefinition } from '../types.js';

export const calendarSkill: SkillDefinition = {
  manifest: {
    name: 'calendar',
    description: 'Check schedule, availability, or create events',
    classificationHint:
      '"calendar": Questions about schedule, availability, upcoming meetings, or creating/modifying/deleting calendar events. This agent manages Google Calendar. Examples: "When am I free Thursday?", "What meetings do I have this week?", "Schedule a call with John at 3pm", "Cancel my 4pm meeting", "Reschedule the Acme call to Friday"',
    triggers: [
      {
        type: 'intent',
        patterns: [
          /\b(?:calendar|schedule|appointment|free|available|availability|busy)\b/i,
          /\b(?:when am i|what meetings|my meetings|meeting with)\b/i,
          /\b(?:book|schedule|set up) (?:a )?(?:call|meeting|time)\b/i,
        ],
      },
    ],
    compositionRules: [
      {
        // "next/upcoming meeting" + research/linkedin → also research attendees
        when: /(?=.*\b(?:next|upcoming)\s+(?:meeting|call|sync)\b)(?=.*\b(?:linkedin|background|research|look\s*up|who is|about them)\b)/i,
        add: ['calendar', 'prospecting'],
        sequential: true,
        priority: 0,
      },
      {
        // Calendar context + email/follow-up intent → also activate sales
        when: /\b(?:follow[- ]?up|email|send|draft|reply)\b/i,
        add: ['sales'],
        requiresSkill: 'calendar',
      },
    ],
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 1024,
    workflowKind: 'calendar_query',
    requiredIntegration: {
      id: 'google',
      level: 'user',
      label: 'Google Calendar',
      get connectHint() { return `Connect it here: ${getConnectUrl()}`; },
    },
  },

  tools: (ctx) =>
    calendarAgentTools(ctx.userId, ctx.promptCtx.userTimezone, ctx.slackContext),

  promptFragment: (ctx) =>
    calendarAgentPrompt(ctx.user, ctx.promptCtx, ctx.userPreferences),
};
