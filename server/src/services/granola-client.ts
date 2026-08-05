/**
 * Granola MCP client factory.
 *
 * Creates authenticated MCP clients for communicating with Granola's meeting
 * notes server. Handles token decryption, refresh, and connection lifecycle.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { supabase } from '../lib/supabase.js';
import { refreshGranolaToken } from './granola-oauth.js';
import { config } from '../config.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ component: 'granola-client' });

const GRANOLA_MCP_URL = 'https://mcp.granola.ai/mcp';

/**
 * Check whether a user has active Granola credentials.
 * Lightweight check — no decryption, no MCP connection.
 * Use this to conditionally include Granola tools at agent creation time.
 */
export async function hasGranolaConnection(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('granola_credentials')
    .select('id')
    .eq('user_id', userId)
    .eq('sync_status', 'active')
    .maybeSingle();

  return !error && !!data;
}

/**
 * Build an MCP Client connected to Granola's server for the given user.
 * Returns null if the user has no active Granola credentials.
 *
 * The caller is responsible for closing the client when done via client.close().
 */
export async function getGranolaClient(userId: string): Promise<Client | null> {
  try {
    const supabaseProjectRef = (() => {
      try {
        return new URL(config.supabaseUrl).host.split('.')[0];
      } catch {
        return 'unknown';
      }
    })();

    // 1. Fetch encrypted credentials
    const { data: credentials, error } = await supabase
      .from('granola_credentials')
      .select('access_token_encrypted, refresh_token_encrypted, token_expiry')
      .eq('user_id', userId)
      .eq('sync_status', 'active')
      .single();

    if (error || !credentials) {
      const { data: anyCredentials } = await supabase
        .from('granola_credentials')
        .select('sync_status, updated_at')
        .eq('user_id', userId)
        .maybeSingle();

      if (anyCredentials) {
        log.info(
          { userId, status: anyCredentials.sync_status, project: supabaseProjectRef },
          'Granola credentials found but not active'
        );
      } else {
        log.info(
          { userId, project: supabaseProjectRef },
          'No Granola credentials row for user'
        );
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
        accessToken = await refreshGranolaToken(userId, credentials.refresh_token_encrypted);
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
      new URL(GRANOLA_MCP_URL),
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

// ─── Per-request shared client scope ────────────────────────────────────────

/**
 * A scope that lazily creates one MCP client per user and reuses it across
 * multiple Granola tool calls within a single agent invocation.
 *
 * Usage:
 *   const scope = new GranolaClientScope();
 *   // pass scope to all granola tool factories
 *   // after agent run completes:
 *   await scope.closeAll();
 */
export class GranolaClientScope {
  private clients = new Map<string, Promise<Client | null>>();

  /** Get or create a shared client for this user within this scope. */
  get(userId: string): Promise<Client | null> {
    const existing = this.clients.get(userId);
    if (existing) return existing;

    const promise = getGranolaClient(userId).catch((err) => {
      // Don't cache failed connections — allow retry on next tool call
      this.clients.delete(userId);
      throw err;
    });
    this.clients.set(userId, promise);
    return promise;
  }

  /** Close all clients opened during this scope. Call after agent run. */
  async closeAll(): Promise<void> {
    const entries = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(
      entries.map(async (p) => {
        const client = await p;
        if (client) await client.close().catch(() => {});
      })
    );
  }
}
