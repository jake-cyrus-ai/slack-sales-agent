/**
 * Google OAuth Helper for Vercel Workflow Functions
 *
 * Retrieves and refreshes Google OAuth tokens from calendar_credentials table
 * for use in Gmail and Calendar API calls within Vercel Workflow workflows.
 * 
 * Converted from Deno to Node.js for Vercel Workflow compatibility.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../../../lib/logger";

const log = logger.child({ util: "google-auth" });

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  calendarEmail: string;
}

// ============================================================================
// Structured Logging & Alerting
// ============================================================================

const SLACK_ENGINEERING_WEBHOOK_URL = process.env.SLACK_ENGINEERING_WEBHOOK_URL;

interface OAuthRefreshFailureAlert {
  userId: string;
  calendarEmail?: string;
  errorCode: string;
  errorMessage: string;
  httpStatus?: number;
  requiresReauth: boolean;
}

const sendOAuthFailureAlert = async (details: OAuthRefreshFailureAlert): Promise<void> => {
  if (!SLACK_ENGINEERING_WEBHOOK_URL) {
    log.warn({ userId: details.userId }, "Cannot send OAuth failure alert - SLACK_ENGINEERING_WEBHOOK_URL not configured");
    return;
  }

  const timestamp = new Date().toISOString();
  const severityEmoji = details.requiresReauth ? "🚨" : "⚠️";
  const severityText = details.requiresReauth ? "CRITICAL" : "WARNING";

  const slackPayload = {
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${severityEmoji} Google OAuth Token Refresh Failed`,
          emoji: true,
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Severity:*\n${severityText}`,
          },
          {
            type: "mrkdwn",
            text: `*Time:*\n${timestamp}`,
          },
        ],
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*User ID:*\n\`${details.userId}\``,
          },
          {
            type: "mrkdwn",
            text: `*Calendar Email:*\n${details.calendarEmail || "N/A"}`,
          },
        ],
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Error Code:*\n\`${details.errorCode}\``,
          },
          {
            type: "mrkdwn",
            text: `*HTTP Status:*\n${details.httpStatus || "N/A"}`,
          },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Error Message:*\n\`\`\`${details.errorMessage}\`\`\``,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: details.requiresReauth
            ? "⚠️ *User must re-authenticate with Google to restore Gmail/Calendar integrations.*"
            : "ℹ️ This may be a temporary issue. The system will retry.",
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Affected integrations: Gmail, Google Calendar",
          },
        ],
      },
      {
        type: "divider",
      },
    ],
  };

  try {
    const response = await fetch(SLACK_ENGINEERING_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(slackPayload),
    });

    if (!response.ok) {
      const responseText = await response.text();
      log.error({ userId: details.userId, httpStatus: response.status, errorMessage: responseText, operation: "send-slack-alert" }, "Failed to send OAuth failure alert to Slack");
    } else {
      log.info({ userId: details.userId, operation: "send-slack-alert" }, "OAuth failure alert sent to Slack");
    }
  } catch (alertError) {
    log.error({ userId: details.userId, errorMessage: alertError instanceof Error ? alertError.message : String(alertError), operation: "send-slack-alert" }, "Exception sending OAuth failure alert to Slack");
  }
};

/**
 * Get Google OAuth tokens for a user
 * Automatically refreshes if expired
 */
export async function getGoogleTokens(
  supabase: SupabaseClient,
  userId: string,
  organizationId?: string | null
): Promise<GoogleTokens | null> {
  try {
    log.debug({ userId, operation: "get-tokens" }, "Fetching Google credentials");

    // Fetch calendar credentials
    let query = supabase
      .from('calendar_credentials')
      .select('access_token_encrypted, refresh_token_encrypted, token_expiry, calendar_email')
      .eq('user_id', userId)
      .eq('sync_status', 'active');
    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }
    const { data: credentials, error } = await query.order('connected_at', { ascending: false }).limit(1).maybeSingle();

    if (error || !credentials) {
      log.debug({ userId, operation: "get-tokens", errorMessage: error?.message, errorCode: error?.code }, "No active Google credentials found");
      return null;
    }

    // Decrypt tokens using RPC function
    const { data: decrypted, error: decryptError } = await supabase.rpc('decrypt_token', {
      encrypted_access: credentials.access_token_encrypted,
      encrypted_refresh: credentials.refresh_token_encrypted,
    });

    if (decryptError || !decrypted) {
      log.error({ userId, calendarEmail: credentials.calendar_email, operation: "decrypt-tokens", errorMessage: decryptError?.message, errorCode: decryptError?.code }, "Failed to decrypt Google OAuth tokens");
      return null;
    }

    const expiresAt = new Date(credentials.token_expiry);
    const now = new Date();

    // Check if token is expired or will expire in next 5 minutes
    const needsRefresh = expiresAt.getTime() - now.getTime() < 5 * 60 * 1000;

    if (needsRefresh) {
      log.debug({ userId, calendarEmail: credentials.calendar_email, operation: "token-refresh", tokenExpiresAt: expiresAt.toISOString(), timeUntilExpiry: Math.round((expiresAt.getTime() - now.getTime()) / 1000) }, "Access token expired or expiring soon, initiating refresh");
      return await refreshGoogleToken(supabase, userId, decrypted.refresh_token, credentials.calendar_email);
    }

    log.debug({ userId, calendarEmail: credentials.calendar_email, operation: "get-tokens" }, "Google tokens retrieved successfully");

    return {
      accessToken: decrypted.access_token,
      refreshToken: decrypted.refresh_token,
      expiresAt,
      calendarEmail: credentials.calendar_email,
    };
  } catch (error) {
    log.error({ userId, operation: "get-tokens", errorMessage: error instanceof Error ? error.message : String(error) }, "Unexpected error getting Google tokens");
    return null;
  }
}

/**
 * Refresh Google OAuth access token
 */
async function refreshGoogleToken(
  supabase: SupabaseClient,
  userId: string,
  refreshToken: string,
  calendarEmail?: string
): Promise<GoogleTokens | null> {
  try {
    const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      log.error({ userId, calendarEmail, operation: "token-refresh", errorCode: "MISSING_CREDENTIALS" }, "Missing Google OAuth credentials in environment");

      await sendOAuthFailureAlert({
        userId,
        calendarEmail,
        errorCode: "MISSING_CREDENTIALS",
        errorMessage: "GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not configured",
        requiresReauth: false,
      });

      return null;
    }

    log.debug({ userId, calendarEmail, operation: "token-refresh", clientIdPrefix: clientId.substring(0, 20) }, "Initiating Google OAuth token refresh");

    // Call Google token endpoint
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
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

      const errorCode = errorJson.error || "UNKNOWN_ERROR";
      const errorDescription = errorJson.error_description || errorText;

      // Determine appropriate status and whether reauth is required
      // Only permanent failures (invalid_grant, invalid_client) should change sync_status.
      // Transient errors (5xx, rate limits, network blips) must NOT change status so
      // the next scheduled retry can succeed without forcing the user to reconnect.
      let newStatus: string | null = null;
      let errorMessage = errorDescription;
      let requiresReauth = false;

      if (errorCode === 'invalid_client') {
        newStatus = 'auth_required';
        errorMessage = 'OAuth client credentials mismatch - user needs to re-authenticate';
        requiresReauth = true;

        log.error({ userId, calendarEmail, operation: "token-refresh", httpStatus: response.status, errorCode, errorMessage }, "Invalid client error - OAuth credentials mismatch");
      } else if (errorCode === 'invalid_grant') {
        newStatus = 'auth_required';
        errorMessage = 'Refresh token invalid or revoked - user needs to re-authenticate';
        requiresReauth = true;

        log.error({ userId, calendarEmail, operation: "token-refresh", httpStatus: response.status, errorCode, errorMessage }, "Invalid grant - refresh token revoked or expired");
      } else {
        log.error({ userId, calendarEmail, operation: "token-refresh", httpStatus: response.status, errorCode, errorMessage }, "Google OAuth token refresh failed (transient)");
      }

      // Send alert to Slack for all refresh failures
      await sendOAuthFailureAlert({
        userId,
        calendarEmail,
        errorCode,
        errorMessage,
        httpStatus: response.status,
        requiresReauth,
      });

      // Only update sync_status for permanent failures; for transient errors
      // just record the error so the next retry proceeds normally.
      const updatePayload: Record<string, unknown> = {
        last_error: errorMessage,
        last_error_at: new Date().toISOString(),
      };
      if (newStatus) {
        updatePayload.sync_status = newStatus;
      }

      let statusQuery = supabase
        .from('calendar_credentials')
        .update(updatePayload)
        .eq('user_id', userId);
      if (calendarEmail) {
        statusQuery = statusQuery.eq('calendar_email', calendarEmail);
      }
      const { error: updateError } = await statusQuery;

      if (updateError) {
        log.error({ userId, calendarEmail, operation: "update-credential-status", errorMessage: updateError.message, errorCode: updateError.code }, "Failed to update credential status after refresh failure");
      }

      return null;
    }

    const data = await response.json();
    const newExpiresAt = new Date(Date.now() + (data.expires_in * 1000));

    // Encrypt and update tokens
    const { data: encrypted, error: encryptError } = await supabase.rpc('encrypt_token', {
      access_token: data.access_token,
      refresh_token: refreshToken,
    });

    if (encryptError || !encrypted) {
      log.error({ userId, calendarEmail, operation: "encrypt-token", errorMessage: encryptError?.message, errorCode: encryptError?.code }, "Failed to encrypt refreshed Google OAuth token");

      await sendOAuthFailureAlert({
        userId,
        calendarEmail,
        errorCode: "ENCRYPTION_FAILED",
        errorMessage: encryptError?.message || "Token encryption failed",
        requiresReauth: false,
      });

      return null;
    }

    // Update database — scope to specific credential row
    let tokenQuery = supabase
      .from('calendar_credentials')
      .update({
        access_token_encrypted: encrypted.access_token_encrypted,
        token_expiry: newExpiresAt.toISOString(),
        last_error: null,
        last_error_at: null,
      })
      .eq('user_id', userId);
    if (calendarEmail) {
      tokenQuery = tokenQuery.eq('calendar_email', calendarEmail);
    }
    const { error: updateError } = await tokenQuery;

    if (updateError) {
      log.error({ userId, calendarEmail, operation: "save-token", errorMessage: updateError.message, errorCode: updateError.code }, "Failed to save refreshed token to database");
    }

    log.info({ userId, calendarEmail, operation: "token-refresh", newTokenExpiresAt: newExpiresAt.toISOString() }, "Google OAuth token refreshed successfully");

    // Get calendar email if not provided
    let finalCalendarEmail = calendarEmail;
    if (!finalCalendarEmail) {
      const { data: creds } = await supabase
        .from('calendar_credentials')
        .select('calendar_email')
        .eq('user_id', userId)
        .order('connected_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      finalCalendarEmail = creds?.calendar_email || '';
    }

    return {
      accessToken: data.access_token,
      refreshToken,
      expiresAt: newExpiresAt,
      calendarEmail: finalCalendarEmail,
    };
  } catch (error) {
    log.error({ userId, calendarEmail, operation: "token-refresh", errorMessage: error instanceof Error ? error.message : String(error) }, "Unexpected error during Google OAuth token refresh");

    await sendOAuthFailureAlert({
      userId,
      calendarEmail,
      errorCode: "UNEXPECTED_ERROR",
      errorMessage: error instanceof Error ? error.message : String(error),
      requiresReauth: false,
    });

    return null;
  }
}

/**
 * Make authenticated request to Google API
 */
export async function makeGoogleApiRequest(
  url: string,
  accessToken: string,
  options: RequestInit = {}
): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
  });
}

/**
 * Helper to refresh access token for direct use
 * Used by functions that need to get a fresh token
 * 
 * Note: For operations tied to a specific user, prefer getGoogleTokens() which
 * provides full structured logging and alerting with user context.
 */
export async function refreshAccessToken(
  refreshToken: string,
  clientId?: string,
  clientSecret?: string,
  context?: { userId?: string; calendarEmail?: string }
): Promise<string> {
  const effectiveClientId = clientId || process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const effectiveClientSecret = clientSecret || process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;

  if (!effectiveClientId || !effectiveClientSecret) {
    log.error({ userId: context?.userId, calendarEmail: context?.calendarEmail, operation: "refresh-access-token", errorCode: "MISSING_CREDENTIALS" }, "Missing Google OAuth credentials in environment");

    if (context?.userId) {
      await sendOAuthFailureAlert({
        userId: context.userId,
        calendarEmail: context.calendarEmail,
        errorCode: "MISSING_CREDENTIALS",
        errorMessage: "GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not configured",
        requiresReauth: false,
      });
    }

    throw new Error('Missing Google OAuth credentials');
  }

  log.debug({ userId: context?.userId, calendarEmail: context?.calendarEmail, operation: "refresh-access-token" }, "Refreshing Google access token directly");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: effectiveClientId,
      client_secret: effectiveClientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
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

    const errorCode = errorJson.error || "UNKNOWN_ERROR";
    const errorDescription = errorJson.error_description || errorText;
    const requiresReauth = errorCode === 'invalid_client' || errorCode === 'invalid_grant';

    log.error({ userId: context?.userId, calendarEmail: context?.calendarEmail, operation: "refresh-access-token", httpStatus: response.status, errorCode, errorMessage: errorDescription }, "Direct Google access token refresh failed");

    if (context?.userId) {
      await sendOAuthFailureAlert({
        userId: context.userId,
        calendarEmail: context.calendarEmail,
        errorCode,
        errorMessage: errorDescription,
        httpStatus: response.status,
        requiresReauth,
      });
    }

    throw new Error(`Failed to refresh token: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  
  log.debug({ userId: context?.userId, calendarEmail: context?.calendarEmail, operation: "refresh-access-token" }, "Direct Google access token refresh succeeded");

  return data.access_token;
}
