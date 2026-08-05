/**
 * Google OAuth token management.
 * Ported from _shared/google-auth-helper.ts.
 */

import { supabase } from '../lib/supabase.js';
import { config } from '../config.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ component: 'token-manager' });

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  calendarEmail: string;
}

/**
 * Get Google OAuth tokens for a user, auto-refreshing if needed.
 */
export async function getGoogleTokens(userId: string): Promise<GoogleTokens | null> {
  try {
    const { data: credentials, error } = await supabase
      .from('calendar_credentials')
      .select('access_token_encrypted, refresh_token_encrypted, token_expiry, calendar_email, sync_status')
      .eq('user_id', userId)
      .in('sync_status', ['active', 'expired'])
      .order('connected_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !credentials) {
      log.info({ userId }, 'No active Google credentials for user');
      return null;
    }

    // If status is expired (legacy from old error handling), attempt refresh
    // but don't block on active credentials being required
    if (credentials.sync_status === 'expired') {
      log.info({ userId }, 'Credentials expired, attempting refresh...');
    }

    // Decrypt tokens via RPC (one call per token)
    const { data: accessToken, error: accessError } = await supabase.rpc('decrypt_token', {
      encrypted_token: credentials.access_token_encrypted,
    });

    const { data: refreshToken, error: refreshError } = await supabase.rpc('decrypt_token', {
      encrypted_token: credentials.refresh_token_encrypted,
    });

    if (accessError || refreshError || !accessToken || !refreshToken) {
      log.error({ err: accessError || refreshError }, 'Failed to decrypt tokens');
      return null;
    }

    const expiresAt = new Date(credentials.token_expiry);
    const now = new Date();

    // Refresh if expired or within 5 minutes of expiry
    if (expiresAt.getTime() - now.getTime() < 5 * 60 * 1000) {
      log.info('Token expired or expiring, refreshing...');
      return await refreshGoogleToken(userId, refreshToken, credentials.calendar_email);
    }

    return {
      accessToken,
      refreshToken,
      expiresAt,
      calendarEmail: credentials.calendar_email,
    };
  } catch (err) {
    log.error({ err }, 'Error getting Google tokens');
    return null;
  }
}

async function refreshGoogleToken(
  userId: string,
  refreshToken: string,
  calendarEmail: string
): Promise<GoogleTokens | null> {
  if (!config.googleClientId || !config.googleClientSecret) {
    log.error('Cannot refresh token: GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not configured');
    return null;
  }

  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorJson: { error?: string; error_description?: string };
      try {
        errorJson = JSON.parse(errorText);
      } catch {
        errorJson = { error: errorText };
      }

      const errorCode = errorJson.error || 'UNKNOWN_ERROR';
      log.error({ status: response.status, errorCode, errorText }, 'Token refresh failed');

      // Only mark credentials as needing re-auth for permanent failures
      if (errorCode === 'invalid_grant' || errorCode === 'invalid_client') {
        await supabase
          .from('calendar_credentials')
          .update({
            sync_status: 'auth_required',
            last_error: errorCode === 'invalid_grant'
              ? 'Refresh token invalid or revoked - please re-connect Gmail'
              : 'OAuth client credentials mismatch - please re-connect Gmail',
            last_error_at: new Date().toISOString(),
          })
          .eq('user_id', userId);
      } else {
        // Transient failure — log but don't change sync_status so next attempt can retry
        await supabase
          .from('calendar_credentials')
          .update({
            last_error: `Token refresh failed: ${errorCode}`,
            last_error_at: new Date().toISOString(),
          })
          .eq('user_id', userId);
      }

      return null;
    }

    const data = await response.json();
    const newExpiresAt = new Date(Date.now() + data.expires_in * 1000);

    // Encrypt the new access token
    const { data: encryptedAccess, error: encryptError } = await supabase.rpc('encrypt_token', {
      token: data.access_token,
    });

    if (encryptError || !encryptedAccess) {
      log.error({ err: encryptError }, 'Failed to encrypt new token');
      return null;
    }

    await supabase
      .from('calendar_credentials')
      .update({
        access_token_encrypted: encryptedAccess,
        token_expiry: newExpiresAt.toISOString(),
        sync_status: 'active',
        last_error: null,
        last_error_at: null,
      })
      .eq('user_id', userId);

    log.info('Token refreshed successfully');

    return {
      accessToken: data.access_token,
      refreshToken,
      expiresAt: newExpiresAt,
      calendarEmail,
    };
  } catch (err) {
    log.error({ err }, 'Error refreshing token');
    return null;
  }
}

/**
 * Make an authenticated Google API request.
 */
export async function googleApiFetch(
  url: string,
  accessToken: string,
  init: RequestInit = {}
): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
}

/**
 * Force-refresh a user's Google access token regardless of the cached expiry.
 * Returns fresh tokens on success, null on failure. Used to recover from
 * transient 401s where the access token appears valid by expiry but Google
 * rejects it (propagation lag, silent rotation, etc.).
 */
export async function forceRefreshGoogleTokens(userId: string): Promise<GoogleTokens | null> {
  const { data: credentials, error } = await supabase
    .from('calendar_credentials')
    .select('refresh_token_encrypted, calendar_email, sync_status')
    .eq('user_id', userId)
    .in('sync_status', ['active', 'expired'])
    .single();

  if (error || !credentials) {
    log.warn({ userId }, 'Cannot force-refresh: no active credentials');
    return null;
  }

  const { data: refreshToken, error: decryptErr } = await supabase.rpc('decrypt_token', {
    encrypted_token: credentials.refresh_token_encrypted,
  });

  if (decryptErr || !refreshToken) {
    log.error({ err: decryptErr, userId }, 'Force-refresh: failed to decrypt refresh token');
    return null;
  }

  return refreshGoogleToken(userId, refreshToken, credentials.calendar_email);
}

/**
 * Fetch a Google API URL with automatic token-refresh retry on 401.
 *
 * Why: Google occasionally returns 401 on freshly-minted access tokens
 * (propagation lag, internal rotation). Rather than surface this to the user
 * as "please resync", we force a refresh and retry once. Only a persistent
 * 401 after refresh indicates a real auth problem (revoked scopes, explicit
 * revocation) that the user must address.
 *
 * On any 401, Google's response body is logged so we can distinguish
 * `authError` (transient / bad token) from `insufficientPermissions` (scope
 * issue requiring re-consent).
 */
export async function googleApiFetchWithRetry(
  userId: string,
  url: string,
  init: RequestInit = {},
  cachedTokens?: GoogleTokens,
): Promise<Response> {
  const tokens = cachedTokens ?? (await getGoogleTokens(userId));
  if (!tokens) {
    return new Response(
      JSON.stringify({ error: 'no_tokens', error_description: 'User has not connected Google or credentials are invalid.' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const firstRes = await googleApiFetch(url, tokens.accessToken, init);
  if (firstRes.status !== 401) return firstRes;

  const firstBody = await firstRes.text().catch(() => '');
  log.warn(
    { userId, url, googleError: firstBody.slice(0, 500) },
    'Google 401 on first attempt; forcing token refresh and retrying once',
  );

  const refreshed = await forceRefreshGoogleTokens(userId);
  if (!refreshed) {
    return new Response(firstBody, { status: 401, headers: firstRes.headers });
  }

  const retryRes = await googleApiFetch(url, refreshed.accessToken, init);
  if (retryRes.status === 401) {
    const retryBody = await retryRes.text().catch(() => '');
    log.error(
      { userId, url, googleError: retryBody.slice(0, 500) },
      'Google 401 persisted after forced refresh — likely scope revocation or consent issue',
    );
    return new Response(retryBody, { status: 401, headers: retryRes.headers });
  }

  return retryRes;
}
