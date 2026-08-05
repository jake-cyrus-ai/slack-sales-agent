/**
 * Granola token refresh for the Express server.
 *
 * Uses the OAuth client_id and token_endpoint stored in granola_credentials
 * (set by the granola-callback edge function) to refresh expired access tokens.
 * No MCP SDK needed — just a standard OAuth2 refresh_token grant.
 */

import { supabase } from '../lib/supabase.js';
import { logger } from '../../lib/logger';

const log = logger.child({ util: 'granola-oauth' });

function classifyOAuthRefreshError(body: string): { status: 'expired' | null; message: string } {
  try {
    const parsed = JSON.parse(body);
    const code = typeof parsed.error === 'string' ? parsed.error : null;
    const message = parsed.error_description || body;
    const isPermanent = code === 'invalid_grant' || code === 'invalid_client';
    return { status: isPermanent ? 'expired' : null, message };
  } catch {
    return { status: null, message: body };
  }
}

/**
 * Refresh a Granola OAuth access token using the stored refresh token.
 * Returns the new plaintext access token on success, null on failure.
 */
export async function refreshGranolaToken(
  userId: string,
  encryptedRefreshToken: string
): Promise<string | null> {
  try {
    // Get the OAuth client metadata stored during initial auth
    const { data: creds, error: credsErr } = await supabase
      .from('granola_credentials')
      .select('oauth_client_id, oauth_client_secret, oauth_token_endpoint')
      .eq('user_id', userId)
      .single();

    if (credsErr || !creds?.oauth_client_id || !creds?.oauth_token_endpoint) {
      log.info({ userId }, 'No OAuth client metadata for user, skipping refresh');
      return null;
    }

    // Decrypt the refresh token
    const { data: refreshToken, error: decryptErr } = await supabase.rpc('decrypt_token', {
      encrypted_token: encryptedRefreshToken,
    });
    if (decryptErr || !refreshToken) {
      log.error({ err: decryptErr, userId }, 'Failed to decrypt refresh token');
      return null;
    }

    // Decrypt client secret if present (encrypted at rest like other tokens)
    let clientSecret: string | null = null;
    if (creds.oauth_client_secret) {
      const { data: decrypted, error: decryptSecretErr } = await supabase.rpc('decrypt_token', {
        encrypted_token: creds.oauth_client_secret,
      });
      if (!decryptSecretErr && decrypted) {
        clientSecret = decrypted;
      }
    }

    // Exchange refresh token for new access token
    const params: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: creds.oauth_client_id,
    };

    if (clientSecret) {
      params.client_secret = clientSecret;
    }

    const response = await fetch(creds.oauth_token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(params),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const { status: newStatus, message } = classifyOAuthRefreshError(errorText);

      log.error(
        { userId, httpStatus: response.status, errorMessage: message, transient: newStatus === null },
        'Granola token refresh failed'
      );

      const update: Record<string, unknown> = {
        last_error: message,
        last_error_at: new Date().toISOString(),
      };
      if (newStatus) update.sync_status = newStatus;

      await supabase
        .from('granola_credentials')
        .update(update)
        .eq('user_id', userId);

      return null;
    }

    const tokens = await response.json();

    // Encrypt new access token
    const { data: encryptedAccess, error: encryptErr } = await supabase.rpc(
      'encrypt_token',
      { token: tokens.access_token }
    );
    if (encryptErr || !encryptedAccess) {
      log.error({ err: encryptErr, userId }, 'Failed to encrypt new access token');
      return null;
    }

    const updateData: Record<string, unknown> = {
      access_token_encrypted: encryptedAccess,
      sync_status: 'active',
      last_error: null,
      last_error_at: null,
    };

    if (tokens.expires_in) {
      updateData.token_expiry = new Date(
        Date.now() + tokens.expires_in * 1000
      ).toISOString();
    }

    // If a new refresh token was issued, store it too
    if (tokens.refresh_token) {
      const { data: encryptedNewRefresh } = await supabase.rpc('encrypt_token', {
        token: tokens.refresh_token,
      });
      if (encryptedNewRefresh) {
        updateData.refresh_token_encrypted = encryptedNewRefresh;
      }
    }

    await supabase
      .from('granola_credentials')
      .update(updateData)
      .eq('user_id', userId);

    log.info({ userId }, 'Token refreshed');
    return tokens.access_token;
  } catch (err) {
    // Network/runtime errors are transient — do NOT mark creds expired.
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, userId }, 'Granola token refresh threw (transient)');

    await supabase
      .from('granola_credentials')
      .update({
        last_error: message,
        last_error_at: new Date().toISOString(),
      })
      .eq('user_id', userId);

    return null;
  }
}
