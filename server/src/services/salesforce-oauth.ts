/**
 * Salesforce token refresh for the Express server.
 *
 * Uses the OAuth client_id and client_secret stored in salesforce_credentials
 * (or the shared Connected App env vars) to refresh expired access tokens.
 * Follows the same pattern as granola-oauth.ts.
 */

import { supabase } from '../lib/supabase.js';
import { config } from '../config.js';
import { isValidSalesforceInstanceUrl } from '../../routes/salesforce.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ util: 'salesforce-oauth' });

// Salesforce OAuth error codes that mean the refresh token is permanently unusable.
// Anything else (5xx, network errors, rate limits, unknown codes) is treated as transient.
const PERMANENT_REFRESH_ERRORS = new Set([
  'invalid_grant',
  'invalid_client',
  'inactive_user',
  'inactive_org',
  'inactive_connected_app',
]);

async function markExpired(organizationId: string): Promise<void> {
  await supabase
    .from('salesforce_credentials')
    .update({ sync_status: 'expired' })
    .eq('organization_id', organizationId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Refresh a Salesforce OAuth access token using the stored refresh token.
 * Returns the new plaintext access token on success, null on failure.
 */
export async function refreshSalesforceToken(
  organizationId: string
): Promise<string | null> {
  try {
    const { data: creds, error: credsErr } = await supabase
      .from('salesforce_credentials')
      .select(
        'refresh_token_encrypted, oauth_client_id, oauth_client_secret_encrypted, instance_url'
      )
      .eq('organization_id', organizationId)
      .single();

    if (credsErr || !creds?.refresh_token_encrypted) {
      log.info({ organizationId }, 'No refresh token for org, skipping refresh');
      return null;
    }

    // Determine client credentials and decrypt tokens in parallel where possible
    let clientId: string;
    let clientSecret: string;
    let refreshToken: string;

    if (creds.oauth_client_id && creds.oauth_client_secret_encrypted) {
      // Customer-provided Connected App — decrypt both tokens in parallel
      clientId = creds.oauth_client_id;
      const [refreshResult, secretResult] = await Promise.all([
        supabase.rpc('decrypt_token', { encrypted_token: creds.refresh_token_encrypted }),
        supabase.rpc('decrypt_token', { encrypted_token: creds.oauth_client_secret_encrypted }),
      ]);
      if (refreshResult.error || !refreshResult.data) {
        log.error({ err: refreshResult.error }, 'Failed to decrypt refresh token');
        return null;
      }
      if (secretResult.error || !secretResult.data) {
        log.error({ err: secretResult.error }, 'Failed to decrypt custom client secret');
        return null;
      }
      refreshToken = refreshResult.data;
      clientSecret = secretResult.data;
    } else {
      // Shared Connected App — only need to decrypt refresh token
      if (!config.salesforceConnectedAppClientId || !config.salesforceConnectedAppClientSecret) {
        log.error('No shared Connected App credentials configured');
        return null;
      }
      clientId = config.salesforceConnectedAppClientId;
      clientSecret = config.salesforceConnectedAppClientSecret;

      const { data: decryptedRefresh, error: decryptErr } = await supabase.rpc(
        'decrypt_token',
        { encrypted_token: creds.refresh_token_encrypted }
      );
      if (decryptErr || !decryptedRefresh) {
        log.error({ err: decryptErr }, 'Failed to decrypt refresh token');
        return null;
      }
      refreshToken = decryptedRefresh;
    }

    // Exchange refresh token for new access token.
    // Retry once on transient 5xx / network errors; never retry 4xx (permanent auth
    // issues need re-consent, transient rate limits shouldn't be hammered).
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });

    let response: Response | null = null;
    let networkError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch('https://login.salesforce.com/services/oauth2/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body,
        });
        networkError = null;
        if (response.ok || response.status < 500) break;
      } catch (err) {
        networkError = err;
        response = null;
      }
      if (attempt === 0) {
        await sleep(500 + Math.floor(Math.random() * 1000));
      }
    }

    if (!response) {
      // Network error after retry — treat as transient, do not mark expired.
      log.error({ err: networkError, organizationId }, 'Token refresh network error');
      return null;
    }

    if (!response.ok) {
      let errorCode: string | undefined;
      try {
        const errJson = (await response.clone().json()) as { error?: string };
        errorCode = errJson.error;
      } catch {
        // Ignore parse failure — treat as unknown error code.
      }

      const permanent = errorCode ? PERMANENT_REFRESH_ERRORS.has(errorCode) : false;
      log.error(
        { status: response.status, errorCode, permanent, organizationId },
        'Token refresh failed'
      );

      if (permanent) {
        await markExpired(organizationId);
      }
      // Transient (5xx, rate-limit, unknown codes): leave sync_status as-is so
      // the next run can recover without forcing the user to reconnect.
      return null;
    }

    const tokens = await response.json();

    // Encrypt new access token
    const { data: encryptedAccess, error: encryptErr } = await supabase.rpc(
      'encrypt_token',
      { token: tokens.access_token }
    );
    if (encryptErr || !encryptedAccess) {
      log.error({ err: encryptErr }, 'Failed to encrypt new access token');
      return null;
    }

    const updateData: Record<string, unknown> = {
      access_token_encrypted: encryptedAccess,
      sync_status: 'active',
    };

    // Salesforce access tokens typically expire in 1-2 hours
    if (tokens.issued_at) {
      // Salesforce returns issued_at as epoch milliseconds; access tokens last ~2 hours
      updateData.token_expiry = new Date(
        Number(tokens.issued_at) + 2 * 60 * 60 * 1000
      ).toISOString();
    }

    // Salesforce may also return a new instance_url on refresh
    if (tokens.instance_url) {
      if (isValidSalesforceInstanceUrl(tokens.instance_url)) {
        updateData.instance_url = tokens.instance_url;
      } else {
        log.warn({ instanceUrl: tokens.instance_url }, 'Ignoring invalid instance_url from refresh');
      }
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
      .from('salesforce_credentials')
      .update(updateData)
      .eq('organization_id', organizationId);

    log.info({ organizationId }, 'Token refreshed');
    return tokens.access_token;
  } catch (err) {
    // Unexpected error (DB, encryption, programming bug). Do NOT mark expired —
    // that forces the user to reconnect for something unrelated to the refresh
    // token's validity. Permanent-failure classification is handled inline above.
    log.error({ err, organizationId }, 'Token refresh threw unexpectedly');
    return null;
  }
}
