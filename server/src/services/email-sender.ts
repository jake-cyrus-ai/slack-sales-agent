/**
 * Email Sender — shared helper for sending emails via Gmail API.
 * Used by web approval routes and Inngest email-actions.
 */

import { getGoogleTokens, googleApiFetch } from './token-manager.js';

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, '');
}

function buildRfc2822Message(to: string, subject: string, body: string): string {
  return [
    `To: ${sanitizeHeaderValue(to)}`,
    `Subject: ${sanitizeHeaderValue(subject)}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
  ].join('\r\n');
}

export async function sendEmailDirect(
  userId: string,
  to: string,
  subject: string,
  body: string,
): Promise<void> {
  const tokens = await getGoogleTokens(userId);
  if (!tokens) {
    throw new Error('Gmail not connected — user must re-authenticate.');
  }

  const raw = buildRfc2822Message(to, subject, body);
  const encodedMessage = Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await googleApiFetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    tokens.accessToken,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: encodedMessage }),
    },
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gmail send failed (${res.status}): ${errText}`);
  }
}
