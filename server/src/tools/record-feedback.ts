/**
 * Record User Feedback Tool — captures behavioral corrections and preferences.
 *
 * The agent calls this tool when it recognizes the user is giving feedback
 * about how the assistant should behave — corrections, preferences, or
 * complaints about past outputs. This is zero extra LLM cost since the
 * agent is already processing the message and understands the context.
 *
 * Examples of when the agent should call this:
 * - "don't mention pricing in cold outreach"
 * - "that email was too long, keep them under 100 words"
 * - "I prefer a more casual tone"
 * - "stop including case studies"
 * - "from now on, always CC my manager on deal emails"
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { writeFeedbackEvent } from '../../inngest/utils/feedback-capture.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'record_user_feedback' });

export function createRecordFeedbackTool(userId: string, organizationId: string | null) {
  return new DynamicStructuredTool({
    name: 'record_user_feedback',
    description:
      'Record when the user gives you feedback about how you should behave differently. Call this when the user corrects your approach, states a preference about your outputs (emails, responses, actions), or complains about something you did. Examples: "don\'t mention pricing", "keep emails shorter", "that was too formal", "stop including case studies in cold outreach", "from now on always CC my manager". Do NOT call for normal requests like "send an email" or "look up a company" — only for behavioral corrections and preferences.',
    schema: z.object({
      feedback: z.string().describe('The user\'s feedback or correction, stated clearly'),
      domain: z
        .enum(['email', 'calendar', 'deal', 'meeting_prep', 'general'])
        .describe(
          'Which domain this feedback applies to: "email" (drafts, tone, content), "calendar" (scheduling), "deal" (CRM actions, follow-ups), "meeting_prep" (briefings), "general" (overall behavior)',
        ),
    }),
    func: async ({ feedback, domain }) => {
      log.info({ feedback, domain, userId }, 'Recording user feedback');

      if (!organizationId) {
        return JSON.stringify({ recorded: false, message: 'No organization context' });
      }

      writeFeedbackEvent({
        userId,
        organizationId,
        domain,
        signalType: 'correction',
        userAction: { message: feedback },
        context: { source: 'agent_tool' },
      });

      return JSON.stringify({
        recorded: true,
        message: `Noted — I'll adjust my behavior: "${feedback}"`,
      });
    },
  });
}
