/**
 * Slack Create Group Chat Tool — open a multi-party DM with multiple users.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import { resolveSlackUsers } from './slack-resolve-user.js';

const log = logger.child({ tool: 'slack-create-group-chat' });

export function createSlackGroupChatTool(botToken: string) {
  return new DynamicStructuredTool({
    name: 'slack_create_group_chat',
    description:
      'Create a group chat (multi-party DM) with multiple Slack users and send an initial message. Provide names or emails — the tool resolves them automatically.',
    schema: z.object({
      users: z
        .array(z.string())
        .min(2)
        .describe('Names or emails of Slack users to include in the group chat'),
      message: z.string().optional().describe('Optional initial message. If omitted, a default greeting is sent.'),
      requestingUserName: z.string().optional().describe('Name of the person who asked to create this group chat, used for the default greeting.'),
      topic: z.string().optional().describe('Optional topic/purpose for the group chat'),
    }),
    func: async ({ users, message, requestingUserName, topic }) => {
      log.info({ users }, 'Creating group chat');

      try {
        // Resolve all names → Slack user IDs
        const resolved = await resolveSlackUsers(botToken, users);

        const failed: string[] = [];
        const ambiguous: string[] = [];
        const userIds: string[] = [];

        for (const r of resolved) {
          if (r.ambiguous) {
            const options = r.ambiguous
              .map((u) => `${u.realName} (${u.displayName || 'no display name'})`)
              .join(', ');
            ambiguous.push(`"${r.identifier}" matches: ${options}`);
          } else if (!r.userId) {
            failed.push(r.identifier);
          } else {
            userIds.push(r.userId);
          }
        }

        if (ambiguous.length > 0) {
          return JSON.stringify({
            error: `Some users are ambiguous — please be more specific:\n${ambiguous.join('\n')}`,
            created: false,
          });
        }

        if (failed.length > 0) {
          return JSON.stringify({
            error: `Could not find these Slack users: ${failed.join(', ')}. Try full names or email addresses.`,
            created: false,
          });
        }

        if (userIds.length < 2) {
          return JSON.stringify({
            error: 'Need at least 2 users for a group chat.',
            created: false,
          });
        }

        // Open MPIM (multi-party DM) — Slack auto-creates when multiple user IDs are passed
        const openResp = await fetch('https://slack.com/api/conversations.open', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${botToken}`,
          },
          body: JSON.stringify({ users: userIds.join(',') }),
        });
        const openData = (await openResp.json()) as any;

        if (!openData.ok) {
          log.error({ error: openData.error }, 'conversations.open (mpim) failed');
          return JSON.stringify({ error: `Failed to create group chat: ${openData.error}`, created: false });
        }

        const channelId = openData.channel.id;

        // Set topic if provided
        if (topic) {
          await fetch('https://slack.com/api/conversations.setTopic', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${botToken}`,
            },
            body: JSON.stringify({ channel: channelId, topic }),
          });
        }

        // Build @mention tags for all participants
        const mentions = userIds.map((id) => `<@${id}>`).join(' ');

        // Build message — use provided text, or generate a sensible default
        // Always prepend @mentions so participants get notified
        let finalMessage: string;
        if (message) {
          finalMessage = `${mentions} ${message}`;
        } else if (requestingUserName) {
          finalMessage = `${mentions} Hey! ${requestingUserName} asked me to start a group chat with everyone here.`;
        } else {
          finalMessage = `${mentions} Hey! I was asked to start a group chat with everyone here.`;
        }

        // Send initial message
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
          log.error({ error: sendData.error }, 'chat.postMessage to group failed');
          return JSON.stringify({
            error: `Group created but failed to send message: ${sendData.error}`,
            created: true,
            channel: channelId,
          });
        }

        const names = resolved.map((r) => r.displayName || r.identifier).join(', ');
        log.info({ channel: channelId, userCount: userIds.length }, 'Group chat created');

        return JSON.stringify({
          created: true,
          channel: channelId,
          participants: names,
          userIds,
        });
      } catch (err: any) {
        log.error({ err }, 'slack_create_group_chat failed');
        return JSON.stringify({ error: err.message, created: false });
      }
    },
  });
}
