/**
 * Gmail Draft Tool — create a draft email in the user's Gmail Drafts folder
 * AND show a preview in Slack with Send/Cancel buttons.
 *
 * The draft is also saved to email_auto_response_drafts for the approval flow.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getGoogleTokens, googleApiFetchWithRetry } from '../services/token-manager.js';
import { supabase } from '../lib/supabase.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'gmail_draft' });

/** Escape mrkdwn special characters in user-provided text for safe Slack interpolation. */
function escapeMrkdwn(text: string): string {
  return text.replace(/[&<>*_~`|]/g, (ch) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
    return map[ch] || `\\${ch}`;
  });
}

/** Slack section blocks have a 3000-char limit for text. Truncate with an indicator. */
const SLACK_BLOCK_CHAR_LIMIT = 2900; // leave headroom for the surrounding markup
function truncateForSlack(text: string, limit = SLACK_BLOCK_CHAR_LIMIT): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + '\n\n_...truncated_';
}

interface GmailDraftContext {
  userId: string;
  organizationId: string | null;
  slackContext?: { channelId: string; threadTs: string; botToken?: string };
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, '');
}

function buildRfc2822Message(to: string, subject: string, body: string, replyToThreadId?: string): string {
  const lines = [
    `To: ${sanitizeHeaderValue(to)}`,
    `Subject: ${sanitizeHeaderValue(subject)}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
  ];
  if (replyToThreadId) {
    const safeId = sanitizeHeaderValue(replyToThreadId);
    lines.splice(2, 0, `In-Reply-To: ${safeId}`, `References: ${safeId}`);
  }
  return lines.join('\r\n');
}

export function createGmailDraftTool(ctx: GmailDraftContext) {
  return new DynamicStructuredTool({
    name: 'gmail_draft',
    description:
      'Create a draft email in the user\'s Gmail Drafts folder and show a preview with Send/Cancel buttons. Use this when the user says "draft", "compose", or "write" an email.',
    schema: z.object({
      to: z.string().email().describe('Recipient email address'),
      subject: z.string().describe('Email subject line'),
      body: z.string().describe('Email body text (plain text)'),
      replyToThreadId: z.string().optional().describe('Gmail thread ID to reply to (for threading)'),
    }),
    func: async ({ to, subject, body, replyToThreadId }) => {
      log.info({ to, subject }, 'Creating email draft');

      // Step 1: Save to approval drafts table + show preview in Slack (primary path)
      if (ctx.slackContext) {
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
          } else {
            // Post preview with approval buttons to Slack
            const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: `Bearer ${ctx.slackContext.botToken}`,
              },
              body: JSON.stringify({
                channel: ctx.slackContext.channelId,
                thread_ts: ctx.slackContext.threadTs,
                text: 'Email draft ready for review',
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

            // Step 2: Also create Gmail draft as backup (non-blocking)
            try {
              const tokens = await getGoogleTokens(ctx.userId);
              if (tokens) {
                const raw = buildRfc2822Message(to, subject, body, replyToThreadId);
                const encodedMessage = Buffer.from(raw)
                  .toString('base64')
                  .replace(/\+/g, '-')
                  .replace(/\//g, '_')
                  .replace(/=+$/, '');

                const draftBody: any = { message: { raw: encodedMessage } };
                if (replyToThreadId) {
                  draftBody.message.threadId = replyToThreadId;
                }

                const res = await googleApiFetchWithRetry(
                  ctx.userId,
                  'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(draftBody),
                  },
                  tokens,
                );

                if (res.ok) {
                  const data = await res.json();
                  log.info({ draftId: data.id }, 'Gmail draft created');
                } else {
                  const body = await res.text().catch(() => '');
                  log.error({ status: res.status, googleError: body.slice(0, 500) }, 'Gmail API error');
                }
              }
            } catch (err: any) {
              log.error({ err }, 'Gmail draft creation error (non-blocking)');
            }

            log.info({ approvalId: record.id }, 'Approval request created');
            return JSON.stringify({
              status: 'draft_ready',
              approvalId: record.id,
              message: "Here's the email draft for your review. Click 'Send' to send or 'Cancel' to discard.",
            });
          }
        } catch (err: any) {
          log.error({ err }, 'Approval flow error');
          return JSON.stringify({ error: 'Approval flow failed unexpectedly.' });
        }
      }

      // Fallback: no Slack context — create Gmail draft only
      const tokens = await getGoogleTokens(ctx.userId);
      if (!tokens) {
        return JSON.stringify({ error: 'Gmail not connected.' });
      }

      try {
        const raw = buildRfc2822Message(to, subject, body, replyToThreadId);
        const encodedMessage = Buffer.from(raw)
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');

        const draftBody: any = { message: { raw: encodedMessage } };
        if (replyToThreadId) {
          draftBody.message.threadId = replyToThreadId;
        }

        const res = await googleApiFetchWithRetry(
          ctx.userId,
          'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(draftBody),
          },
          tokens,
        );

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          log.error({ status: res.status, googleError: body.slice(0, 500) }, 'Gmail draft create failed');
          return JSON.stringify({ error: `Failed to create draft: ${res.status}` });
        }

        const data = await res.json();
        return JSON.stringify({
          gmailDraftId: data.id,
          to,
          subject,
          message: 'Draft created in your Gmail Drafts folder.',
        });
      } catch (err: any) {
        return JSON.stringify({ error: err.message });
      }
    },
  });
}
