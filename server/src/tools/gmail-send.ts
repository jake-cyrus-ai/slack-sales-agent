/**
 * Gmail Send Tool — request email send with Slack approval.
 * Inserts into email_auto_response_drafts and posts approval buttons to Slack.
 * The existing slack-interaction handler processes the button clicks.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'gmail_send' });

/** Escape mrkdwn special characters in user-provided text for safe Slack interpolation. */
function escapeMrkdwn(text: string): string {
  return text.replace(/[&<>*_~`|]/g, (ch) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
    return map[ch] || `\\${ch}`;
  });
}

/** Slack section blocks have a 3000-char limit for text. Truncate with an indicator. */
const SLACK_BLOCK_CHAR_LIMIT = 2900;
function truncateForSlack(text: string, limit = SLACK_BLOCK_CHAR_LIMIT): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + '\n\n_...truncated_';
}

interface GmailSendContext {
  userId: string;
  organizationId: string | null;
  slackContext: { channelId: string; threadTs: string; botToken?: string };
}

export function createGmailSendTool(ctx: GmailSendContext) {
  return new DynamicStructuredTool({
    name: 'gmail_send',
    description:
      'Send an email on behalf of the user. This does NOT send immediately — it creates a draft and posts an approval request to Slack. The user must click "Send" to actually send. Use this when the user says "send", "fire off", or "reply to" an email.',
    schema: z.object({
      to: z.string().email().describe('Recipient email address'),
      subject: z.string().describe('Email subject line'),
      body: z.string().describe('Email body text (plain text)'),
    }),
    func: async ({ to, subject, body }) => {
      log.info({ to, subject }, 'Sending email');

      try {
        const { data: record, error: insertErr } = await supabase
          .from('email_auto_response_drafts')
          .insert({
            user_id: ctx.userId,
            organization_id: ctx.organizationId,
            to_email: to,
            subject,
            body,
            classification: 'agent-initiated',
            status: 'pending',
            slack_channel_id: ctx.slackContext.channelId,
            slack_thread_ts: ctx.slackContext.threadTs,
          })
          .select()
          .single();

        if (insertErr || !record) {
          log.error({ err: insertErr }, 'DB insert error');
          return JSON.stringify({ error: 'Failed to create approval request.' });
        }

        // Skip Slack approval message when no bot token (web/widget channel)
        if (!ctx.slackContext.botToken) {
          log.info({ draftId: record.id }, "No Slack bot token — draft saved as pending");
          return JSON.stringify({
            status: 'approval_requested',
            approvalId: record.id,
            message: "Email draft saved for review. You can approve or discard it from your activity feed.",
          });
        }

        const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Authorization: `Bearer ${ctx.slackContext.botToken}`,
          },
          body: JSON.stringify({
            channel: ctx.slackContext.channelId,
            thread_ts: ctx.slackContext.threadTs,
            text: 'Email draft ready for approval',
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: truncateForSlack(`*Email Draft*\n\n*To:* ${escapeMrkdwn(to)}\n*Subject:* ${escapeMrkdwn(subject)}\n\n${escapeMrkdwn(body)}`),
                },
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: 'Reply *"approved"* to send or *"cancel"* to discard.',
                  },
                ],
              },
            ],
          }),
        });

        const slackResult = await slackRes.json();
        if (!slackResult.ok) {
          log.error({ err: slackResult.error }, 'Slack post error');
        } else {
          // Store the Slack message ts so we can update it later on text-based approve/reject
          await supabase
            .from('email_auto_response_drafts')
            .update({ slack_message_ts: slackResult.ts })
            .eq('id', record.id);
        }

        log.info({ approvalId: record.id }, 'Approval request created');
        return JSON.stringify({
          status: 'approval_requested',
          approvalId: record.id,
          message: "I've posted the draft for your review. Reply 'approved' to send or 'cancel' to discard.",
        });
      } catch (err: any) {
        log.error({ err }, 'Error sending email');
        return JSON.stringify({ error: err.message });
      }
    },
  });
}
