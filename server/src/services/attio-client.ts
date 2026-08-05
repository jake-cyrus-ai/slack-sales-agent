/**
 * Attio MCP client factory.
 *
 * Creates authenticated MCP clients for communicating with Attio's CRM
 * server. Handles token decryption, refresh, and connection lifecycle.
 * Mirrors the Granola client pattern (granola-client.ts).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { supabase } from '../lib/supabase.js';
import { refreshAttioToken } from './attio-oauth.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ component: 'attio-client' });

const ATTIO_MCP_URL = 'https://mcp.attio.com/mcp';

/**
 * Check whether an organization has active Attio credentials.
 * Lightweight check — no decryption, no MCP connection.
 */
export async function hasAttioConnection(organizationId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('attio_credentials')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .maybeSingle();

  return !error && !!data;
}

/**
 * Build an MCP Client connected to Attio's server for the given organization.
 * Returns null if the org has no active Attio credentials.
 *
 * The caller is responsible for closing the client when done via client.close().
 */
export async function getAttioClient(organizationId: string): Promise<Client | null> {
  try {
    // 1. Fetch encrypted credentials
    const { data: credentials, error } = await supabase
      .from('attio_credentials')
      .select('access_token_encrypted, refresh_token_encrypted, token_expiry')
      .eq('organization_id', organizationId)
      .eq('status', 'active')
      .single();

    if (error || !credentials) {
      const { data: anyCredentials } = await supabase
        .from('attio_credentials')
        .select('status, updated_at')
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (anyCredentials) {
        log.info(
          { organizationId, status: anyCredentials.status },
          'Attio credentials found but not active'
        );
      } else {
        log.info({ organizationId }, 'No Attio credentials row for org');
      }
      return null;
    }

    // 2. Check if token is expired and try to refresh
    let accessToken: string | null = null;

    if (credentials.token_expiry) {
      const expiresAt = new Date(credentials.token_expiry);
      const now = new Date();
      const isExpired = expiresAt.getTime() - now.getTime() < 5 * 60 * 1000;

      if (isExpired && credentials.refresh_token_encrypted) {
        accessToken = await refreshAttioToken(organizationId, credentials.refresh_token_encrypted);
      }
    }

    // 3. If not refreshed, decrypt the stored access token
    if (!accessToken) {
      const { data: decrypted, error: decryptErr } = await supabase.rpc('decrypt_token', {
        encrypted_token: credentials.access_token_encrypted,
      });

      if (decryptErr || !decrypted) {
        log.error({ err: decryptErr }, 'Failed to decrypt access token');
        return null;
      }

      accessToken = decrypted;
    }

    // 4. Create MCP transport with bearer token
    const transport = new StreamableHTTPClientTransport(
      new URL(ATTIO_MCP_URL),
      {
        requestInit: {
          headers: { 'Authorization': `Bearer ${accessToken}` },
        },
      }
    );

    // 5. Create and connect MCP client
    const client = new Client({ name: 'agent-ai', version: '1.0.0' });
    await client.connect(transport);

    return client;
  } catch (err) {
    log.error({ err }, 'Error building MCP client');
    return null;
  }
}
