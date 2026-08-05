/**
 * Google API client factory.
 *
 * Creates authenticated Gmail, Calendar, and Drive clients using the
 * `googleapis` SDK. Token refresh is handled automatically by OAuth2Client.
 */

import { google, gmail_v1, calendar_v3, drive_v3 } from 'googleapis';
import { CalendarClient } from './safe-calendar-client.js';
import { OAuth2Client } from 'google-auth-library';
import { supabase } from '../lib/supabase.js';
import { config } from '../config.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ component: 'google-client' });

/**
 * Build an OAuth2Client for the given user, seeded with their stored tokens.
 * The client handles automatic token refresh — when it refreshes, we persist
 * the new access token back to the database.
 */
export async function getOAuth2Client(userId: string): Promise<OAuth2Client | null> {
  try {
    const { data: credentials, error } = await supabase
      .from('calendar_credentials')
      .select('access_token_encrypted, refresh_token_encrypted, token_expiry, calendar_email')
      .eq('user_id', userId)
      .eq('sync_status', 'active')
      .order('connected_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !credentials) {
      log.info({ userId }, 'No active Google credentials for user');
      return null;
    }

    const [
      { data: accessToken, error: accessError },
      { data: refreshToken, error: refreshError },
    ] = await Promise.all([
      supabase.rpc('decrypt_token', { encrypted_token: credentials.access_token_encrypted }),
      supabase.rpc('decrypt_token', { encrypted_token: credentials.refresh_token_encrypted }),
    ]);

    if (accessError || refreshError || !accessToken || !refreshToken) {
      log.error({ err: accessError || refreshError }, 'Failed to decrypt tokens');
      return null;
    }

    const oauth2 = new OAuth2Client(config.googleClientId, config.googleClientSecret);
    oauth2.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
      expiry_date: new Date(credentials.token_expiry).getTime(),
    });

    // Persist refreshed tokens automatically
    oauth2.on('tokens', async (tokens) => {
      log.info('Token refreshed, persisting...');
      if (tokens.access_token) {
        const { data: encrypted, error: encErr } = await supabase.rpc('encrypt_token', {
          token: tokens.access_token,
        });
        if (!encErr && encrypted) {
          await supabase
            .from('calendar_credentials')
            .update({
              access_token_encrypted: encrypted,
              token_expiry: tokens.expiry_date
                ? new Date(tokens.expiry_date).toISOString()
                : new Date(Date.now() + 3600 * 1000).toISOString(),
            })
            .eq('user_id', userId);
        }
      }
    });

    return oauth2;
  } catch (err) {
    log.error({ err }, 'Error building OAuth2Client');
    return null;
  }
}

/** Convenience: get the calendar_email for a user. */
export async function getCalendarEmail(userId: string): Promise<string | null> {
  const { data } = await supabase
    .from('calendar_credentials')
    .select('calendar_email')
    .eq('user_id', userId)
    .eq('sync_status', 'active')
    .order('connected_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.calendar_email ?? null;
}

// ─── Typed client helpers ────────────────────────────────────────────────────

export async function getGmailClient(userId: string): Promise<{ gmail: gmail_v1.Gmail; email: string; displayName: string | null } | null> {
  const auth = await getOAuth2Client(userId);
  if (!auth) return null;
  const email = await getCalendarEmail(userId);
  if (!email) return null;
  const gmail = google.gmail({ version: 'v1', auth });

  const displayName = await getGoogleDisplayName(auth, gmail);
  return { gmail, email, displayName };
}

/**
 * Resolve the user's real name from Google. Tries (in order):
 * 1. Gmail sendAs settings (requires gmail.settings.basic or gmail.readonly)
 * 2. Google OAuth2 userinfo endpoint (requires profile or userinfo.profile scope)
 * 3. Returns null if neither works.
 */
export async function getGoogleDisplayName(auth: OAuth2Client, gmail: gmail_v1.Gmail): Promise<string | null> {
  // Try sendAs first (most accurate — it's what Gmail actually uses for From)
  try {
    const sendAs = await gmail.users.settings.sendAs.list({ userId: 'me' });
    const primary = sendAs.data.sendAs?.find((a) => a.isPrimary);
    if (primary?.displayName) return primary.displayName;
  } catch {
    // Scope not available, fall through
  }

  // Try Google userinfo endpoint
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth });
    const info = await oauth2.userinfo.get();
    if (info.data.name) return info.data.name;
  } catch {
    // Scope not available, fall through
  }

  return null;
}

export async function getCalendarClient(userId: string): Promise<CalendarClient | null> {
  const auth = await getOAuth2Client(userId);
  if (!auth) return null;
  return new CalendarClient(google.calendar({ version: 'v3', auth }));
}

export async function getDriveClient(userId: string): Promise<drive_v3.Drive | null> {
  const auth = await getOAuth2Client(userId);
  if (!auth) return null;
  return google.drive({ version: 'v3', auth });
}

// ─── Attachment helpers ──────────────────────────────────────────────────────

export interface GmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  data: Buffer;
}

/**
 * Download all attachments from a Gmail message.
 */
export async function getMessageAttachments(
  gmail: gmail_v1.Gmail,
  messageId: string
): Promise<GmailAttachment[]> {
  const msg = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const parts = msg.data.payload?.parts || [];
  const attachmentParts = parts.filter((p) => p.filename && p.filename.length > 0 && p.body?.attachmentId);

  const attachments: GmailAttachment[] = [];
  for (const part of attachmentParts) {
    const att = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: part.body!.attachmentId!,
    });

    if (att.data.data) {
      // Gmail returns base64url-encoded data
      const buffer = Buffer.from(att.data.data, 'base64url');
      attachments.push({
        filename: part.filename!,
        mimeType: part.mimeType || 'application/octet-stream',
        size: buffer.length,
        data: buffer,
      });
    }
  }

  return attachments;
}
