/**
 * Gmail Read Tool — fetch full email content and extract text from attachments.
 *
 * Complements gmail_search (which only returns metadata/snippets) by retrieving
 * the full message body and attachment contents. Reuses the lightweight
 * googleApiFetch pattern from gmail-search.ts for consistency.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getGoogleTokens, googleApiFetchWithRetry } from '../services/token-manager.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'gmail_read' });

/** Decode Gmail's base64url body data to a UTF-8 string. */
function decodeBody(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf-8');
}

/** Recursively walk MIME parts to find the best text body. */
function extractBodyText(payload: any): { plain: string; html: string } {
  let plain = '';
  let html = '';

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    plain = decodeBody(payload.body.data);
  } else if (payload.mimeType === 'text/html' && payload.body?.data) {
    html = decodeBody(payload.body.data);
  }

  for (const part of payload.parts || []) {
    const child = extractBodyText(part);
    if (child.plain) plain = child.plain;
    if (child.html) html = child.html;
  }

  return { plain, html };
}

/** Strip HTML tags for a rough plain-text conversion. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Collect attachment metadata from MIME parts. */
function collectAttachments(payload: any): Array<{
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}> {
  const attachments: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }> = [];

  if (payload.filename && payload.body?.attachmentId) {
    attachments.push({
      filename: payload.filename,
      mimeType: payload.mimeType || 'application/octet-stream',
      size: payload.body.size || 0,
      attachmentId: payload.body.attachmentId,
    });
  }

  for (const part of payload.parts || []) {
    attachments.push(...collectAttachments(part));
  }

  return attachments;
}

// Max attachment size to extract text from (5 MB)
const MAX_EXTRACT_SIZE = 5 * 1024 * 1024;

// MIME types we can extract text from
const EXTRACTABLE_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/html',
  'text/markdown',
  'application/json',
]);

export function createGmailReadTool(userId: string) {
  return new DynamicStructuredTool({
    name: 'gmail_read',
    description:
      'Read the full content of a Gmail message by its messageId. Returns the email body text and lists any attachments. ' +
      'Set extractAttachments=true to also extract text content from PDF and text attachments (useful for reading documents). ' +
      'Use this after gmail_search to read the full email when snippets are not enough.',
    schema: z.object({
      messageId: z.string().describe('The Gmail message ID (returned by gmail_search as messageId)'),
      extractAttachments: z
        .boolean()
        .optional()
        .default(false)
        .describe('When true, extract and return text content from PDF and text attachments (up to 5MB each)'),
    }),
    func: async ({ messageId, extractAttachments }) => {
      log.info({ messageId, extractAttachments }, 'Reading email');

      const tokens = await getGoogleTokens(userId);
      if (!tokens) {
        return JSON.stringify({
          error: 'Gmail not connected. User has not linked their Google account.',
        });
      }

      try {
        // Fetch full message
        const msgRes = await googleApiFetchWithRetry(
          userId,
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
          {},
          tokens,
        );

        if (!msgRes.ok) {
          const body = await msgRes.text().catch(() => '');
          log.error({ status: msgRes.status, messageId, googleError: body.slice(0, 500) }, 'Gmail read failed');
          return JSON.stringify({ error: `Failed to fetch message: ${msgRes.status}` });
        }

        const msgData = await msgRes.json();
        const payload = msgData.payload;

        // Extract headers
        const headers = payload?.headers || [];
        const getHeader = (name: string) =>
          headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

        // Extract body text
        const { plain, html } = extractBodyText(payload);
        const bodyText = plain || (html ? stripHtml(html) : msgData.snippet || '');

        // Collect attachment metadata
        const attachments = collectAttachments(payload);

        // Optionally extract text from attachments
        const attachmentContents: Array<{ filename: string; text: string }> = [];
        if (extractAttachments && attachments.length > 0) {
          for (const att of attachments) {
            if (!EXTRACTABLE_TYPES.has(att.mimeType) || att.size > MAX_EXTRACT_SIZE) continue;

            try {
              const attRes = await googleApiFetchWithRetry(
                userId,
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${att.attachmentId}`,
                {},
                tokens,
              );

              if (!attRes.ok) continue;

              const attData = await attRes.json();
              if (!attData.data) continue;

              // Gmail returns URL-safe base64
              const base64 = (attData.data as string).replace(/-/g, '+').replace(/_/g, '/');

              if (att.mimeType === 'application/pdf') {
                const { PDFParse } = await import('pdf-parse');
                const buffer = Buffer.from(base64, 'base64');
                const parser = new PDFParse({ data: buffer, verbosity: 0 });
                const result = await parser.getText();
                await parser.destroy();
                if (result.text?.trim()) {
                  attachmentContents.push({ filename: att.filename, text: result.text.trim() });
                }
              } else {
                // Text-based formats
                const text = Buffer.from(base64, 'base64').toString('utf-8');
                if (text.trim()) {
                  attachmentContents.push({
                    filename: att.filename,
                    text: att.mimeType === 'text/html' ? stripHtml(text) : text.trim(),
                  });
                }
              }
            } catch (err: any) {
              log.warn({ err, filename: att.filename }, 'Failed to extract attachment');
            }
          }
        }

        const result: any = {
          subject: getHeader('Subject') || '(No Subject)',
          from: getHeader('From'),
          to: getHeader('To'),
          date: getHeader('Date'),
          body: bodyText.substring(0, 50_000), // Cap body at 50k chars
          attachments: attachments.map(({ attachmentId, ...rest }) => rest),
        };

        if (attachmentContents.length > 0) {
          result.attachmentContents = attachmentContents.map((ac) => ({
            filename: ac.filename,
            text: ac.text.substring(0, 100_000), // Cap at 100k chars per attachment
          }));
        }

        log.info({ subject: result.subject, attachmentCount: attachments.length, extractedCount: attachmentContents.length }, 'Read message');
        return JSON.stringify(result);
      } catch (err: any) {
        log.error({ err }, 'Error reading email');
        return JSON.stringify({ error: err.message });
      }
    },
  });
}
