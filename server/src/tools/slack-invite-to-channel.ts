/**
 * Slack Invite to Channel Tool — add a user to an existing channel.
 *
 * Requires the `channels:manage` and/or `groups:write` bot scopes.
 * If the bot lacks these scopes, the tool returns a clear error
 * explaining that the workspace admin needs to grant them.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import { resolveSlackUsers } from './slack-resolve-user.js';

const log = logger.child({ tool: 'slack-invite-to-channel' });

export function createSlackInviteToChannelTool(botToken: string) {
  return new DynamicStructuredTool({
    name: 'slack_invite_to_channel',
    description:
      'Invite a user to an existing Slack channel. Provide the person\'s name, email, or @mention and the channel ID. Use when asked to "add someone to a channel".',
    schema: z.object({
      user: z.string().describe('Name, email, or @mention of the Slack user to invite'),
      channel: z.string().describe('The channel ID to invite the user to (e.g. C0ABC123)'),
    }),
    func: async ({ user, channel }) => {
      log.info({ user, channel }, 'Inviting user to channel');

      try {
        const [resolved] = await resolveSlackUsers(botToken, [user]);

        if (resolved.ambiguous) {
          const options = resolved.ambiguous
            .map((u) => `• ${u.realName} (${u.displayName || 'no display name'})`)
            .join('\n');
          return JSON.stringify({
            error: `Multiple users match "${user}". Please be more specific:\n${options}`,
            invited: false,
          });
        }

        if (!resolved.userId) {
          return JSON.stringify({
            error: `Could not find a Slack user matching "${user}". Try using their full name or email address.`,
            invited: false,
          });
        }

        const resp = await fetch('https://slack.com/api/conversations.invite', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${botToken}`,
          },
          body: JSON.stringify({
            channel,
            users: resolved.userId,
          }),
        });
        const data = (await resp.json()) as any;

        if (!data.ok) {
          // Handle common errors with helpful messages
          if (data.error === 'missing_scope') {
            log.warn({ error: data.error }, 'Bot lacks scope for conversations.invite');
            return JSON.stringify({
              error: 'I don\'t have permission to invite users to channels. A workspace admin needs to grant the "channels:manage" scope to the Sales Agent app. In the meantime, I can @mention them in the channel to loop them in — would you like me to do that instead?',
              invited: false,
            });
          }
          if (data.error === 'already_in_channel') {
            return JSON.stringify({
              invited: true,
              note: `${resolved.displayName || user} is already in this channel.`,
            });
          }
          if (data.error === 'channel_not_found') {
            return JSON.stringify({
              error: 'I couldn\'t find that channel. I may not have access to it.',
              invited: false,
            });
          }
          if (data.error === 'cant_invite_self') {
            return JSON.stringify({
              error: 'That user is already part of this conversation.',
              invited: false,
            });
          }

          log.error({ error: data.error }, 'conversations.invite failed');
          return JSON.stringify({ error: `Failed to invite user: ${data.error}`, invited: false });
        }

        log.info({ userId: resolved.userId, channel }, 'User invited to channel');
        return JSON.stringify({
          invited: true,
          user: resolved.displayName || user,
          userId: resolved.userId,
          channel,
        });
      } catch (err: any) {
        log.error({ err }, 'slack_invite_to_channel failed');
        return JSON.stringify({ error: err.message, invited: false });
      }
    },
  });
}
