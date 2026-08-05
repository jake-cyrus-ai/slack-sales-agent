/**
 * Salesforce connection manager — per-organization OAuth.
 *
 * Reads encrypted tokens from salesforce_credentials table,
 * auto-refreshes when near expiry, and caches connections in memory.
 */

import { Connection } from 'jsforce';
import { supabase } from '../lib/supabase.js';
import { config } from '../config.js';
import { refreshSalesforceToken } from '../services/salesforce-oauth.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ component: 'salesforce-client' });

interface CachedConnection {
  conn: Connection;
  expiresAt: number;
}

const connectionCache = new Map<string, CachedConnection>();
const CONNECTION_TTL_MS = 55 * 60 * 1000; // refresh before the typical 60-min session timeout
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // auto-refresh if expiring within 5 minutes

/**
 * Check if the shared Connected App env vars are set (i.e. OAuth connect flow is available).
 */
export function isSalesforceConfigured(): boolean {
  return Boolean(
    config.salesforceConnectedAppClientId &&
    config.salesforceConnectedAppClientSecret
  );
}

/**
 * Check if a specific org has an active Salesforce connection.
 */
export async function isSalesforceConfiguredForOrg(organizationId: string): Promise<boolean> {
  const { data } = await supabase
    .from('salesforce_credentials')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('sync_status', 'active')
    .maybeSingle();
  return Boolean(data);
}

/**
 * Get a jsforce Connection for the given organization.
 * Reads from salesforce_credentials, auto-refreshes if needed, caches in memory.
 */
export async function getSalesforceConnection(organizationId: string): Promise<Connection> {
  // Check in-memory cache
  const cached = connectionCache.get(organizationId);
  if (cached?.conn.accessToken && Date.now() < cached.expiresAt) {
    return cached.conn;
  }

  // Read credentials from DB
  const { data: creds, error: credsErr } = await supabase
    .from('salesforce_credentials')
    .select(
      'access_token_encrypted, refresh_token_encrypted, token_expiry, instance_url, sync_status'
    )
    .eq('organization_id', organizationId)
    .single();

  if (credsErr || !creds) {
    throw new Error(
      'Salesforce is not connected for this organization. An admin must connect Salesforce in Settings.'
    );
  }

  if (creds.sync_status !== 'active') {
    clearConnectionCache(organizationId);
    log.warn(
      { organizationId, syncStatus: creds.sync_status },
      'Salesforce credentials not active'
    );
    throw new Error(
      "Salesforce isn't reachable right now. Ask an admin to check the Salesforce integration in Settings."
    );
  }

  // Check if token needs refresh (within 5 min of expiry)
  const tokenExpiry = creds.token_expiry ? new Date(creds.token_expiry).getTime() : 0;
  const needsRefresh = tokenExpiry > 0 && Date.now() > tokenExpiry - REFRESH_BUFFER_MS;

  let accessToken: string;

  if (needsRefresh && creds.refresh_token_encrypted) {
    log.info({ organizationId }, 'Token near expiry — refreshing');
    const refreshed = await refreshSalesforceToken(organizationId);
    if (!refreshed) {
      clearConnectionCache(organizationId);
      throw new Error(
        "Salesforce isn't reachable right now. Ask an admin to check the Salesforce integration in Settings."
      );
    }
    accessToken = refreshed;
  } else {
    // Decrypt the stored access token
    const { data: decrypted, error: decryptErr } = await supabase.rpc('decrypt_token', {
      encrypted_token: creds.access_token_encrypted,
    });
    if (decryptErr || !decrypted) {
      throw new Error('Failed to decrypt Salesforce access token');
    }
    accessToken = decrypted;
  }

  const conn = new Connection({
    instanceUrl: creds.instance_url,
    accessToken,
    maxRequest: 10,
  });

  // Intercept conn.query errors to invalidate cache on auth failures (401/session
  // expired). NOTE: this wraps conn.query only, not sobject().create/.update/.destroy.
  // Most write tools self-heal because they run a resolve/dedup query first; if the
  // session is dead that query throws, the cache clears, and the next call rebuilds.
  // A write-first path with no preceding query (e.g. sfdc_create_task with no
  // who/what and a warm sfUserIdCache) will not trigger this until the 55-min TTL.
  const originalQuery = conn.query.bind(conn);
  conn.query = async function (...args: any[]) {
    try {
      return await originalQuery(...args);
    } catch (err: any) {
      if (isSessionExpiredError(err)) {
        clearConnectionCache(organizationId);
      }
      throw err;
    }
  } as unknown as typeof conn.query;

  connectionCache.set(organizationId, {
    conn,
    expiresAt: Date.now() + CONNECTION_TTL_MS,
  });

  log.info({ organizationId, instanceUrl: creds.instance_url }, 'Connection ready');
  return conn;
}

/**
 * Detect Salesforce session expiry / auth errors so callers can invalidate the cache.
 */
function isSessionExpiredError(err: any): boolean {
  const msg = (err?.message || err?.errorCode || '').toLowerCase();
  return (
    msg.includes('invalid_session_id') ||
    msg.includes('session expired') ||
    msg.includes('invalid session') ||
    err?.statusCode === 401
  );
}

/**
 * Clear the cached connection for an organization (e.g. on disconnect or refresh failure).
 */
export function clearConnectionCache(organizationId: string): void {
  connectionCache.delete(organizationId);
}
