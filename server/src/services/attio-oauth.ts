/**
 * Attio token refresh for the Express server.
 *
 * Uses the OAuth client_id and token_endpoint stored in attio_credentials
 * (set by the attio-callback route) to refresh expired access tokens.
 * Mirrors the Granola refresh pattern (granola-oauth.ts).
 */

import { supabase } from '../lib/supabase.js';
import { logger } from '../../lib/logger';

const log = logger.child({ util: 'attio-oauth' });

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
 * Refresh an Attio OAuth access token using the stored refresh token.
 * Returns the new plaintext access token on success, null on failure.
 */
export async function refreshAttioToken(
  organizationId: string,
  encryptedRefreshToken: string
): Promise<string | null> {
  try {
    // Get the OAuth client metadata stored during initial auth
    const { data: creds, error: credsErr } = await supabase
      .from('attio_credentials')
      .select('oauth_client_id, oauth_client_secret, oauth_token_endpoint')
      .eq('organization_id', organizationId)
      .single();

    if (credsErr || !creds?.oauth_client_id || !creds?.oauth_token_endpoint) {
      log.info({ organizationId }, 'No OAuth client metadata for org, skipping refresh');
      return null;
    }

    // Decrypt tokens in parallel when both exist
    let refreshToken: string;
    let clientSecret: string | null = null;

    if (creds.oauth_client_secret) {
      const [refreshResult, secretResult] = await Promise.all([
        supabase.rpc('decrypt_token', { encrypted_token: encryptedRefreshToken }),
        supabase.rpc('decrypt_token', { encrypted_token: creds.oauth_client_secret }),
      ]);
      if (refreshResult.error || !refreshResult.data) {
        log.error({ err: refreshResult.error, organizationId }, 'Failed to decrypt refresh token');
        return null;
      }
      refreshToken = refreshResult.data;
      if (!secretResult.error && secretResult.data) {
        clientSecret = secretResult.data;
      }
    } else {
      const { data, error: decryptErr } = await supabase.rpc('decrypt_token', {
        encrypted_token: encryptedRefreshToken,
      });
      if (decryptErr || !data) {
        log.error({ err: decryptErr, organizationId }, 'Failed to decrypt refresh token');
        return null;
      }
      refreshToken = data;
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
        { organizationId, httpStatus: response.status, errorMessage: message, transient: newStatus === null },
        'Attio token refresh failed'
      );

      const update: Record<string, unknown> = {
        last_error: message,
        last_error_at: new Date().toISOString(),
      };
      if (newStatus) update.status = newStatus;

      await supabase
        .from('attio_credentials')
        .update(update)
        .eq('organization_id', organizationId);

      return null;
    }

    const tokens = await response.json();

    // Encrypt new access token
    const { data: encryptedAccess, error: encryptErr } = await supabase.rpc(
      'encrypt_token',
      { token: tokens.access_token }
    );
    if (encryptErr || !encryptedAccess) {
      log.error({ err: encryptErr, organizationId }, 'Failed to encrypt new access token');
      return null;
    }

    const updateData: Record<string, unknown> = {
      access_token_encrypted: encryptedAccess,
      status: 'active',
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
      .from('attio_credentials')
      .update(updateData)
      .eq('organization_id', organizationId);

    log.info({ organizationId }, 'Token refreshed');
    return tokens.access_token;
  } catch (err) {
    // Network/runtime errors are transient — do NOT mark creds expired.
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, organizationId }, 'Attio token refresh threw (transient)');

    await supabase
      .from('attio_credentials')
      .update({
        last_error: message,
        last_error_at: new Date().toISOString(),
      })
      .eq('organization_id', organizationId);

    return null;
  }
}
