/**
 * Slack Send DM Tool — send a direct message to a workspace user by name or email.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import { resolveSlackUsers } from './slack-resolve-user.js';

const log = logger.child({ tool: 'slack-send-dm' });

export function createSlackSendDmTool(botToken: string) {
  return new DynamicStructuredTool({
    name: 'slack_send_dm',
    description:
      'Send a direct message to a Slack user. Provide the person\'s name or email — the tool resolves them automatically. Use when asked to DM, message, or notify someone on Slack.',
    schema: z.object({
      user: z.string().describe('Name or email of the Slack user to DM'),
      message: z.string().optional().describe('The message to send. If omitted, a default greeting is sent.'),
      requestingUserName: z.string().optional().describe('Name of the person who asked to send this DM, used for the default message.'),
    }),
    func: async ({ user, message, requestingUserName }) => {
      log.info({ user }, 'Sending DM');

      try {
        // Resolve name → Slack user ID
        const [resolved] = await resolveSlackUsers(botToken, [user]);

        if (resolved.ambiguous) {
          const options = resolved.ambiguous
            .map((u) => `• ${u.realName} (${u.displayName || 'no display name'})`)
            .join('\n');
          return JSON.stringify({
            error: `Multiple users match "${user}". Please be more specific:\n${options}`,
            sent: false,
          });
        }

        if (!resolved.userId) {
          return JSON.stringify({
            error: `Could not find a Slack user matching "${user}". Try using their full name or email address.`,
            sent: false,
          });
        }

        // Open DM channel
        const openResp = await fetch('https://slack.com/api/conversations.open', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${botToken}`,
          },
          body: JSON.stringify({ users: resolved.userId }),
        });
        const openData = (await openResp.json()) as any;

        if (!openData.ok) {
          log.error({ error: openData.error }, 'conversations.open failed');
          return JSON.stringify({ error: `Failed to open DM: ${openData.error}`, sent: false });
        }

        const channelId = openData.channel.id;

        // Build message — use provided text, or generate a sensible default
        const finalMessage = message
          || (requestingUserName
            ? `Hey! ${requestingUserName} asked me to reach out to you.`
            : 'Hey! I was asked to reach out to you.');

        // Send message
        const sendResp = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Authorization: `Bearer ${botToken}`,
          },
          body: JSON.stringify({ channel: channelId, text: finalMessage }),
        });
        const sendData = (await sendResp.json()) as any;

        if (!sendData.ok) {
          log.error({ error: sendData.error }, 'chat.postMessage failed');
          return JSON.stringify({ error: `Failed to send message: ${sendData.error}`, sent: false });
        }

        log.info({ userId: resolved.userId, channel: channelId }, 'DM sent');
        return JSON.stringify({
          sent: true,
          to: resolved.displayName || user,
          userId: resolved.userId,
          channel: channelId,
        });
      } catch (err: any) {
        log.error({ err }, 'slack_send_dm failed');
        return JSON.stringify({ error: err.message, sent: false });
      }
    },
  });
}
