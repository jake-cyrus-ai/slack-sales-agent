/**
 * OAuth Routes for Google Calendar, Slack, Granola, and Attio integrations
 *
 * Migrated from Supabase Edge Functions to Express for better maintainability
 * and consistency with the rest of the backend.
 *
 * Routes:
 * - POST /api/oauth/google/callback - Exchange Google OAuth code for tokens
 * - POST /api/oauth/google/disconnect - Revoke and delete Google credentials
 * - POST /api/oauth/slack/initiate - Create OAuth state and return Slack auth URL
 * - GET  /api/oauth/slack/callback - Handle Slack OAuth callback
 * - POST /api/oauth/granola/initiate - Initiate Granola MCP OAuth 2.1 flow
 * - GET  /api/oauth/granola/callback - Handle Granola OAuth callback
 * - POST /api/oauth/attio/initiate - Initiate Attio MCP OAuth 2.1 flow
 * - GET  /api/oauth/attio/callback - Handle Attio OAuth callback
 * - POST /api/oauth/agent-email/initiate - Start Sales Agent email OAuth flow
 * - POST /api/oauth/agent-email/callback - Handle Sales Agent email OAuth callback
 * - POST /api/oauth/agent-email/verify - Verify Sales Agent email credentials
 * - POST /api/oauth/agent-email/revoke - Disconnect Sales Agent email
 */

import { Router, Response } from "express";
import { getAuth, requireAuth } from "../lib/auth";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import crypto from "crypto";
import type { Request } from "../types";
import { workflow } from "../workflows/client";
import type { Logger } from "pino";
import { fetchAttioWorkspaceMetadata } from "../src/services/attio-workspace.js";
import { isOrgAdmin } from "../lib/auth";

// ---------------------------------------------------------------------------
// Safe extractor for OAuth token-exchange error responses. Provider error
// bodies have historically reflected client_id / client_secret fragments or
// full token strings (especially Salesforce and Slack in verbose-debug modes).
// Never log the raw body; emit a structured subset we know is safe, plus a
// short sha256 of the body for correlation if we need to chase down an issue.
// ---------------------------------------------------------------------------

async function extractOAuthErrorFields(
  response: globalThis.Response
): Promise<{ status: number; errorCode?: string; errorUri?: string; bodyHash?: string }> {
  const status = response.status;
  let bodyText = '';
  try {
    bodyText = await response.text();
  } catch {
    return { status };
  }

  const bodyHash = bodyText
    ? crypto.createHash('sha256').update(bodyText).digest('hex').slice(0, 12)
    : undefined;

  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown; error_uri?: unknown };
    return {
      status,
      errorCode: typeof parsed.error === 'string' ? parsed.error : undefined,
      errorUri: typeof parsed.error_uri === 'string' ? parsed.error_uri : undefined,
      bodyHash,
    };
  } catch {
    return { status, bodyHash };
  }
}

// ---------------------------------------------------------------------------
// Supabase admin client (service role — bypasses RLS)
// Lazy singleton to avoid creating a new client on every request
// ---------------------------------------------------------------------------

let _supabaseAdmin: SupabaseClient | null = null;

const getSupabaseAdmin = (): SupabaseClient => {
  if (_supabaseAdmin) return _supabaseAdmin;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  _supabaseAdmin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return _supabaseAdmin;
};

// ---------------------------------------------------------------------------
// Google OAuth credentials
// ---------------------------------------------------------------------------

const getGoogleCredentials = () => {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
  return { clientId, clientSecret };
};

const getAgentEmailRedirectUri = () =>
  process.env.GOOGLE_OAUTH_REDIRECT_URI ||
  `${process.env.FRONTEND_URL || "http://localhost:3000"}/email/callback`;

async function completeUserGoogleOAuth(code: string, state: string, log: Logger) {
  const supabase = getSupabaseAdmin();
  const { data: storedState, error: stateError } = await supabase
    .from("oauth_states")
    .select("*")
    .eq("state", state)
    .eq("status", "pending")
    .single();

  if (stateError || !storedState || new Date(storedState.expires_at) < new Date()) {
    throw new Error("Invalid or expired OAuth state");
  }

  const userId = storedState.user_id as string | null;
  const organizationId = storedState.metadata?.organization_id as string | undefined;
  if (!userId || !organizationId || storedState.metadata?.type !== "agent_email") {
    throw new Error("OAuth state is missing its user or organization owner");
  }

  const { clientId, clientSecret } = getGoogleCredentials();
  if (!clientId || !clientSecret) throw new Error("Google OAuth is not configured");

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: getAgentEmailRedirectUri(),
    }),
  });
  if (!tokenResponse.ok) {
    log.error(await extractOAuthErrorFields(tokenResponse), "Google token exchange failed");
    throw new Error("Failed to exchange Google authorization code");
  }

  const tokens = await tokenResponse.json() as GoogleTokenResponse;
  const grantedScopes = (tokens.scope || "").split(" ").filter(Boolean);
  const missingGroups = REQUIRED_GOOGLE_SCOPE_GROUPS.filter(
    (group) => !group.some((scope) => grantedScopes.includes(scope)),
  );
  if (missingGroups.length) throw new Error("Google did not grant all required Gmail and Calendar scopes");

  const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userInfoResponse.ok) throw new Error("Failed to read the connected Google account");
  const userInfo = await userInfoResponse.json() as { email?: string };
  if (!userInfo.email) throw new Error("Google account did not return an email address");

  const [{ data: encryptedAccess, error: accessError }, { data: encryptedRefresh, error: refreshError }] =
    await Promise.all([
      supabase.rpc("encrypt_token", { token: tokens.access_token }),
      supabase.rpc("encrypt_token", { token: tokens.refresh_token }),
    ]);
  if (accessError || refreshError || !encryptedAccess || !encryptedRefresh) {
    throw new Error("Failed to encrypt Google credentials");
  }

  await supabase
    .from("calendar_credentials")
    .delete()
    .eq("user_id", userId)
    .eq("organization_id", organizationId);

  const { error: calendarError } = await supabase.from("calendar_credentials").insert({
    user_id: userId,
    organization_id: organizationId,
    access_token_encrypted: encryptedAccess,
    refresh_token_encrypted: encryptedRefresh,
    token_expiry: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    calendar_email: userInfo.email,
    connected_at: new Date().toISOString(),
    sync_status: "active",
    scopes: grantedScopes,
  });
  if (calendarError) throw new Error(`Failed to save Google credentials: ${calendarError.message}`);

  // Keep the organization sender compatible with autonomous-email workflows,
  // while calendar_credentials remains the source of truth for user skills.
  const { error: senderError } = await supabase.from("agent_email_credentials").upsert({
    organization_id: organizationId,
    email_address: userInfo.email,
    display_name: "Sales Agent",
    refresh_token: encryptedRefresh,
    access_token: null,
    token_expires_at: null,
    provider: "google",
    is_active: true,
    last_verified_at: new Date().toISOString(),
    verification_status: "verified",
    created_by: userId,
  }, { onConflict: "organization_id" });
  if (senderError) log.warn({ err: senderError }, "Google connected, but autonomous sender compatibility record failed");

  await supabase.from("oauth_states").update({ status: "completed" }).eq("id", storedState.id);
  log.info({ userId, organizationId, email: userInfo.email }, "Connected user Google workspace");
  return { userId, organizationId, email: userInfo.email };
}

export async function googleBrowserOAuthCallback(req: Request, res: Response) {
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;
  if (!code || !state) {
    return res.redirect(`${frontendUrl}/?oauth_error=missing_google_callback_parameters`);
  }

  try {
    await completeUserGoogleOAuth(code, state, req.log);
    return res.redirect(`${frontendUrl}/?oauth_success=true&provider=google`);
  } catch (error) {
    req.log.error({ err: error }, "Google browser OAuth callback failed");
    const supabase = getSupabaseAdmin();
    await supabase.from("oauth_states").update({ status: "failed" }).eq("state", state);
    return res.redirect(`${frontendUrl}/?oauth_error=google_connection_failed`);
  }
}

// ---------------------------------------------------------------------------
// Slack OAuth credentials
// ---------------------------------------------------------------------------

const getSlackCredentials = () => {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  return { clientId, clientSecret };
};

// ---------------------------------------------------------------------------
// Redirect origin allowlist (shared by Slack and Granola OAuth routes)
// ---------------------------------------------------------------------------

const ALLOWED_REDIRECT_ORIGINS = [
  process.env.FRONTEND_URL,
  "http://localhost:8080",
  "http://localhost:3000",
  "https://your-app.example.com",
  "https://your-app.example.com",
].filter(Boolean);

/**
 * Returns `raw` if it parses and its origin is in the env-backed allowlist; null otherwise.
 * Callers MUST treat a null return as "don't redirect there" — do not fall back to the raw value.
 */
const validateRedirect = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const ok = ALLOWED_REDIRECT_ORIGINS.some((o) => parsed.origin === new URL(o!).origin);
    return ok ? raw : null;
  } catch {
    return null;
  }
};

// Google OAuth scopes required for the calendar+gmail integration. The user must
// grant at least one scope from each group for the connection to be considered
// successful; partial consent (e.g. unchecking Gmail in the Google consent screen)
// breaks downstream features silently, so we reject it on the callback. Must stay
// in sync with the scopes requested by the frontend (CalendarConnect.tsx,
// OnboardingWizard.tsx, CustomerOnboarding.tsx).
//
// Scope groups accept any one entry as satisfying the requirement. `gmail.compose`
// is a superset of `gmail.send` (drafts + send), and Google may dedupe and return
// only the broader scope in the granted-scopes string, so either satisfies the
// "send" capability.
const REQUIRED_GOOGLE_SCOPE_GROUPS: string[][] = [
  ["https://www.googleapis.com/auth/calendar"],
  ["https://www.googleapis.com/auth/gmail.readonly"],
  [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.compose",
  ],
  ["https://www.googleapis.com/auth/userinfo.email"],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the user's internal organization UUID.
 *
 * Priority:
 *  1. Authenticated request's active internal organization ID
 *  2. Oldest org membership from organization_users
 */
const resolveOrganizationId = async (
  supabase: SupabaseClient,
  userId: string,
  activeOrganizationId: string | null | undefined
): Promise<string | null> => {
  if (activeOrganizationId) {
    const { data: org } = await supabase
      .from("organizations")
      .select("id")
      .eq("id", activeOrganizationId)
      .single();

    if (org?.id) return org.id;
  }

  const { data: membership } = await supabase
    .from("organization_users")
    .select("organization_id")
    .eq("user_id", userId)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  return membership?.organization_id ?? null;
};

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/oauth/google/callback
// Exchange Google OAuth authorization code for tokens and store credentials
// ---------------------------------------------------------------------------

interface GoogleTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

router.post(
  "/oauth/google/callback",
  async (req: Request, res: Response) => {
    try {
      let userId: string | null = null;
      let activeOrgId: string | null | undefined;
      try {
        const auth = getAuth(req);
        userId = auth.userId;
        activeOrgId = auth.orgId;
      } catch (authErr) {
        req.log.error({ err: authErr }, "Supabase Auth error on Google callback");
        return res.status(401).json({
          error: "Unauthorized - authentication failed",
          requestId: req.id,
        });
      }

      if (!userId) {
        return res.status(401).json({
          error: "Unauthorized - No user ID in session",
          requestId: req.id,
        });
      }

      const { code } = req.body;

      if (!code) {
        return res.status(400).json({
          error: "Authorization code is required",
          requestId: req.id,
        });
      }

      const { clientId, clientSecret } = getGoogleCredentials();
      if (!clientId || !clientSecret) {
        req.log.error("Missing Google OAuth credentials");
        return res.status(500).json({
          error: "Server configuration error",
          requestId: req.id,
        });
      }

      req.log.info({ userId }, "Processing Google OAuth callback");

      const supabase = getSupabaseAdmin();

      const organizationId = await resolveOrganizationId(supabase, userId, activeOrgId);
      req.log.info({ organizationId: organizationId || null, activeOrgId: activeOrgId || null }, "Organization context");

      // Server-controlled redirect URI — never trust client input here. Google rejects
      // mismatches against the OAuth app's registered URIs anyway, but we still refuse
      // to reflect any value from req.body to avoid the open-redirect shape entirely.
      // Must match the redirect_uri the frontend used when starting the flow
      // (VITE_GOOGLE_CALENDAR_REDIRECT_URI → /calendar/callback across all envs).
      // Override with GOOGLE_OAUTH_REDIRECT_URI if frontend/backend need to diverge.
      const effectiveRedirectUri =
        process.env.GOOGLE_OAUTH_REDIRECT_URI ||
        `${process.env.FRONTEND_URL || "http://localhost:8080"}/calendar/callback`;

      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: effectiveRedirectUri,
          grant_type: "authorization_code",
        }),
      });

      if (!tokenResponse.ok) {
        const fields = await extractOAuthErrorFields(tokenResponse);
        req.log.error(fields, "Failed to exchange code for Google tokens");
        return res.status(tokenResponse.status).json({
          error: "Failed to connect to Google Calendar",
          details: tokenResponse.status === 400 ? "Invalid authorization code" : "OAuth error",
          requestId: req.id,
        });
      }

      const tokens: GoogleTokenResponse = await tokenResponse.json();

      // Verify the user granted every required scope group. Google returns granted
      // scopes as a space-separated string; partial consent (user unchecking Gmail,
      // etc.) would silently break downstream features, so we reject it here. A
      // group is satisfied when at least one of its scopes is present.
      const grantedScopes = (tokens.scope || "").split(" ").filter(Boolean);
      const missingGroups = REQUIRED_GOOGLE_SCOPE_GROUPS.filter(
        (group) => !group.some((s) => grantedScopes.includes(s)),
      );
      if (missingGroups.length > 0) {
        const missing = missingGroups.map((g) => g[0]);
        req.log.warn({ userId, missing, grantedScopes }, "Google OAuth missing required scopes");
        return res.status(400).json({
          error: "incomplete_scopes",
          message: "Please grant all requested permissions — the connection cannot continue without them.",
          missing,
          requestId: req.id,
        });
      }

      // Get user's email from Google
      const userInfoResponse = await fetch(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        {
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
          },
        }
      );

      if (!userInfoResponse.ok) {
        req.log.error("Failed to get user info from Google");
        return res.status(500).json({
          error: "Failed to get calendar email",
          requestId: req.id,
        });
      }

      const userInfo = await userInfoResponse.json();
      const calendarEmail = userInfo.email;

      req.log.info({ calendarEmail }, "Calendar email retrieved");

      // Encrypt tokens using database function
      const { data: encryptedAccess, error: encryptError1 } = await supabase.rpc(
        "encrypt_token",
        { token: tokens.access_token }
      );

      const { data: encryptedRefresh, error: encryptError2 } = await supabase.rpc(
        "encrypt_token",
        { token: tokens.refresh_token }
      );

      if (encryptError1 || encryptError2 || !encryptedAccess || !encryptedRefresh) {
        req.log.error({ err: encryptError1 || encryptError2 }, "Error encrypting tokens");
        return res.status(500).json({
          error: "Failed to secure credentials",
          requestId: req.id,
        });
      }

      // Calculate token expiry
      const tokenExpiry = new Date(Date.now() + tokens.expires_in * 1000);

      // Delete existing row for this (user, org) only — a user connecting calendar
      // in a second org must not clobber credentials stored for their other org.
      const deleteQuery = supabase
        .from("calendar_credentials")
        .delete()
        .eq("user_id", userId);
      if (organizationId) {
        await deleteQuery.eq("organization_id", organizationId);
      } else {
        await deleteQuery.is("organization_id", null);
      }

      // Store credentials in database
      const { error: insertError } = await supabase
        .from("calendar_credentials")
        .insert({
          user_id: userId,
          organization_id: organizationId || null,
          access_token_encrypted: encryptedAccess,
          refresh_token_encrypted: encryptedRefresh,
          token_expiry: tokenExpiry.toISOString(),
          calendar_email: calendarEmail,
          connected_at: new Date().toISOString(),
          sync_status: "active",
          scopes: grantedScopes,
        });

      if (insertError) {
        req.log.error({ err: insertError }, "Error storing credentials");
        return res.status(500).json({
          error: "Failed to save credentials",
          requestId: req.id,
        });
      }

      req.log.info({ userId }, "Successfully stored credentials");

      // Trigger initial calendar sync via Vercel Workflow (fire and forget)
      workflow
        .send({
          name: "calendar/sync",
          data: {
            userId,
            organizationId: organizationId || undefined,
          },
        })
        .catch((error) => {
          req.log.error({ err: error }, "Failed to trigger initial sync");
        });

      return res.json({
        success: true,
        calendar_email: calendarEmail,
        message: "Google Calendar connected successfully",
      });
    } catch (error) {
      req.log.error({ err: error }, "Error in Google OAuth callback");
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error occurred",
        requestId: req.id,
      });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/oauth/google/disconnect
// Revoke Google OAuth tokens and delete stored credentials
// ---------------------------------------------------------------------------

router.post(
  "/oauth/google/disconnect",
  async (req: Request, res: Response) => {
    try {
      // Auth check — supabaseAuthMiddleware() already ran on the /api mount.
      // We do a safe getAuth() instead of requireAuth() middleware so that
      // errors surface as a clear 401 rather than a 500 from the middleware chain.
      let userId: string | null = null;
      let activeOrgId: string | null | undefined;
      try {
        const auth = getAuth(req);
        userId = auth.userId;
        activeOrgId = auth.orgId;
      } catch (authErr) {
        req.log.error({ err: authErr }, "Supabase Auth error on disconnect");
        return res.status(401).json({
          error: "Unauthorized - authentication failed",
          requestId: req.id,
        });
      }

      if (!userId) {
        return res.status(401).json({
          error: "Unauthorized - No user ID in session",
          requestId: req.id,
        });
      }

      req.log.info({ userId }, "Disconnecting calendar");

      const supabase = getSupabaseAdmin();

      const organizationId = await resolveOrganizationId(supabase, userId, activeOrgId);
      req.log.info({ organizationId: organizationId || null, activeOrgId: activeOrgId || null }, "Organization context");

      // Get calendar credentials to revoke token with Google
      let credQuery = supabase
        .from("calendar_credentials")
        .select("access_token_encrypted")
        .eq("user_id", userId);

      if (organizationId) {
        credQuery = credQuery.eq("organization_id", organizationId);
      }

      const { data: credentials } = await credQuery.single();

      if (credentials) {
        try {
          // Decrypt the access token
          const { data: accessToken } = await supabase.rpc("decrypt_token", {
            encrypted_token: credentials.access_token_encrypted,
          });

          if (accessToken) {
            // Revoke the token with Google (use POST body to avoid token in URL/logs)
            await fetch("https://oauth2.googleapis.com/revoke", {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: `token=${encodeURIComponent(accessToken)}`,
            });
            req.log.info("Token revoked with Google");
          }
        } catch (revokeError) {
          req.log.error({ err: revokeError }, "Error revoking token with Google");
        }
      }

      // Delete calendar credentials (cascade will delete events and prep cache)
      let deleteQuery = supabase
        .from("calendar_credentials")
        .delete()
        .eq("user_id", userId);

      if (organizationId) {
        deleteQuery = deleteQuery.eq("organization_id", organizationId);
      }

      const { error: deleteError } = await deleteQuery;

      if (deleteError) {
        req.log.error({ err: deleteError }, "Error deleting calendar credentials");
        return res.status(500).json({
          error: "Failed to disconnect calendar",
          requestId: req.id,
        });
      }

      req.log.info({ userId }, "Successfully disconnected calendar");

      return res.json({
        success: true,
        message: "Calendar disconnected successfully",
      });
    } catch (error) {
      req.log.error({ err: error }, "Error disconnecting calendar");
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error occurred",
        requestId: req.id,
      });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/oauth/slack/initiate
// Create OAuth state server-side (bypasses RLS) and return Slack auth URL
// Requires Supabase Authentication
// ---------------------------------------------------------------------------

router.post(
  "/oauth/slack/initiate",
  async (req: Request, res: Response) => {
    try {
      let userId: string | null = null;
      let activeOrgId: string | null | undefined;
      try {
        const auth = getAuth(req);
        userId = auth.userId;
        activeOrgId = auth.orgId;
      } catch (authErr) {
        req.log.error({ err: authErr }, "Supabase Auth error on Slack initiate");
        return res.status(401).json({
          error: "Unauthorized - authentication failed",
          requestId: req.id,
        });
      }

      if (!userId) {
        return res.status(401).json({
          error: "Unauthorized - No user ID in session",
          requestId: req.id,
        });
      }

      // Validate redirect URI against allowlist; fall back to FRONTEND_URL if invalid.
      const rawRedirect = req.body.redirectUri || process.env.FRONTEND_URL || "";
      const validatedRedirect =
        validateRedirect(rawRedirect) || process.env.FRONTEND_URL || "";
      if (rawRedirect && !validateRedirect(rawRedirect)) {
        req.log.warn({ rawRedirect }, "Rejected redirect URI");
      }

      // Optional onboarding invite token. During customer onboarding the user
      // is not yet an org member, so the org is resolved from the invite they
      // hold; the token is also stored on the state row so the callback returns
      // them to /onboarding instead of /profile.
      const inviteToken =
        typeof req.body.inviteToken === "string" && req.body.inviteToken
          ? req.body.inviteToken
          : null;

      const supabase = getSupabaseAdmin();

      let organizationId: string | null = null;
      if (inviteToken) {
        const { data: invite } = await supabase
          .from("organization_invites")
          .select("organization_id")
          .eq("token", inviteToken)
          .eq("status", "pending")
          .maybeSingle();
        organizationId = invite?.organization_id ?? null;
      }
      if (!organizationId) {
        organizationId = await resolveOrganizationId(supabase, userId, activeOrgId);
      }

      if (!organizationId) {
        return res.status(400).json({
          error: "You must be part of an organization to connect Slack",
          requestId: req.id,
        });
      }

      const { clientId } = getSlackCredentials();
      if (!clientId) {
        req.log.error("Missing SLACK_CLIENT_ID");
        return res.status(500).json({
          error: "Server configuration error - Slack Client ID not set",
          requestId: req.id,
        });
      }

      // Create OAuth state using service role (bypasses RLS)
      const { data: state, error } = await supabase
        .from("oauth_states")
        .insert({
          organization_id: organizationId,
          user_id: userId,
          provider: "slack_bot",
          redirect_uri: validatedRedirect,
          invite_token: inviteToken,
        })
        .select()
        .single();

      if (error || !state) {
        req.log.error({ err: error }, "Failed to create OAuth state");
        return res.status(500).json({
          error: "Failed to create OAuth state",
          requestId: req.id,
        });
      }

      // Build the Slack authorization URL
      const serverBaseUrl = process.env.SERVER_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
      const redirectUri = `${serverBaseUrl}/api/oauth/slack/callback`;

      const scopes =
        "app_mentions:read,channels:history,channels:read,chat:write,chat:write.customize,chat:write.public,files:write,groups:history,im:history,im:read,im:write,mpim:history,mpim:write,reactions:write,team:read,users:read,users:read.email";

      const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state.id}`;

      req.log.info({ userId, organizationId }, "Created Slack OAuth state");

      return res.json({ authUrl });
    } catch (error) {
      req.log.error({ err: error }, "Slack initiate error");
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error occurred",
        requestId: req.id,
      });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/oauth/slack/callback
// Handle Slack OAuth callback - exchanges code for tokens and stores them
// This is a redirect endpoint, not a JSON API
// ---------------------------------------------------------------------------

router.get(
  "/oauth/slack/callback",
  async (req: Request, res: Response) => {
    req.log.info("Slack OAuth callback received");

    try {
      const supabase = getSupabaseAdmin();
      const { clientId, clientSecret } = getSlackCredentials();

      if (!clientId || !clientSecret) {
        req.log.error("Missing Slack OAuth credentials");
        return res.redirect(`${process.env.FRONTEND_URL || ""}/onboarding?error=server_config`);
      }

      // Parse query parameters from Slack callback
      const code = req.query.code as string | undefined;
      const stateId = req.query.state as string | undefined;
      const error = req.query.error as string | undefined;

      req.log.info({ hasCode: !!code, stateId, error }, "OAuth callback params");

      // Check if user denied permission
      if (error) {
        req.log.info({ error }, "User denied Slack OAuth");
        return res.redirect(`${process.env.FRONTEND_URL || ""}/onboarding?error=access_denied`);
      }

      if (!code || !stateId) {
        req.log.info("Missing code or stateId");
        return res.redirect(`${process.env.FRONTEND_URL || ""}/onboarding?error=invalid_request`);
      }

      // Retrieve and validate OAuth state
      const { data: oauthState, error: stateError } = await supabase
        .from("oauth_states")
        .select("*")
        .eq("id", stateId)
        .eq("status", "pending")
        .maybeSingle();

      if (stateError) {
        req.log.error({ err: stateError }, "Error fetching OAuth state");
        return res.redirect(`${process.env.FRONTEND_URL || ""}/onboarding?error=invalid_state`);
      }

      if (!oauthState) {
        req.log.error({ stateId }, "OAuth state not found");
        return res.redirect(`${process.env.FRONTEND_URL || ""}/onboarding?error=state_not_found`);
      }

      const provider = oauthState.provider;
      const inviteToken = oauthState.invite_token;
      // Always allowlist the fallback. If FRONTEND_URL is unset and the DB row
      // was tampered (service-role compromise, SQL injection), using
      // oauthState.redirect_uri verbatim would be an open redirect.
      const frontendUrl =
        process.env.FRONTEND_URL ||
        validateRedirect(oauthState.redirect_uri) ||
        "";

      // Check if state has expired (10 minutes)
      if (new Date(oauthState.created_at).getTime() + 10 * 60 * 1000 < Date.now()) {
        await supabase.from("oauth_states").update({ status: "expired" }).eq("id", stateId);
        const redirectUrl = inviteToken
          ? `${frontendUrl}/onboarding?token=${inviteToken}&error=state_expired`
          : `${frontendUrl}/onboarding?error=state_expired`;
        return res.redirect(redirectUrl);
      }

      const organizationId = oauthState.organization_id;
      const userId = oauthState.user_id;

      req.log.info({ provider, orgId: organizationId, userId, frontendUrl }, "OAuth state details");

      // Exchange code for tokens
      const serverBaseUrl = process.env.SERVER_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
      const oauthCallbackUrl = `${serverBaseUrl}/api/oauth/slack/callback`;
      
      const tokenResponse = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: oauthCallbackUrl,
        }),
      });

      let tokenData: any;
      try {
        const contentType = tokenResponse.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
          const text = await tokenResponse.text();
          req.log.error({ responseSnippet: text.substring(0, 500) }, "Slack returned non-JSON response");
          await supabase.from("oauth_states").update({ status: "failed" }).eq("id", stateId);
          const redirectUrl = inviteToken
            ? `${frontendUrl}/onboarding?token=${inviteToken}&error=unexpected_response`
            : `${frontendUrl}/onboarding?error=unexpected_response`;
          return res.redirect(redirectUrl);
        }
        tokenData = await tokenResponse.json();
      } catch (parseError) {
        req.log.error({ err: parseError }, "Failed to parse Slack token response");
        await supabase.from("oauth_states").update({ status: "failed" }).eq("id", stateId);
        const redirectUrl = inviteToken
          ? `${frontendUrl}/onboarding?token=${inviteToken}&error=parse_error`
          : `${frontendUrl}/onboarding?error=parse_error`;
        return res.redirect(redirectUrl);
      }

      if (!tokenData.ok) {
        req.log.error({ tokenError: tokenData.error }, "Failed to exchange code for tokens");
        await supabase.from("oauth_states").update({ status: "failed" }).eq("id", stateId);
        const redirectUrl = inviteToken
          ? `${frontendUrl}/onboarding?token=${inviteToken}&error=token_exchange_failed`
          : `${frontendUrl}/onboarding?error=token_exchange_failed`;
        return res.redirect(redirectUrl);
      }

      // Extract relevant data based on provider type
      let accessToken: string;
      const refreshToken: string | null = null;
      let metadata: Record<string, unknown> = {};
      let scopes: string[] = [];

      if (provider === "slack_bot") {
        accessToken = tokenData.access_token;
        scopes = tokenData.scope?.split(",") || [];
        metadata = {
          team_id: tokenData.team?.id,
          team_name: tokenData.team?.name,
          bot_user_id: tokenData.bot_user_id,
          // app_id from Slack's oauth.v2.access response — always starts with
          // 'A' (e.g. "AXXXXXXXXXX"). This is the canonical Slack App ID and
          // is what slack_workspaces.slack_app_id is meant to hold. We
          // historically fell back to process.env.SLACK_APP_ID, which led to
          // a Client ID being misstored as the App ID on a staging instance.
          // Prefer this over env.
          app_id: tokenData.app_id,
        };
      } else if (provider === "slack_user") {
        accessToken = tokenData.authed_user?.access_token;
        if (!accessToken) {
          await supabase.from("oauth_states").update({ status: "failed" }).eq("id", stateId);
          const redirectUrl = inviteToken
            ? `${frontendUrl}/onboarding?token=${inviteToken}&error=no_user_token`
            : `${frontendUrl}/onboarding?error=no_user_token`;
          return res.redirect(redirectUrl);
        }

        scopes = tokenData.authed_user?.scope?.split(",") || [];

        // Get user identity
        try {
          const identityResponse = await fetch("https://slack.com/api/users.identity", {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          });

          const contentType = identityResponse.headers.get("content-type") || "";
          if (!contentType.includes("application/json")) {
            const text = await identityResponse.text();
            req.log.error({ responseSnippet: text.substring(0, 500) }, "Slack identity returned non-JSON response");
          } else {
            const identityData = await identityResponse.json();
            if (identityData.ok) {
              metadata = {
                team_id: identityData.team?.id,
                team_name: identityData.team?.name,
                user_id: identityData.user?.id,
                user_name: identityData.user?.name,
                user_email: identityData.user?.email,
              };
            }
          }
        } catch (identityError) {
          req.log.error({ err: identityError }, "Failed to fetch user identity");
        }
      } else {
        await supabase.from("oauth_states").update({ status: "failed" }).eq("id", stateId);
        const redirectUrl = inviteToken
          ? `${frontendUrl}/onboarding?token=${inviteToken}&error=invalid_provider`
          : `${frontendUrl}/onboarding?error=invalid_provider`;
        return res.redirect(redirectUrl);
      }

      // Store OAuth connection in database
      const orgIdForQuery = provider === "slack_bot" ? organizationId : null;
      const userIdForQuery = provider === "slack_user" ? userId : null;

      // Encrypt the access token before storing in oauth_connections
      let storedAccessToken = accessToken;
      const { data: encrypted } = await supabase.rpc("encrypt_token", {
        token: accessToken,
      });
      if (encrypted) {
        storedAccessToken = encrypted;
      }

      // Try to find existing connection
      const { data: existingConnection } = await supabase
        .from("oauth_connections")
        .select("id")
        .eq("organization_id", orgIdForQuery)
        .eq("provider", provider)
        .maybeSingle();

      let connectionError;
      if (existingConnection) {
        // Update existing connection
        const { error: updateError } = await supabase
          .from("oauth_connections")
          .update({
            access_token: storedAccessToken,
            refresh_token: refreshToken,
            scopes,
            metadata,
            is_active: true,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existingConnection.id);
        connectionError = updateError;
        req.log.info({ connectionId: existingConnection.id }, "Updated existing OAuth connection");
      } else {
        // Insert new connection
        const { error: insertError } = await supabase
          .from("oauth_connections")
          .insert({
            organization_id: orgIdForQuery,
            user_id: userIdForQuery,
            provider,
            access_token: storedAccessToken,
            refresh_token: refreshToken,
            scopes,
            metadata,
            is_active: true,
          });
        connectionError = insertError;
        req.log.info("Created new OAuth connection");
      }

      if (connectionError) {
        req.log.error({ err: connectionError }, "Failed to store OAuth connection");
        await supabase.from("oauth_states").update({ status: "failed" }).eq("id", stateId);
        const redirectUrl = inviteToken
          ? `${frontendUrl}/onboarding?token=${inviteToken}&error=storage_failed`
          : `${frontendUrl}/onboarding?error=storage_failed`;
        return res.redirect(redirectUrl);
      }

      // For bot installations, also create/update slack_workspaces table
      if (provider === "slack_bot" && (metadata as { team_id?: string }).team_id) {
        const teamId = (metadata as { team_id: string }).team_id;
        const teamName = (metadata as { team_name?: string }).team_name;
        const botUserId = (metadata as { bot_user_id?: string }).bot_user_id;
        // Source of truth: Slack's oauth.v2.access response (always starts
        // with "A"). Fall back to env only if Slack didn't return one (very
        // old workspace, edge case). Warn if env disagrees with Slack — it
        // means SLACK_APP_ID is misconfigured (probably a Client ID, not an
        // App ID — see the April 2026 multi-app bug).
        const slackAppIdFromOAuth = (metadata as { app_id?: string }).app_id;
        const slackAppIdFromEnv = process.env.SLACK_APP_ID;
        const slackAppId = slackAppIdFromOAuth || slackAppIdFromEnv || null;
        if (
          slackAppIdFromOAuth &&
          slackAppIdFromEnv &&
          slackAppIdFromOAuth !== slackAppIdFromEnv
        ) {
          req.log.warn(
            { slackAppIdFromOAuth, slackAppIdFromEnv, teamId },
            "SLACK_APP_ID env disagrees with Slack OAuth response — env may be misconfigured (likely a Client ID instead of App ID). Trusting OAuth value.",
          );
        }
        if (slackAppId && !/^A[A-Z0-9]{8,}$/.test(slackAppId)) {
          req.log.warn(
            { slackAppId, teamId },
            "slack_app_id does not match expected format (A...) — likely the wrong identifier. Storing anyway.",
          );
        }

        // Reuse the already-encrypted token from oauth_connections storage
        const encryptedToken = storedAccessToken;

        // Check if workspace already exists for this specific app
        let existingQuery = supabase
          .from("slack_workspaces")
          .select("id, organization_id, is_active")
          .eq("team_id", teamId);

        if (slackAppId) {
          existingQuery = existingQuery.eq("slack_app_id", slackAppId);
        } else {
          existingQuery = existingQuery.is("slack_app_id", null);
        }

        const { data: existingWorkspace } = await existingQuery.maybeSingle();

        if (existingWorkspace) {
          // Block silent cross-org takeover: if another org currently owns this
          // (team_id, slack_app_id) and hasn't released it (is_active = false),
          // refuse to overwrite. Same-org reinstall and orphaned (null org)
          // records remain allowed.
          const existingOrg = existingWorkspace.organization_id as string | null;
          const isReinstallOrOrphan =
            !existingOrg ||
            existingOrg === organizationId ||
            existingWorkspace.is_active === false;

          if (!isReinstallOrOrphan) {
            req.log.warn(
              {
                teamId,
                slackAppId,
                existingOrg,
                incomingOrg: organizationId,
              },
              "Rejecting Slack install — workspace already claimed by a different org"
            );
            await supabase.from("oauth_states").update({ status: "failed" }).eq("id", stateId);
            const redirectUrl = inviteToken
              ? `${frontendUrl}/onboarding?token=${inviteToken}&error=slack_workspace_claimed`
              : `${frontendUrl}/profile?oauth_error=slack_workspace_claimed&provider=${provider}`;
            return res.redirect(redirectUrl);
          }

          const { error: updateError } = await supabase
            .from("slack_workspaces")
            .update({
              team_name: teamName,
              bot_token: encryptedToken,
              bot_user_id: botUserId,
              access_token: encryptedToken,
              is_active: true,
              installed_by_user_id: userId,
              organization_id: organizationId,
            })
            .eq("id", existingWorkspace.id);

          if (updateError) {
            req.log.error({ err: updateError }, "Failed to update slack_workspaces");
          } else {
            req.log.info({ teamId, slackAppId, organizationId }, "Updated slack_workspaces");
          }
        } else {
          const { error: insertError } = await supabase.from("slack_workspaces").insert({
            team_id: teamId,
            team_name: teamName,
            bot_token: encryptedToken,
            bot_user_id: botUserId,
            access_token: encryptedToken,
            slack_app_id: slackAppId,
            is_active: true,
            allowed_domains: [],
            installed_by_user_id: userId,
            organization_id: organizationId,
          });

          if (insertError) {
            req.log.error({ err: insertError }, "Failed to create slack_workspaces entry");
          } else {
            req.log.info({ teamId, slackAppId, organizationId }, "Created slack_workspaces entry");
          }
        }
      }

      // Mark OAuth state as completed
      await supabase.from("oauth_states").update({ status: "completed" }).eq("id", stateId);

      // Redirect back to the appropriate page
      let redirectUrl: string;
      if (inviteToken) {
        redirectUrl = `${frontendUrl}/onboarding?token=${inviteToken}&oauth_success=true&provider=${provider}`;
      } else {
        redirectUrl = `${frontendUrl}/profile?oauth_success=true&provider=${provider}`;
      }

      req.log.info({ redirectUrl }, "Slack OAuth successful, redirecting");
      return res.redirect(redirectUrl);
    } catch (error) {
      req.log.error({ err: error }, "Slack OAuth callback error");
      return res.redirect(`${process.env.FRONTEND_URL || ""}/onboarding?error=unexpected_error`);
    }
  }
);

// ---------------------------------------------------------------------------
// Granola MCP OAuth 2.1 helpers
// ---------------------------------------------------------------------------

const GRANOLA_MCP_URL = "https://mcp.granola.ai/mcp";

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest().toString("base64url");
}

function buildWellKnownUrls(serverUrl: string, wellKnownType: string): string[] {
  const url = new URL(serverUrl);
  const pathname = url.pathname.endsWith("/")
    ? url.pathname.slice(0, -1)
    : url.pathname;

  const urls: string[] = [];
  if (pathname && pathname !== "/") {
    urls.push(new URL(`/.well-known/${wellKnownType}${pathname}`, url.origin).href);
  }
  urls.push(new URL(`/.well-known/${wellKnownType}`, url.origin).href);
  return urls;
}

async function fetchJsonFromUrls(urls: string[], log: Logger): Promise<Record<string, unknown> | null> {
  for (const url of urls) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      log.info({ url }, "Trying OAuth metadata URL");
      const resp = await fetch(url, {
        headers: { "MCP-Protocol-Version": "2025-03-26" },
        signal: controller.signal,
      });
      if (resp.ok) {
        return await resp.json();
      }
      log.info({ url, status: resp.status }, "OAuth metadata URL returned non-OK status");
    } catch (e) {
      log.info({ url, err: e }, "OAuth metadata URL failed");
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}

/** Guard against SSRF: only allow OAuth endpoints hosted on granola.ai. */
function isGranolaUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith('granola.ai');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// POST /api/oauth/granola/initiate
// Initiate Granola MCP OAuth 2.1 flow
// Authenticated via Supabase access token (cross-origin safe)
// ---------------------------------------------------------------------------

router.post(
  "/oauth/granola/initiate",
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabaseAdmin();

      // 1. Authenticate via Supabase access token
      const auth = getAuth(req);
      const userId = auth.userId;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized", requestId: req.id });
      }

      req.log.info({ userId }, "Starting Granola OAuth");

      const activeOrgId = auth.orgId;
      const orgId = await resolveOrganizationId(supabase, userId, activeOrgId);

      if (!orgId) {
        return res.status(400).json({ error: "no_organization", requestId: req.id });
      }

      // 2. Discover OAuth protected resource metadata (RFC 9728)
      const resourceUrls = buildWellKnownUrls(GRANOLA_MCP_URL, "oauth-protected-resource");
      const resourceMeta = await fetchJsonFromUrls(resourceUrls, req.log);

      let authServerUrl: string;
      if (
        resourceMeta?.authorization_servers &&
        Array.isArray(resourceMeta.authorization_servers) &&
        resourceMeta.authorization_servers.length > 0
      ) {
        authServerUrl = String(resourceMeta.authorization_servers[0]);
      } else {
        authServerUrl = new URL("/", GRANOLA_MCP_URL).href;
      }

      // Validate auth server hostname to prevent SSRF via compromised metadata
      const parsedAuthServer = new URL(authServerUrl);
      if (!parsedAuthServer.hostname.endsWith("granola.ai")) {
        throw new Error(`Unexpected Granola auth server hostname: ${parsedAuthServer.hostname}`);
      }

      req.log.info({ authServerUrl }, "Auth server (Granola)");

      // 3. Discover authorization server metadata (RFC 8414)
      const authMetaUrls = buildWellKnownUrls(authServerUrl, "oauth-authorization-server");
      const authMeta = await fetchJsonFromUrls(authMetaUrls, req.log);

      if (!authMeta) {
        throw new Error("Failed to discover Granola OAuth authorization server metadata");
      }

      const authorizationEndpoint = String(authMeta.authorization_endpoint);
      const tokenEndpoint = String(authMeta.token_endpoint);
      const registrationEndpoint = authMeta.registration_endpoint
        ? String(authMeta.registration_endpoint)
        : null;

      // Validate endpoint hostnames to prevent SSRF
      if (!isGranolaUrl(authorizationEndpoint)) {
        throw new Error(`Unexpected authorization_endpoint hostname: ${authorizationEndpoint}`);
      }
      if (!isGranolaUrl(tokenEndpoint)) {
        throw new Error(`Unexpected token_endpoint hostname: ${tokenEndpoint}`);
      }
      if (registrationEndpoint && !isGranolaUrl(registrationEndpoint)) {
        throw new Error(`Unexpected registration_endpoint hostname: ${registrationEndpoint}`);
      }

      // 4. Dynamic client registration (RFC 7591)
      const serverBaseUrl = process.env.SERVER_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
      const callbackUrl = `${serverBaseUrl}/api/oauth/granola/callback`;

      let clientId: string;
      let clientSecret: string | null = null;

      if (registrationEndpoint) {
        const regController = new AbortController();
        const regTimeout = setTimeout(() => regController.abort(), 10_000);
        let regResponse: globalThis.Response;
        try {
          regResponse = await fetch(registrationEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: regController.signal,
            body: JSON.stringify({
              redirect_uris: [callbackUrl],
              client_name: "Slack Sales Agent",
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
            }),
          });
        } finally {
          clearTimeout(regTimeout);
        }

        if (!regResponse.ok) {
          const errText = await regResponse.text();
          throw new Error(`Client registration failed (${regResponse.status}): ${errText}`);
        }

        const clientInfo = await regResponse.json();
        clientId = clientInfo.client_id;
        clientSecret = clientInfo.client_secret || null;
        req.log.info({ clientId }, "Registered Granola client");
      } else {
        throw new Error("Granola auth server does not support dynamic client registration");
      }

      // 5. Generate PKCE
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = crypto.randomUUID();

      // 6. Store pending state in DB (clean up expired entries first)
      await supabase
        .from("granola_oauth_pending")
        .delete()
        .lt("expires_at", new Date().toISOString());

      // Encrypt client_secret before storing in pending table (matches Attio pattern)
      let encryptedPendingSecret: string | null = null;
      if (clientSecret) {
        const { data: enc } = await supabase.rpc('encrypt_token', { token: clientSecret });
        if (enc) encryptedPendingSecret = enc;
      }

      const { error: insertError } = await supabase
        .from("granola_oauth_pending")
        .insert({
          state,
          user_id: userId,
          organization_id: orgId,
          code_verifier: codeVerifier,
          client_id: clientId,
          client_secret: encryptedPendingSecret,
          token_endpoint: tokenEndpoint,
          authorization_endpoint: authorizationEndpoint,
          registration_endpoint: registrationEndpoint,
          redirect_uri: callbackUrl,
        });

      if (insertError) {
        throw new Error(`Failed to store OAuth state: ${insertError.message}`);
      }

      // 7. Build authorization URL and redirect
      const authUrl = new URL(authorizationEndpoint);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", callbackUrl);
      authUrl.searchParams.set("code_challenge", codeChallenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("state", state);

      req.log.info({ authUrlOrigin: authUrl.origin }, "Returning Granola OAuth URL");
      return res.json({ url: authUrl.toString(), requestId: req.id });
    } catch (error) {
      req.log.error({ err: error }, "Granola connect error");
      const msg = error instanceof Error ? error.message : "";
      const safeCode = msg.includes("metadata") ? "discovery_failed"
        : msg.includes("registration") ? "registration_failed"
        : "connection_failed";
      return res.status(500).json({ error: safeCode, requestId: req.id });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/oauth/granola/callback
// Handle Granola OAuth callback — exchange code for tokens and store credentials
// No Supabase Auth middleware — uses stored state for auth context
// ---------------------------------------------------------------------------

router.get(
  "/oauth/granola/callback",
  async (req: Request, res: Response) => {
    const frontendUrl = process.env.FRONTEND_URL || "https://your-app.example.com";

    try {
      const code = req.query.code as string | undefined;
      const state = req.query.state as string | undefined;
      const error = req.query.error as string | undefined;

      if (error) {
        req.log.info({ error }, "User denied Granola OAuth");
        return res.redirect(`${frontendUrl}/profile?granola_error=access_denied`);
      }

      if (!code || !state) {
        return res.redirect(`${frontendUrl}/profile?granola_error=invalid_callback`);
      }

      const supabase = getSupabaseAdmin();

      // 1. Atomically consume pending state (DELETE ... RETURNING) so the same
      //    `state` can never be replayed, even if any step below fails.
      const { data: pending, error: stateError } = await supabase
        .from("granola_oauth_pending")
        .delete()
        .eq("state", state)
        .select()
        .maybeSingle();

      if (stateError || !pending) {
        req.log.error({ state, err: stateError }, "Granola state not found or already consumed");
        return res.redirect(`${frontendUrl}/profile?granola_error=invalid_state`);
      }

      if (new Date(pending.expires_at) < new Date()) {
        return res.redirect(`${frontendUrl}/profile?granola_error=state_expired`);
      }

      req.log.info({ userId: pending.user_id }, "Processing Granola callback");

      // 2. Exchange authorization code for tokens
      const tokenParams: Record<string, string> = {
        grant_type: "authorization_code",
        code,
        code_verifier: pending.code_verifier,
        redirect_uri: pending.redirect_uri,
        client_id: pending.client_id,
      };

      // Decrypt client_secret that was encrypted before storing in pending table
      if (pending.client_secret) {
        const { data: decryptedSecret } = await supabase.rpc('decrypt_token', { encrypted_token: pending.client_secret });
        if (decryptedSecret) {
          tokenParams.client_secret = decryptedSecret;
        }
      }

      const tokenResponse = await fetch(pending.token_endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams(tokenParams),
      });

      if (!tokenResponse.ok) {
        const fields = await extractOAuthErrorFields(tokenResponse);
        req.log.error(fields, "Granola token exchange failed");
        return res.redirect(
          `${frontendUrl}/profile?granola_error=${encodeURIComponent("Token exchange failed")}`
        );
      }

      const tokens = await tokenResponse.json();
      req.log.info("Granola token exchange successful");

      // 3. Encrypt and store tokens
      const { data: encryptedAccess, error: encryptError1 } = await supabase.rpc(
        "encrypt_token",
        { token: tokens.access_token }
      );

      if (encryptError1 || !encryptedAccess) {
        req.log.error({ err: encryptError1 }, "Failed to encrypt Granola access token");
        return res.redirect(
          `${frontendUrl}/profile?granola_error=${encodeURIComponent("Failed to secure credentials")}`
        );
      }

      let encryptedRefresh: string | null = null;
      if (tokens.refresh_token) {
        const { data, error: encErr } = await supabase.rpc("encrypt_token", {
          token: tokens.refresh_token,
        });
        if (!encErr && data) {
          encryptedRefresh = data;
        }
      }

      // pending.client_secret is already encrypted (encrypted before storing in
      // granola_oauth_pending at connect time) — pass through directly.
      const encryptedClientSecret: string | null = pending.client_secret || null;

      const tokenExpiry = tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : null;

      let granolaEmail: string | null = null;
      const { data: profile } = await supabase
        .from("profiles")
        .select("email")
        .eq("user_id", pending.user_id)
        .maybeSingle();
      granolaEmail = (profile as { email?: string | null } | null)?.email || null;

      // Upsert credentials (delete + insert to avoid constraint issues)
      await supabase
        .from("granola_credentials")
        .delete()
        .eq("user_id", pending.user_id);

      const grantedScopes = typeof tokens.scope === "string"
        ? tokens.scope.split(" ").filter(Boolean)
        : null;

      const { error: insertError } = await supabase
        .from("granola_credentials")
        .insert({
          user_id: pending.user_id,
          organization_id: pending.organization_id || null,
          access_token_encrypted: encryptedAccess,
          refresh_token_encrypted: encryptedRefresh,
          token_expiry: tokenExpiry,
          granola_email: granolaEmail,
          connected_at: new Date().toISOString(),
          sync_status: "active",
          oauth_client_id: pending.client_id,
          oauth_client_secret: encryptedClientSecret,
          oauth_token_endpoint: pending.token_endpoint,
          scopes: grantedScopes,
        });

      if (insertError) {
        req.log.error({ err: insertError }, "Failed to store Granola credentials");
        return res.redirect(
          `${frontendUrl}/profile?granola_error=${encodeURIComponent("Failed to save credentials")}`
        );
      }

      req.log.info({ userId: pending.user_id }, "Successfully stored Granola credentials");

      // 5. Redirect to frontend with success
      return res.redirect(`${frontendUrl}/profile?granola_success=true`);
    } catch (error) {
      req.log.error({ err: error }, "Granola callback error");
      const msg = error instanceof Error ? error.message : "";
      const safeCode = msg.includes("token") ? "token_exchange_failed"
        : msg.includes("encrypt") ? "credential_storage_failed"
        : "callback_failed";
      return res.redirect(`${frontendUrl}/profile?granola_error=${safeCode}`);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/oauth/granola/disconnect
// Revoke Granola OAuth tokens and delete stored credentials
// ---------------------------------------------------------------------------

router.post(
  "/oauth/granola/disconnect",
  async (req: Request, res: Response) => {
    try {
      let userId: string | null = null;
      let activeOrgId: string | null | undefined;
      try {
        const auth = getAuth(req);
        userId = auth.userId;
        activeOrgId = auth.orgId;
      } catch (authErr) {
        req.log.error({ err: authErr }, "Supabase Auth error on Granola disconnect");
        return res.status(401).json({
          error: "Unauthorized - authentication failed",
          requestId: req.id,
        });
      }

      if (!userId) {
        return res.status(401).json({
          error: "Unauthorized - No user ID in session",
          requestId: req.id,
        });
      }

      req.log.info({ userId }, "Disconnecting Granola");

      const supabase = getSupabaseAdmin();

      const organizationId = await resolveOrganizationId(supabase, userId, activeOrgId);
      req.log.info({ organizationId: organizationId || null, activeOrgId: activeOrgId || null }, "Organization context");

      // Attempt token revocation if revocation endpoint is configured
      const revocationUrl = process.env.GRANOLA_REVOCATION_URL;
      if (revocationUrl) {
        let credQuery = supabase
          .from("granola_credentials")
          .select("access_token_encrypted")
          .eq("user_id", userId);

        if (organizationId) {
          credQuery = credQuery.eq("organization_id", organizationId);
        }

        const { data: credentials } = await credQuery.single();

        if (credentials) {
          try {
            const { data: accessToken } = await supabase.rpc("decrypt_token", {
              encrypted_token: credentials.access_token_encrypted,
            });

            if (accessToken) {
              await fetch(revocationUrl, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ token: accessToken }),
              });
              req.log.info("Token revoked with Granola");
            }
          } catch (revokeError) {
            req.log.error({ err: revokeError }, "Error revoking token with Granola");
          }
        }
      }

      // Delete granola credentials
      let deleteQuery = supabase
        .from("granola_credentials")
        .delete()
        .eq("user_id", userId);

      if (organizationId) {
        deleteQuery = deleteQuery.eq("organization_id", organizationId);
      }

      const { error: deleteError } = await deleteQuery;

      if (deleteError) {
        req.log.error({ err: deleteError }, "Error deleting granola credentials");
        return res.status(500).json({
          error: "Failed to disconnect Granola",
          requestId: req.id,
        });
      }

      req.log.info({ userId }, "Successfully disconnected Granola");

      return res.json({
        success: true,
        message: "Granola disconnected successfully",
      });
    } catch (error) {
      req.log.error({ err: error }, "Granola disconnect error");
      return res.status(500).json({
        error: "Internal server error",
        requestId: req.id,
      });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/oauth/granola/status
// Check Granola connection status for the authenticated user
// ---------------------------------------------------------------------------

router.get(
  "/oauth/granola/status",
  async (req: Request, res: Response) => {
    try {
      let userId: string | null = null;
      try {
        const auth = getAuth(req);
        userId = auth.userId;
      } catch (authErr) {
        req.log.error({ err: authErr }, "Supabase Auth error on Granola status");
        return res.status(401).json({
          error: "Unauthorized - authentication failed",
          requestId: req.id,
        });
      }

      if (!userId) {
        return res.status(401).json({
          error: "Unauthorized - No user ID in session",
          requestId: req.id,
        });
      }

      const supabase = getSupabaseAdmin();

      const { data, error } = await supabase
        .from("granola_credentials")
        .select("granola_email, sync_status, connected_at")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) {
        req.log.error({ err: error }, "Error checking Granola status");
        return res.status(500).json({
          error: "Failed to check Granola status",
          requestId: req.id,
        });
      }

      return res.json({
        connected: !!data,
        granola_email: data?.granola_email || null,
        sync_status: data?.sync_status || null,
      });
    } catch (error) {
      req.log.error({ err: error }, "Granola status error");
      return res.status(500).json({
        error: "Internal server error",
        requestId: req.id,
      });
    }
  }
);

// ---------------------------------------------------------------------------
// Sales Agent Email OAuth — Google email scopes for org-level email accounts
// ---------------------------------------------------------------------------

const SALES_AGENT_EMAIL_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

/**
 * Verify the caller is admin/owner of the given organization.
 */
const verifyOrgAdmin = async (
  supabase: SupabaseClient,
  userId: string,
  organizationId: string
): Promise<boolean> => {
  const { data: orgUser, error } = await supabase
    .from("organization_users")
    .select("role")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .single();

  if (error || !orgUser) return false;
  return ["owner", "admin"].includes(orgUser.role);
};

// ---------------------------------------------------------------------------
// POST /api/oauth/agent-email/initiate
// Start OAuth flow — returns Google auth URL for email scopes
// ---------------------------------------------------------------------------

router.post(
  "/oauth/agent-email/initiate",
  async (req: Request, res: Response) => {
    try {
      let userId: string | null = null;
      let activeOrgId: string | null | undefined;
      try {
        const auth = getAuth(req);
        userId = auth.userId;
        activeOrgId = auth.orgId;
      } catch (authErr) {
        req.log.error({ err: authErr }, "Supabase Auth error on agent-email initiate");
        return res.status(401).json({ error: "Unauthorized", requestId: req.id });
      }

      if (!userId) {
        return res.status(401).json({ error: "Unauthorized - No user ID", requestId: req.id });
      }

      const { organizationId: explicitOrgId } = req.body;
      const supabase = getSupabaseAdmin();

      // Use explicit orgId if provided, otherwise resolve from the authenticated membership
      const organizationId = explicitOrgId || await resolveOrganizationId(supabase, userId, activeOrgId);

      if (!organizationId) {
        return res.status(400).json({ error: "Missing organizationId", requestId: req.id });
      }

      // Verify admin/owner
      const isAdmin = await verifyOrgAdmin(supabase, userId, organizationId);
      if (!isAdmin) {
        return res.status(403).json({ error: "Must be org admin or owner", requestId: req.id });
      }

      const { clientId } = getGoogleCredentials();
      if (!clientId) {
        req.log.error("Missing Google OAuth credentials");
        return res.status(500).json({ error: "Server configuration error", requestId: req.id });
      }

      // Create state token
      const stateToken = crypto.randomUUID();
      const { error: stateError } = await supabase.from("oauth_states").insert({
        state: stateToken,
        user_id: userId,
        metadata: { type: "agent_email", organization_id: organizationId },
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });

      if (stateError) {
        req.log.error({ err: stateError }, "Failed to create OAuth state");
        return res.status(500).json({ error: "Failed to create OAuth state", requestId: req.id });
      }

      // Build Google auth URL
      const redirectUri = getAgentEmailRedirectUri();
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", SALES_AGENT_EMAIL_SCOPES);
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");
      authUrl.searchParams.set("state", stateToken);

      req.log.info({ organizationId }, "Started Sales Agent email OAuth");
      return res.json({ authUrl: authUrl.toString(), state: stateToken });
    } catch (error) {
      req.log.error({ err: error }, "Sales Agent email initiate error");
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
        requestId: req.id,
      });
    }
  }
);
// Attio MCP OAuth 2.1 — Dynamic Client Registration + PKCE
// Same pattern as Granola: no pre-registered app needed.
// ---------------------------------------------------------------------------

const ATTIO_MCP_URL = "https://mcp.attio.com/mcp";

/** Guard against SSRF: only allow OAuth endpoints hosted on attio.com. */
function isAttioUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith('attio.com');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// POST /api/oauth/attio/initiate
// Initiate Attio MCP OAuth 2.1 flow
// Authenticated via Supabase access token (cross-origin safe)
// ---------------------------------------------------------------------------

router.post(
  "/oauth/attio/initiate",
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabaseAdmin();

      // 1. Authenticate via Supabase access token
      const auth = getAuth(req);
      const userId = auth.userId;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized", requestId: req.id });
      }

      req.log.info({ userId }, "Starting Attio OAuth");

      const activeOrgId = auth.orgId;
      const orgId = await resolveOrganizationId(supabase, userId, activeOrgId);

      if (!orgId) {
        return res.status(400).json({ error: "no_organization", requestId: req.id });
      }

      // 2. Discover OAuth protected resource metadata (RFC 9728)
      const resourceUrls = buildWellKnownUrls(ATTIO_MCP_URL, "oauth-protected-resource");
      const resourceMeta = await fetchJsonFromUrls(resourceUrls, req.log);

      let authServerUrl: string;
      if (
        resourceMeta?.authorization_servers &&
        Array.isArray(resourceMeta.authorization_servers) &&
        resourceMeta.authorization_servers.length > 0
      ) {
        authServerUrl = String(resourceMeta.authorization_servers[0]);
      } else {
        authServerUrl = new URL("/", ATTIO_MCP_URL).href;
      }

      // Validate auth server hostname to prevent SSRF
      const parsedAuthServer = new URL(authServerUrl);
      if (!parsedAuthServer.hostname.endsWith("attio.com")) {
        throw new Error(`Unexpected Attio auth server hostname: ${parsedAuthServer.hostname}`);
      }

      req.log.info({ authServerUrl }, "Auth server (Attio)");

      // 3. Discover authorization server metadata (RFC 8414)
      const authMetaUrls = buildWellKnownUrls(authServerUrl, "oauth-authorization-server");
      const authMeta = await fetchJsonFromUrls(authMetaUrls, req.log);

      if (!authMeta) {
        throw new Error("Failed to discover Attio OAuth authorization server metadata");
      }

      const authorizationEndpoint = String(authMeta.authorization_endpoint);
      const tokenEndpoint = String(authMeta.token_endpoint);
      const registrationEndpoint = authMeta.registration_endpoint
        ? String(authMeta.registration_endpoint)
        : null;

      // Validate metadata endpoint hostnames to prevent SSRF
      if (!isAttioUrl(authorizationEndpoint)) {
        throw new Error(`Unexpected authorization_endpoint hostname: ${authorizationEndpoint}`);
      }
      if (!isAttioUrl(tokenEndpoint)) {
        throw new Error(`Unexpected token_endpoint hostname: ${tokenEndpoint}`);
      }
      if (registrationEndpoint && !isAttioUrl(registrationEndpoint)) {
        throw new Error(`Unexpected registration_endpoint hostname: ${registrationEndpoint}`);
      }

      // 4. Dynamic client registration (RFC 7591)
      const serverBaseUrl = process.env.SERVER_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
      const callbackUrl = `${serverBaseUrl}/api/oauth/attio/callback`;

      let clientId: string;
      let clientSecret: string | null = null;

      if (registrationEndpoint) {
        const regController = new AbortController();
        const regTimeout = setTimeout(() => regController.abort(), 10_000);
        let regResponse: globalThis.Response;
        try {
          regResponse = await fetch(registrationEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: regController.signal,
            body: JSON.stringify({
              redirect_uris: [callbackUrl],
              client_name: "Slack Sales Agent",
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
            }),
          });
        } finally {
          clearTimeout(regTimeout);
        }

        if (!regResponse.ok) {
          const errText = await regResponse.text();
          throw new Error(`Client registration failed (${regResponse.status}): ${errText}`);
        }

        const clientInfo = await regResponse.json();
        clientId = clientInfo.client_id;
        clientSecret = clientInfo.client_secret || null;
        req.log.info({ clientId }, "Registered Attio client");
      } else {
        throw new Error("Attio auth server does not support dynamic client registration");
      }

      // 5. Generate PKCE
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = crypto.randomUUID();

      // 6. Store pending state in DB
      await supabase
        .from("attio_oauth_pending")
        .delete()
        .lt("expires_at", new Date().toISOString());

      // Encrypt client_secret before storing in pending table — it's sensitive
      // and will be decrypted in the callback handler for the token exchange.
      let encryptedPendingSecret: string | null = null;
      if (clientSecret) {
        const { data: enc } = await supabase.rpc('encrypt_token', { token: clientSecret });
        if (enc) encryptedPendingSecret = enc;
      }

      const { error: insertError } = await supabase
        .from("attio_oauth_pending")
        .insert({
          state,
          user_id: userId,
          organization_id: orgId,
          code_verifier: codeVerifier,
          client_id: clientId,
          client_secret: encryptedPendingSecret,
          token_endpoint: tokenEndpoint,
          redirect_uri: callbackUrl,
        });

      if (insertError) {
        throw new Error(`Failed to store OAuth state: ${insertError.message}`);
      }

      // 7. Build authorization URL and redirect
      const authUrl = new URL(authorizationEndpoint);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", callbackUrl);
      authUrl.searchParams.set("code_challenge", codeChallenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("scope", "mcp offline_access");

      req.log.info({ authUrlOrigin: authUrl.origin }, "Returning Attio OAuth URL");
      return res.json({ url: authUrl.toString(), requestId: req.id });
    } catch (error) {
      req.log.error({ err: error }, "Attio connect error");
      const msg = error instanceof Error ? error.message : "";
      const safeCode = msg.includes("metadata") ? "discovery_failed"
        : msg.includes("registration") ? "registration_failed"
        : "connection_failed";
      return res.status(500).json({ error: safeCode, requestId: req.id });
    }
  }
);

// POST /api/oauth/agent-email/callback
// Exchange OAuth code for tokens and store credentials
// ---------------------------------------------------------------------------

router.post(
  "/oauth/agent-email/callback",
  async (req: Request, res: Response) => {
    try {
      let userId: string | null = null;
      try {
        const auth = getAuth(req);
        userId = auth.userId;
      } catch (authErr) {
        req.log.error({ err: authErr }, "Supabase Auth error on agent-email callback");
        return res.status(401).json({ error: "Unauthorized", requestId: req.id });
      }

      if (!userId) {
        return res.status(401).json({ error: "Unauthorized - No user ID", requestId: req.id });
      }

      const { code, state } = req.body;
      if (!code || !state) {
        return res.status(400).json({ error: "Missing code or state", requestId: req.id });
      }

      const supabase = getSupabaseAdmin();      
// Verify state token
      const { data: storedState, error: stateError } = await supabase
        .from("oauth_states")
        .select("*")
        .eq("state", state)
        .single();

      if (stateError || !storedState) {
        return res.status(400).json({ error: "Invalid or expired state token", requestId: req.id });
      }

      if (new Date(storedState.expires_at) < new Date()) {
        return res.status(400).json({ error: "State token expired", requestId: req.id });
      }

      const orgId = storedState.metadata?.organization_id;

      // Delete used state
      await supabase.from("oauth_states").delete().eq("state", state);

      // Exchange code for tokens
      const { clientId, clientSecret } = getGoogleCredentials();
      const redirectUri = getAgentEmailRedirectUri();

      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId!,
          client_secret: clientSecret!,
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenResponse.ok) {
        const fields = await extractOAuthErrorFields(tokenResponse);
        req.log.error(fields, "Sales Agent email token exchange failed");
        return res.status(500).json({ error: "Failed to exchange code for tokens", requestId: req.id });
      }

      const tokens = await tokenResponse.json();

      // Get user info
      const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });

      if (!userInfoResponse.ok) {
        return res.status(500).json({ error: "Failed to get user info", requestId: req.id });
      }

      const userInfo = await userInfoResponse.json();
      const emailAddress = userInfo.email;

      // Encrypt refresh token
      let encryptedRefreshToken = tokens.refresh_token;

      if (tokens.refresh_token) {
        const { data: encrypted } = await supabase.rpc("encrypt_token", {
          token: tokens.refresh_token,
        });
        if (encrypted) encryptedRefreshToken = encrypted;
      }

      // Upsert credentials
      const { error: upsertError } = await supabase
        .from("agent_email_credentials")
        .upsert(
          {
            organization_id: orgId,
            email_address: emailAddress,
            display_name: "Sales Agent",
            refresh_token: encryptedRefreshToken,
            access_token: null,
            token_expires_at: null,
            provider: "google",
            is_active: true,
            last_verified_at: new Date().toISOString(),
            verification_status: "verified",
            created_by: userId,
          },
          { onConflict: "organization_id" }
        );

      if (upsertError) {
        req.log.error({ err: upsertError }, "Failed to save credentials");
        return res.status(500).json({ error: `Failed to save credentials: ${upsertError.message}`, requestId: req.id });
      }

      req.log.info({ emailAddress, orgId }, "Connected Sales Agent email");
      return res.json({ success: true, email: emailAddress, organizationId: orgId });
    } catch (error) {
      req.log.error({ err: error }, "Sales Agent email callback error");
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
        requestId: req.id,
      });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/oauth/agent-email/verify
// Check if credentials exist and refresh token is valid
// ---------------------------------------------------------------------------

router.post(
  "/oauth/agent-email/verify",
  async (req: Request, res: Response) => {
    try {
      let userId: string | null = null;
      let activeOrgId: string | null | undefined;
      try {
        const auth = getAuth(req);
        userId = auth.userId;
        activeOrgId = auth.orgId;
      } catch (authErr) {
        return res.status(401).json({ error: "Unauthorized", requestId: req.id });
      }

      if (!userId) {
        return res.status(401).json({ error: "Unauthorized - No user ID", requestId: req.id });
      }

      const { organizationId: explicitOrgId } = req.body;
      const supabase = getSupabaseAdmin();
      const organizationId = explicitOrgId || await resolveOrganizationId(supabase, userId, activeOrgId);

      if (!organizationId) {
        return res.status(400).json({ error: "Missing organizationId", requestId: req.id });
      }

      const { data: creds, error: credsError } = await supabase
        .from("agent_email_credentials")
        .select("*")
        .eq("organization_id", organizationId)
        .single();

      if (credsError || !creds) {
        return res.json({ connected: false, message: "No Sales Agent email connected" });
      }

      // Decrypt and validate refresh token
      let refreshToken = creds.refresh_token;

      if (!refreshToken.startsWith("1//")) {
        const { data: decrypted } = await supabase.rpc("decrypt_token", {
          encrypted_token: creds.refresh_token,
        });
        if (decrypted) refreshToken = decrypted;
      }

      const { clientId, clientSecret } = getGoogleCredentials();
      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId!,
          client_secret: clientSecret!,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      });

      if (tokenResponse.ok) {
        await supabase
          .from("agent_email_credentials")
          .update({ last_verified_at: new Date().toISOString(), verification_status: "verified" })
          .eq("id", creds.id);

        return res.json({ connected: true, email: creds.email_address, verifiedAt: new Date().toISOString() });
      } else {
        await supabase
          .from("agent_email_credentials")
          .update({ verification_status: "failed" })
          .eq("id", creds.id);

        return res.json({
          connected: true,
          email: creds.email_address,
          valid: false,
          message: "Token refresh failed - reconnect required",
        });
      }
    } catch (error) {
      req.log.error({ err: error }, "Sales Agent email verify error");
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
        requestId: req.id,
      });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/oauth/agent-email/revoke
// Disconnect Sales Agent email by deleting credentials
// ---------------------------------------------------------------------------

router.post(
  "/oauth/agent-email/revoke",
  async (req: Request, res: Response) => {
    try {
      let userId: string | null = null;
      let activeOrgId: string | null | undefined;
      try {
        const auth = getAuth(req);
        userId = auth.userId;
        activeOrgId = auth.orgId;
      } catch (authErr) {
        return res.status(401).json({ error: "Unauthorized", requestId: req.id });
      }

      if (!userId) {
        return res.status(401).json({ error: "Unauthorized - No user ID", requestId: req.id });
      }

      const { organizationId: explicitOrgId } = req.body;
      const supabase = getSupabaseAdmin();
      const organizationId = explicitOrgId || await resolveOrganizationId(supabase, userId, activeOrgId);

      if (!organizationId) {
        return res.status(400).json({ error: "Missing organizationId", requestId: req.id });
      }

      const isAdmin = await verifyOrgAdmin(supabase, userId, organizationId);
      if (!isAdmin) {
        return res.status(403).json({ error: "Must be org admin or owner", requestId: req.id });
      }

      await supabase
        .from("agent_email_credentials")
        .delete()
        .eq("organization_id", organizationId);

      req.log.info({ organizationId }, "Revoked Sales Agent email");
      return res.json({ success: true, message: "Sales Agent email disconnected" });
    } catch (error) {
      req.log.error({ err: error }, "Sales Agent email revoke error");
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
        requestId: req.id,
      });
    }
  }
);
// ---------------------------------------------------------------------------
// GET /api/oauth/attio/callback
// Handle Attio MCP OAuth callback — exchange code for tokens via PKCE
// ---------------------------------------------------------------------------

router.get(
  "/oauth/attio/callback",
  async (req: Request, res: Response) => {
    const frontendUrl = process.env.FRONTEND_URL || "https://your-app.example.com";

    try {
      const { code, state, error } = req.query as Record<string, string>;

      if (error) {
        req.log.info({ error }, "User denied Attio OAuth");
        return res.redirect(`${frontendUrl}/profile?attio_error=denied`);
      }

      if (!code || !state) {
        return res.redirect(`${frontendUrl}/profile?attio_error=invalid_callback`);
      }

      const supabase = getSupabaseAdmin();
      // 1. Look up pending state (only if not expired)
      const { data: pending, error: lookupError } = await supabase
        .from("attio_oauth_pending")
        .select("*")
        .eq("state", state)
        .gte('expires_at', new Date().toISOString())
        .maybeSingle();

      if (lookupError || !pending) {
        req.log.error({ state }, "Invalid or expired Attio OAuth state");
        return res.redirect(`${frontendUrl}/profile?attio_error=invalid_state`);
      }

      // Clean up pending entry
      await supabase.from("attio_oauth_pending").delete().eq("state", state);

      req.log.info({ userId: pending.user_id }, "Processing Attio callback");

      // 2. Exchange code for tokens (PKCE — code_verifier instead of client_secret)
      const tokenBody: Record<string, string> = {
        grant_type: "authorization_code",
        code,
        redirect_uri: pending.redirect_uri,
        client_id: pending.client_id,
        code_verifier: pending.code_verifier,
      };

      // Decrypt the client_secret that was encrypted before storing in pending table
      if (pending.client_secret) {
        const { data: decryptedSecret } = await supabase.rpc('decrypt_token', { encrypted_token: pending.client_secret });
        if (decryptedSecret) {
          tokenBody.client_secret = decryptedSecret;
        }
      }

      const tokenResponse = await fetch(pending.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tokenBody),
      });

      if (!tokenResponse.ok) {
        const fields = await extractOAuthErrorFields(tokenResponse);
        req.log.error(fields, "Attio token exchange failed");
        return res.redirect(`${frontendUrl}/profile?attio_error=token_exchange_failed`);
      }

      const tokenData = await tokenResponse.json();
      const accessToken = tokenData.access_token;
      const refreshToken = tokenData.refresh_token || null;

      if (!accessToken) {
        req.log.error("No access_token in Attio token response");
        return res.redirect(`${frontendUrl}/profile?attio_error=no_token`);
      }

      // 3. Capture workspace identity (id + name + slug) from the new token.
      //    workspace_id is load-bearing — drives the takeover-rejection check
      //    and prevents silently overwriting another user's connection. Name
      //    and slug are display-only; nullable on degraded paths.
      const workspaceMetadata = await fetchAttioWorkspaceMetadata(accessToken);
      const newWorkspaceId = workspaceMetadata.id;

      const orgId = pending.organization_id;
      if (!orgId) {
        return res.redirect(`${frontendUrl}/profile?attio_error=no_organization`);
      }

      // 4. Detect deliberate-takeover scenario before doing any token writes.
      //    If an active row already exists for this org with a different
      //    workspace_id, refuse to overwrite — the org has to disconnect
      //    explicitly first (avoids orphaning past dossiers' crm_deal_id
      //    pointers in the previous workspace).
      //
      //    Same workspace_id (or no existing row) → proceed; the row is
      //    deleted then re-inserted below to refresh tokens cleanly.
      const { data: existingCreds } = await supabase
        .from("attio_credentials")
        .select("attio_workspace_id, workspace_name")
        .eq("organization_id", orgId)
        .maybeSingle();

      if (
        existingCreds?.attio_workspace_id &&
        newWorkspaceId &&
        existingCreds.attio_workspace_id !== newWorkspaceId
      ) {
        req.log.info(
          {
            orgId,
            existingWorkspaceId: existingCreds.attio_workspace_id,
            newWorkspaceId,
          },
          "Attio takeover refused — org already connected to a different workspace",
        );
        return res.redirect(
          `${frontendUrl}/profile?attio_error=workspace_conflict`,
        );
      }

      // 5. Encrypt access token (and refresh token if present)
      const { data: encryptedAccess, error: encryptError } = await supabase.rpc(
        "encrypt_token",
        { token: accessToken }
      );

      if (encryptError || !encryptedAccess) {
        req.log.error({ err: encryptError }, "Error encrypting Attio access token");
        return res.redirect(`${frontendUrl}/profile?attio_error=encryption_failed`);
      }

      let encryptedRefresh: string | null = null;
      if (refreshToken) {
        const { data, error: refErr } = await supabase.rpc(
          "encrypt_token",
          { token: refreshToken }
        );
        if (!refErr && data) encryptedRefresh = data;
      }

      // 6. Upsert credentials (same-workspace replace = clean refresh).
      await supabase
        .from("attio_credentials")
        .delete()
        .eq("organization_id", orgId);

      // pending.client_secret is already encrypted (encrypted before storing in
      // attio_oauth_pending at connect time) — pass through directly.
      const encryptedClientSecret: string | null = pending.client_secret || null;

      // Compute token expiry from expires_in if available
      let tokenExpiry: string | null = null;
      if (tokenData.expires_in) {
        tokenExpiry = new Date(
          Date.now() + tokenData.expires_in * 1000
        ).toISOString();
      }

      const insertPayload: Record<string, unknown> = {
        organization_id: orgId,
        connected_by_user_id: pending.user_id,
        access_token_encrypted: encryptedAccess,
        attio_workspace_id: newWorkspaceId,
        workspace_name: workspaceMetadata.name,
        workspace_slug: workspaceMetadata.slug,
        connected_at: new Date().toISOString(),
        status: "active",
        // OAuth metadata for token refresh
        oauth_client_id: pending.client_id,
        oauth_client_secret: encryptedClientSecret,
        oauth_token_endpoint: pending.token_endpoint,
        token_expiry: tokenExpiry,
      };
      if (encryptedRefresh) {
        insertPayload.refresh_token_encrypted = encryptedRefresh;
      }

      const { error: insertError } = await supabase
        .from("attio_credentials")
        .insert(insertPayload);

      if (insertError) {
        req.log.error({ err: insertError }, "Error storing Attio credentials");
        return res.redirect(`${frontendUrl}/profile?attio_error=storage_failed`);
      }

      req.log.info(
        {
          orgId,
          userId: pending.user_id,
          workspaceId: newWorkspaceId,
          hasName: !!workspaceMetadata.name,
          hasSlug: !!workspaceMetadata.slug,
        },
        "Attio connected",
      );
      return res.redirect(`${frontendUrl}/profile?attio_connected=true`);
    } catch (error) {
      req.log.error({ err: error }, "Attio callback error");
      return res.redirect(`${frontendUrl}/profile?attio_error=callback_failed`);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/oauth/attio/status
// Check Attio connection status for the authenticated user's org
// ---------------------------------------------------------------------------

router.get(
  "/oauth/attio/status",
  async (req: Request, res: Response) => {
    try {
      let userId: string | null = null;
      let activeOrgId: string | null | undefined;
      try {
        const auth = getAuth(req);
        userId = auth.userId;
        activeOrgId = auth.orgId;
      } catch {
        return res.status(401).json({ error: "Unauthorized", requestId: req.id });
      }

      if (!userId) {
        return res.status(401).json({ error: "Unauthorized", requestId: req.id });
      }

      const supabase = getSupabaseAdmin();
      const orgId = await resolveOrganizationId(supabase, userId, activeOrgId);

      if (!orgId) {
        return res.json({ connected: false, requestId: req.id });
      }

      const { data, error } = await supabase
        .from("attio_credentials")
        .select(
          "status, connected_at, attio_workspace_id, workspace_name, workspace_slug, connected_by_user_id",
        )
        .eq("organization_id", orgId)
        .maybeSingle();

      if (error) {
        // Table may not exist yet — treat as not connected
        req.log.error({ err: error }, "Error checking Attio status");
        return res.json({ connected: false, requestId: req.id });
      }

      // Resolve the connector's display name + count of dossiers that
      // reference this Attio workspace (used by the disconnect-confirmation
      // warning and the workspace_conflict toast). Both are best-effort —
      // failure here just means the UI shows fewer details.
      let connectorName: string | null = null;
      let orphanCount = 0;
      if (data) {
        const [profileResult, orphanResult] = await Promise.all([
          data.connected_by_user_id
            ? supabase
                .from("profiles")
                .select("first_name, last_name, email")
                .eq("user_id", data.connected_by_user_id)
                .maybeSingle()
            : Promise.resolve({ data: null, error: null } as const),
          supabase
            .from("prospect_dossiers")
            .select("id", { count: "exact", head: true })
            .eq("organization_id", orgId)
            .eq("crm_provider", "attio")
            .not("crm_deal_id", "is", null),
        ]);
        const profile = (profileResult as { data?: { first_name?: string | null; last_name?: string | null; email?: string | null } | null }).data;
        if (profile) {
          const parts = [profile.first_name, profile.last_name].filter((p): p is string => !!p && p.length > 0);
          connectorName = parts.length > 0 ? parts.join(" ") : profile.email ?? null;
        }
        const orphanCountValue = (orphanResult as { count?: number | null }).count;
        if (typeof orphanCountValue === "number") {
          orphanCount = orphanCountValue;
        }
      }

      return res.json({
        connected: !!data && data.status === "active",
        status: data?.status || null,
        connected_at: data?.connected_at || null,
        workspace_id: data?.attio_workspace_id || null,
        workspace_name: data?.workspace_name || null,
        workspace_slug: data?.workspace_slug || null,
        connector_name: connectorName,
        dossier_count: orphanCount,
        requestId: req.id,
      });
    } catch (error) {
      req.log.error({ err: error }, "Attio status error");
      return res.status(500).json({ error: "Internal server error", requestId: req.id });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/oauth/attio/disconnect
// Remove stored Attio credentials for the authenticated user's org
// ---------------------------------------------------------------------------

router.post(
  "/oauth/attio/disconnect",
  async (req: Request, res: Response) => {
    try {
      let userId: string | null = null;
      let activeOrgId: string | null | undefined;
      try {
        const auth = getAuth(req);
        userId = auth.userId;
        activeOrgId = auth.orgId;
      } catch {
        return res.status(401).json({ error: "Unauthorized", requestId: req.id });
      }

      if (!userId) {
        return res.status(401).json({ error: "Unauthorized", requestId: req.id });
      }

      const supabase = getSupabaseAdmin();
      const orgId = await resolveOrganizationId(supabase, userId, activeOrgId);

      if (!orgId) {
        return res.status(400).json({ error: "No organization found", requestId: req.id });
      }

      // Attio's OAuth 2.0 implementation exposes only /oauth/authorize,
      // /oauth/token, and /oauth/introspect — there is no revocation endpoint
      // (verified against developers.attio.com). Disconnecting here deletes the
      // local credential row only; users who want to fully revoke Sales Agent's
      // access must remove the integration from Attio's workspace settings.
      const { error: deleteError } = await supabase
        .from("attio_credentials")
        .delete()
        .eq("organization_id", orgId);

      if (deleteError) {
        req.log.error({ err: deleteError }, "Error deleting Attio credentials");
        return res.status(500).json({ error: "Failed to disconnect Attio", requestId: req.id });
      }

      req.log.info({ orgId }, "Attio disconnected (local credentials only — Attio has no revoke endpoint)");

      return res.json({
        success: true,
        message: "Attio disconnected successfully",
        requestId: req.id,
      });
    } catch (error) {
      req.log.error({ err: error }, "Attio disconnect error");
      return res.status(500).json({ error: "Internal server error", requestId: req.id });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/oauth/slack/disconnect
// Soft-delete the active org's slack_bot oauth_connection (is_active=false).
// Slack credentials are org-scoped, not user-scoped — admin-only action.
// ---------------------------------------------------------------------------

router.post(
  "/oauth/slack/disconnect",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const { userId, orgId: activeOrgId, orgRole } = auth;

      if (!userId) {
        return res.status(401).json({
          error: "Unauthorized - No user ID in session",
          requestId: req.id,
        });
      }

      if (!activeOrgId) {
        return res.status(403).json({
          error: "No organization context",
          requestId: req.id,
        });
      }

      if (!isOrgAdmin(orgRole)) {
        return res.status(403).json({
          error: "Org admin role required",
          requestId: req.id,
        });
      }

      const supabase = getSupabaseAdmin();
      const organizationId = await resolveOrganizationId(supabase, userId, activeOrgId);

      if (!organizationId) {
        return res.status(400).json({
          error: "Could not resolve organization",
          requestId: req.id,
        });
      }

      const { error: updateError } = await supabase
        .from("oauth_connections")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("organization_id", organizationId)
        .eq("provider", "slack_bot")
        .eq("is_active", true);

      if (updateError) {
        req.log.error({ err: updateError, organizationId }, "Failed to disconnect Slack");
        return res.status(500).json({
          error: "Failed to disconnect Slack",
          requestId: req.id,
        });
      }

      req.log.info({ userId, organizationId }, "Slack disconnected");

      return res.json({ success: true, requestId: req.id });
    } catch (error) {
      req.log.error({ err: error }, "Slack disconnect error");
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Internal server error",
        requestId: req.id,
      });
    }
  }
);

export default router;
