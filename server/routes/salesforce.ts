/**
 * Salesforce routes:
 *   POST /api/salesforce/query          — runs the Salesforce ReAct agent
 *   POST /api/salesforce/oauth/initiate — initiate OAuth Authorization Code + PKCE flow
 *   GET  /api/salesforce/oauth/callback — handle Salesforce redirect
 *   POST /api/salesforce/oauth/disconnect — revoke & remove credentials
 *   GET  /api/salesforce/oauth/status   — connection status for current org
 */

import { Router, Response, NextFunction } from 'express';
import { getAuth, requireAuth } from '../lib/auth';
import crypto from 'crypto';
import type { Request } from '../types';
import { runSalesforceAgent, isSalesforceConfiguredForOrg } from '../src/salesforce/index.js';
import { isSalesforceConfigured, clearConnectionCache } from '../src/salesforce/client.js';
import { config } from '../src/config.js';
import { supabase } from '../src/lib/supabase.js';
import { fetchSalesforceIdentity } from '../src/services/salesforce-identity.js';
import type { Logger } from 'pino';

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveOrgId(organizationId: string, log?: Logger): Promise<string | null> {
  const { data: org, error } = await supabase
    .from('organizations')
    .select('id')
    .eq('id', organizationId)
    .maybeSingle();
  if (error) {
    if (log) {
      log.error({ err: error }, 'Error resolving organization');
    }
    return null;
  }
  return org?.id ?? null;
}

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

function getServerBaseUrl(): string {
  return process.env.SERVER_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
}

// Fixed allowlist of short error codes surfaced to the frontend. Provider
// error_description strings stay server-side only.
const SALESFORCE_AUTH_ERROR_CODES = new Set([
  'access_denied',
  'invalid_request',
  'server_error',
  'temporarily_unavailable',
  'app_not_installed',
  'instance_conflict',
]);

function mapSalesforceAuthError(raw: string): string {
  if (raw === 'OAUTH_EC_APP_NOT_FOUND') return 'app_not_installed';
  return SALESFORCE_AUTH_ERROR_CODES.has(raw) ? raw : 'connection_failed';
}

export function isValidSalesforceInstanceUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host.endsWith('.salesforce.com') ||
      host.endsWith('.force.com') ||
      host.endsWith('.salesforce.mil')
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// POST /query — Salesforce agent (authenticated, org-scoped)
// ---------------------------------------------------------------------------

router.post('/query', requireAuth(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = getAuth(req);
    const activeOrgId = auth.orgId;
    if (!activeOrgId) {
      return res.status(400).json({ error: 'No organization selected', requestId: req.id });
    }

    const organizationId = await resolveOrgId(activeOrgId, req.log);
    if (!organizationId) {
      return res.status(404).json({ error: 'Organization not found', requestId: req.id });
    }

    const { query, history } = req.body;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({
        error: 'Missing required field: query',
        requestId: req.id,
      });
    }

    const isConfigured = await isSalesforceConfiguredForOrg(organizationId);
    if (!isConfigured) {
      return res.status(503).json({
        error: 'Salesforce is not connected for this organization. An admin must connect Salesforce in Settings.',
        requestId: req.id,
      });
    }

    const conversationHistory: Array<{ role: string; content: string }> = [];
    if (Array.isArray(history)) {
      for (const msg of history) {
        if (msg && typeof msg.role === 'string' && typeof msg.content === 'string') {
          conversationHistory.push({ role: msg.role, content: msg.content });
        }
      }
    }

    req.log.info({ query, organizationId, historyLength: conversationHistory.length }, 'Salesforce agent query');

    const result = await runSalesforceAgent({
      query,
      organizationId,
      history: conversationHistory,
    });

    req.log.info('Salesforce agent completed');

    res.json({
      response: result.response,
      requestId: req.id,
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// POST /oauth/prepare — Pre-store custom app credentials (keeps secrets out of URLs)
// ---------------------------------------------------------------------------

router.post('/oauth/prepare', requireAuth(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = getAuth(req);
    const userId = auth.userId;
    const activeOrgId = auth.orgId;
    const orgRole = auth.orgRole;

    if (!activeOrgId || !userId) {
      return res.status(400).json({ error: 'No organization selected' });
    }

    if (orgRole !== 'org:owner' && !orgRole?.includes('admin')) {
      return res.status(403).json({ error: 'Only organization admins can connect Salesforce' });
    }

    const organizationId = await resolveOrgId(activeOrgId, req.log);
    if (!organizationId) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const { custom_client_id, custom_client_secret } = req.body;
    if (!custom_client_id || !custom_client_secret) {
      return res.status(400).json({ error: 'custom_client_id and custom_client_secret are required' });
    }

    // Encrypt the client secret
    const { data: encrypted, error: encryptErr } = await supabase.rpc('encrypt_token', {
      token: custom_client_secret,
    });
    if (encryptErr || !encrypted) {
      return res.status(500).json({ error: 'Failed to encrypt client secret' });
    }

    // Generate a short-lived prepare token
    const prepareToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 minutes

    const { error: insertErr } = await supabase.from('salesforce_oauth_pending').insert({
      state: prepareToken,
      organization_id: organizationId,
      user_id: userId,
      code_verifier: '__prepare__', // sentinel — not a real PKCE verifier yet
      use_custom_app: true,
      custom_client_id: custom_client_id,
      custom_client_secret_encrypted: encrypted,
      redirect_uri: '', // will be set in /connect
      expires_at: expiresAt,
    });

    if (insertErr) {
      req.log.error({ err: insertErr }, 'Failed to store prepare token');
      return res.status(500).json({ error: 'Failed to prepare custom credentials' });
    }

    res.json({ prepareToken });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// POST /oauth/initiate — Initiate Salesforce OAuth flow
// Returns the Salesforce authorize URL as JSON so the frontend can redirect.
// (Browser navigations don't carry the Authorization header, so this must be
// a fetch-based POST — not a GET that redirects.)
// ---------------------------------------------------------------------------

router.post('/oauth/initiate', requireAuth(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = getAuth(req);
    const userId = auth.userId;
    const activeOrgId = auth.orgId;
    const orgRole = auth.orgRole;

    if (!activeOrgId || !userId) {
      return res.status(400).json({ error: 'No organization selected' });
    }

    // Only admins/owners can connect (supports custom membership roles containing "admin")
    if (orgRole !== 'org:owner' && !orgRole?.includes('admin')) {
      return res.status(403).json({ error: 'Only organization admins can connect Salesforce' });
    }

    const organizationId = await resolveOrgId(activeOrgId, req.log);
    if (!organizationId) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    // Determine client credentials — check for a prepare token first (custom app flow)
    const prepareToken = req.body.prepare_token as string | undefined;
    let useCustomApp = false;
    let customClientId: string | undefined;
    let customClientSecretEncrypted: string | null = null;

    if (prepareToken) {
      // Atomically consume the prepare row (DELETE ... RETURNING) so the token
      // can never be replayed, and the org-scoped eq() guard blocks cross-org reuse.
      const { data: prepared, error: prepErr } = await supabase
        .from('salesforce_oauth_pending')
        .delete()
        .eq('state', prepareToken)
        .eq('organization_id', organizationId)
        .eq('code_verifier', '__prepare__')
        .select()
        .maybeSingle();

      if (prepErr || !prepared) {
        return res.status(400).json({ error: 'Invalid or expired prepare token' });
      }

      if (new Date(prepared.expires_at) < new Date()) {
        return res.status(400).json({ error: 'Prepare token expired. Please try again.' });
      }

      useCustomApp = true;
      customClientId = prepared.custom_client_id;
      customClientSecretEncrypted = prepared.custom_client_secret_encrypted;
    }

    let clientId: string;
    if (useCustomApp && customClientId) {
      clientId = customClientId;
    } else {
      if (!config.salesforceConnectedAppClientId) {
        return res.status(503).json({ error: 'Shared Salesforce Connected App is not configured on the server' });
      }
      clientId = config.salesforceConnectedAppClientId;
    }

    // Generate PKCE + state
    const { codeVerifier, codeChallenge } = generatePKCE();
    const state = crypto.randomUUID();
    const redirectUri = `${getServerBaseUrl()}/api/salesforce/oauth/callback`;

    // Store pending OAuth state
    const { error: insertErr } = await supabase.from('salesforce_oauth_pending').insert({
      state,
      organization_id: organizationId,
      user_id: userId,
      code_verifier: codeVerifier,
      use_custom_app: useCustomApp,
      custom_client_id: useCustomApp ? customClientId : null,
      custom_client_secret_encrypted: customClientSecretEncrypted,
      redirect_uri: redirectUri,
    });

    if (insertErr) {
      req.log.error({ err: insertErr }, 'Failed to store pending state');
      return res.status(500).json({ error: 'Failed to initiate OAuth flow' });
    }

    // Build Salesforce authorize URL
    const authorizeUrl = new URL('https://login.salesforce.com/services/oauth2/authorize');
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('scope', 'api refresh_token');

    req.log.info({ organizationId }, 'Salesforce OAuth initiated');
    res.json({ authUrl: authorizeUrl.toString() });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// GET /oauth/callback — Handle Salesforce redirect
// ---------------------------------------------------------------------------

router.get('/oauth/callback', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code, state, error: oauthError, error_description } = req.query;
    const frontendUrl = process.env.VITE_APP_URL || 'http://localhost:5173';

    if (oauthError) {
      // Log the full provider description server-side; never forward it to the
      // frontend — Salesforce error_description may contain reflected client_id,
      // endpoint hints, or other internal details.
      req.log.error({ oauthError, error_description }, 'Salesforce authorization denied');
      const short = mapSalesforceAuthError(String(oauthError));
      const appNotInstalled = String(oauthError) === 'OAUTH_EC_APP_NOT_FOUND'
        ? '&salesforce_error_code=app_not_installed'
        : '';
      return res.redirect(`${frontendUrl}/profile?salesforce_error=${short}${appNotInstalled}`);
    }

    if (!code || !state) {
      return res.status(400).json({ error: 'Missing code or state parameter' });
    }

    // Atomically consume pending state (DELETE ... RETURNING) so the same
    // `state` can never be replayed, even if any step below fails.
    const { data: pending, error: pendingErr } = await supabase
      .from('salesforce_oauth_pending')
      .delete()
      .eq('state', state)
      .select()
      .maybeSingle();

    if (pendingErr || !pending) {
      return res.status(400).json({ error: 'Invalid or expired OAuth state' });
    }

    // Check expiry
    if (new Date(pending.expires_at) < new Date()) {
      return res.status(400).json({ error: 'OAuth state expired. Please try connecting again.' });
    }

    // Determine client credentials
    let clientId: string;
    let clientSecret: string;

    if (pending.use_custom_app && pending.custom_client_id && pending.custom_client_secret_encrypted) {
      clientId = pending.custom_client_id;
      const { data: decrypted, error: decryptErr } = await supabase.rpc('decrypt_token', {
        encrypted_token: pending.custom_client_secret_encrypted,
      });
      if (decryptErr || !decrypted) {
        return res.status(500).json({ error: 'Failed to decrypt custom client secret' });
      }
      clientSecret = decrypted;
    } else {
      clientId = config.salesforceConnectedAppClientId;
      clientSecret = config.salesforceConnectedAppClientSecret;
    }

    // Exchange authorization code for tokens
    const tokenResponse = await fetch('https://login.salesforce.com/services/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: pending.redirect_uri,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: pending.code_verifier,
      }),
    });

    const tokens = await tokenResponse.json();

    if (!tokenResponse.ok || tokens.error) {
      // Intentionally do not log tokens.error_description — provider verbose
      // modes have reflected client_id/client_secret fragments into that field.
      req.log.error(
        { status: tokenResponse.status, errorCode: typeof tokens.error === 'string' ? tokens.error : undefined },
        'Salesforce token exchange failed'
      );
      return res.redirect(`${frontendUrl}/profile?salesforce_error=token_exchange_failed`);
    }

    // Encrypt tokens
    const { data: encryptedAccess, error: encAccessErr } = await supabase.rpc('encrypt_token', {
      token: tokens.access_token,
    });
    if (encAccessErr || !encryptedAccess) {
      return res.status(500).json({ error: 'Failed to encrypt access token' });
    }

    let encryptedRefresh: string | null = null;
    if (tokens.refresh_token) {
      const { data: enc } = await supabase.rpc('encrypt_token', { token: tokens.refresh_token });
      encryptedRefresh = enc || null;
    }

    // Validate instance_url
    if (!tokens.instance_url || !isValidSalesforceInstanceUrl(tokens.instance_url)) {
      req.log.error({ instanceUrl: tokens.instance_url }, 'Invalid instance_url from token response');
      return res.status(400).json({ error: 'Salesforce returned an invalid instance URL' });
    }

    // Store custom app credentials for future token refreshes
    let oauthClientId: string | null = null;
    let oauthClientSecretEncrypted: string | null = null;
    if (pending.use_custom_app) {
      oauthClientId = pending.custom_client_id;
      oauthClientSecretEncrypted = pending.custom_client_secret_encrypted;
    }

    // Calculate token expiry (Salesforce access tokens ~2 hours)
    const tokenExpiry = tokens.issued_at
      ? new Date(Number(tokens.issued_at) + 2 * 60 * 60 * 1000).toISOString()
      : new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    // Capture canonical org identity before any state mutation. org_id is the
    // load-bearing field for the takeover-rejection check below — instance
    // URLs change when sandboxes refresh or when "My Domain" is renamed, but
    // org_id is stable for the lifetime of the org. org_name is display-only;
    // nullable on the degraded path (the userinfo endpoint returns org_id
    // without the org name, so a separate sobject call fills that in).
    const identity = await fetchSalesforceIdentity({
      accessToken: tokens.access_token,
      instanceUrl: tokens.instance_url,
    });

    // Block silent overwrite when a different admin in the same org has already
    // connected a different Salesforce org. Re-connecting the same org (e.g.
    // re-authorizing after a token rotation, sandbox refresh, or domain
    // rename) is still allowed — identity is keyed off org_id.
    //
    // Comparison preference: org_id > instance_url. Fall back to instance_url
    // only when one side has a null org_id (legacy rows persisted before this
    // change shipped, or a degraded identity lookup on the new token).
    const { data: existingCred } = await supabase
      .from('salesforce_credentials')
      .select('instance_url, salesforce_org_id, connected_by_user_id')
      .eq('organization_id', pending.organization_id)
      .maybeSingle();

    if (existingCred) {
      const haveBothOrgIds = !!existingCred.salesforce_org_id && !!identity.orgId;
      const orgIdMismatch = haveBothOrgIds && existingCred.salesforce_org_id !== identity.orgId;
      const instanceMismatch =
        !haveBothOrgIds &&
        existingCred.instance_url &&
        existingCred.instance_url !== tokens.instance_url;

      if (orgIdMismatch || instanceMismatch) {
        req.log.warn(
          {
            organizationId: pending.organization_id,
            existingOrgId: existingCred.salesforce_org_id,
            existingInstance: existingCred.instance_url,
            attemptedOrgId: identity.orgId,
            attemptedInstance: tokens.instance_url,
            existingConnectedBy: existingCred.connected_by_user_id,
            attemptedBy: pending.user_id,
            comparedOn: haveBothOrgIds ? 'org_id' : 'instance_url',
          },
          'Rejecting Salesforce connect — org already connected to a different Salesforce org'
        );
        return res.redirect(
          `${frontendUrl}/profile?salesforce_error=instance_conflict`
        );
      }
    }

    // Upsert into salesforce_credentials
    const { error: upsertErr } = await supabase
      .from('salesforce_credentials')
      .upsert(
        {
          organization_id: pending.organization_id,
          instance_url: tokens.instance_url,
          salesforce_org_id: identity.orgId,
          organization_name: identity.orgName,
          access_token_encrypted: encryptedAccess,
          refresh_token_encrypted: encryptedRefresh,
          token_expiry: tokenExpiry,
          oauth_client_id: oauthClientId,
          oauth_client_secret_encrypted: oauthClientSecretEncrypted,
          connected_by_user_id: pending.user_id,
          sync_status: 'active',
          connected_at: new Date().toISOString(),
        },
        { onConflict: 'organization_id' }
      );

    if (upsertErr) {
      req.log.error({ err: upsertErr }, 'Failed to store credentials');
      return res.status(500).json({ error: 'Failed to store Salesforce credentials' });
    }

    // Clear any cached connection for this org
    clearConnectionCache(pending.organization_id);

    req.log.info({ organizationId: pending.organization_id }, 'Connected successfully');
    res.redirect(`${frontendUrl}/profile?salesforce_connected=true`);
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// POST /oauth/disconnect — Revoke and remove Salesforce credentials
// ---------------------------------------------------------------------------

router.post('/oauth/disconnect', requireAuth(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = getAuth(req);
    const activeOrgId = auth.orgId;
    const orgRole = auth.orgRole;

    if (!activeOrgId) {
      return res.status(400).json({ error: 'No organization selected' });
    }

    if (orgRole !== 'org:owner' && !orgRole?.includes('admin')) {
      return res.status(403).json({ error: 'Only organization admins can disconnect Salesforce' });
    }

    const organizationId = await resolveOrgId(activeOrgId, req.log);
    if (!organizationId) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    // Read credentials to revoke the token
    const { data: creds } = await supabase
      .from('salesforce_credentials')
      .select('access_token_encrypted')
      .eq('organization_id', organizationId)
      .single();

    if (creds?.access_token_encrypted) {
      const { data: accessToken } = await supabase.rpc('decrypt_token', {
        encrypted_token: creds.access_token_encrypted,
      });
      if (accessToken) {
        // Best-effort token revocation
        try {
          await fetch(`https://login.salesforce.com/services/oauth2/revoke?token=${encodeURIComponent(accessToken)}`, {
            method: 'POST',
          });
        } catch (revokeErr) {
          req.log.warn({ err: revokeErr }, 'Token revocation failed (non-critical)');
        }
      }
    }

    // Delete credentials
    await supabase.from('salesforce_credentials').delete().eq('organization_id', organizationId);

    // Clear cached connection
    clearConnectionCache(organizationId);

    req.log.info({ organizationId }, 'Disconnected');
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// GET /oauth/status — Connection status for current org
// ---------------------------------------------------------------------------

router.get('/oauth/status', requireAuth(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = getAuth(req);
    const activeOrgId = auth.orgId;

    if (!activeOrgId) {
      return res.status(400).json({ error: 'No organization selected' });
    }

    const organizationId = await resolveOrgId(activeOrgId, req.log);
    if (!organizationId) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const { data: creds } = await supabase
      .from('salesforce_credentials')
      .select(
        'instance_url, salesforce_org_id, organization_name, sync_status, connected_by_user_id, connected_at, oauth_client_id'
      )
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!creds) {
      return res.json({ connected: false });
    }

    // Resolve the connector's display name + count of dossiers that reference
    // this Salesforce org (used by the disconnect-confirmation warning and the
    // instance_conflict toast). Both are best-effort — failure here just means
    // the UI shows fewer details.
    let connectorName: string | null = null;
    let dossierCount = 0;
    const [profileResult, dossierResult] = await Promise.all([
      creds.connected_by_user_id
        ? supabase
            .from('profiles')
            .select('first_name, last_name, email')
            .eq('user_id', creds.connected_by_user_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null } as const),
      supabase
        .from('prospect_dossiers')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', organizationId)
        .eq('crm_provider', 'salesforce')
        .not('crm_deal_id', 'is', null),
    ]);
    const profile = (profileResult as { data?: { first_name?: string | null; last_name?: string | null; email?: string | null } | null }).data;
    if (profile) {
      const parts = [profile.first_name, profile.last_name].filter((p): p is string => !!p && p.length > 0);
      connectorName = parts.length > 0 ? parts.join(' ') : profile.email ?? null;
    }
    const count = (dossierResult as { count?: number | null }).count;
    if (typeof count === 'number') dossierCount = count;

    res.json({
      connected: creds.sync_status === 'active',
      syncStatus: creds.sync_status,
      instanceUrl: creds.instance_url,
      salesforceOrgId: creds.salesforce_org_id,
      organizationName: creds.organization_name,
      connectorName,
      dossierCount,
      connectedBy: creds.connected_by_user_id,
      connectedAt: creds.connected_at,
      usesCustomApp: Boolean(creds.oauth_client_id),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
