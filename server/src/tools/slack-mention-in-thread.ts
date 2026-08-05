/**
 * Slack Mention in Thread Tool — @mention a user in a thread to loop them in.
 *
 * This works with just `chat:write` scope (no special permissions needed).
 * Useful as a fallback when the bot can't invite to channels, or when
 * someone just needs to be tagged into a specific conversation thread.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import { resolveSlackUsers } from './slack-resolve-user.js';

const log = logger.child({ tool: 'slack-mention-in-thread' });

export function createSlackMentionInThreadTool(botToken: string) {
  return new DynamicStructuredTool({
    name: 'slack_mention_in_thread',
    description:
      'Loop someone into a Slack thread or channel by posting a message that @mentions them. Use when asked to "add someone to a thread", "loop someone in", "tag someone", or "pull someone into the conversation". Works in any channel or thread the bot has access to.',
    schema: z.object({
      user: z.string().describe('Name, email, or @mention of the Slack user to tag'),
      channel: z.string().describe('The channel ID where the thread lives'),
      threadTs: z.string().optional().describe('The thread timestamp to reply in. If omitted, posts as a new message in the channel.'),
      message: z.string().optional().describe('Optional context message. If omitted, a default "looping you in" message is used.'),
      requestingUserName: z.string().optional().describe('Name of the person who asked to loop this person in.'),
    }),
    func: async ({ user, channel, threadTs, message, requestingUserName }) => {
      log.info({ user, channel, threadTs }, 'Mentioning user in thread');

      try {
        const [resolved] = await resolveSlackUsers(botToken, [user]);

        if (resolved.ambiguous) {
          const options = resolved.ambiguous
            .map((u) => `• ${u.realName} (${u.displayName || 'no display name'})`)
            .join('\n');
          return JSON.stringify({
            error: `Multiple users match "${user}". Please be more specific:\n${options}`,
            mentioned: false,
          });
        }

        if (!resolved.userId) {
          return JSON.stringify({
            error: `Could not find a Slack user matching "${user}". Try using their full name or email address.`,
            mentioned: false,
          });
        }

        const mention = `<@${resolved.userId}>`;

        // Build the message
        let finalMessage: string;
        if (message) {
          finalMessage = `${mention} ${message}`;
        } else if (requestingUserName) {
          finalMessage = `${mention} ${requestingUserName} asked me to loop you into this conversation.`;
        } else {
          finalMessage = `${mention} Looping you into this conversation.`;
        }

        const body: Record<string, string> = { channel, text: finalMessage };
        if (threadTs) body.thread_ts = threadTs;

        const resp = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Authorization: `Bearer ${botToken}`,
          },
          body: JSON.stringify(body),
        });
        const data = (await resp.json()) as any;

        if (!data.ok) {
          log.error({ error: data.error }, 'chat.postMessage (mention) failed');
          return JSON.stringify({ error: `Failed to post mention: ${data.error}`, mentioned: false });
        }

        log.info({ userId: resolved.userId, channel, threadTs }, 'User mentioned');
        return JSON.stringify({
          mentioned: true,
          user: resolved.displayName || user,
          userId: resolved.userId,
          channel,
          threadTs: data.ts,
        });
      } catch (err: any) {
        log.error({ err }, 'slack_mention_in_thread failed');
        return JSON.stringify({ error: err.message, mentioned: false });
      }
    },
  });
}
