/**
 * Shared Slack helpers — single source of truth for workspace lookups,
 * token decryption, and Slack API wrappers.
 *
 * Extracted from slack-message.ts, slack-interaction.ts, and handle-chat-message.ts.
 */

import { getSupabaseAdmin } from "./supabase";
import { logger } from "../../lib/logger";

const log = logger.child({ util: "slack-helpers" });

const SLACK_API_TIMEOUT_MS = 30_000; // 30s timeout for Slack API calls

// ─── In-memory cache (follows tenant-context.ts pattern) ────────────────────

const WORKSPACE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

type WorkspaceCacheEntry = {
  expiresAt: number;
  value: { id: string; botToken: string };
};

const workspaceTokenCache = new Map<string, WorkspaceCacheEntry>();

/**
 * Invalidate cached workspace+token (e.g. on Slack API 401).
 */
export function invalidateWorkspaceCache(teamId: string): void {
  const slackAppId = process.env.SLACK_APP_ID || "legacy";
  workspaceTokenCache.delete(`${teamId}:${slackAppId}`);
}

/** @internal Exposed for tests only. */
export function __resetWorkspaceCacheForTests(): void {
  workspaceTokenCache.clear();
}

// ─── Workspace lookup ────────────────────────────────────────────────────────

export async function getWorkspaceByTeamId(teamId: string, eventSlackAppId?: string) {
  const supabase = getSupabaseAdmin();
  const slackAppId = eventSlackAppId || process.env.SLACK_APP_ID;

  let query = supabase
    .from("slack_workspaces")
    .select("id, bot_token")
    .eq("team_id", teamId)
    .eq("is_active", true);

  if (slackAppId) {
    query = query.eq("slack_app_id", slackAppId);
  }

  const { data, error } = await query.maybeSingle();

  if (error || !data) {
    log.error({ teamId, slackAppId: slackAppId ?? "legacy" }, "Workspace not found");
    return null;
  }

  return data;
}

// ─── Token decryption ────────────────────────────────────────────────────────

const PLAINTEXT_PREFIXES = ["xoxb-", "xoxp-", "xoxe-", "xapp-"];

export async function decryptBotToken(encryptedToken: string): Promise<string> {
  if (PLAINTEXT_PREFIXES.some((p) => encryptedToken.startsWith(p))) {
    return encryptedToken;
  }

  const supabase = getSupabaseAdmin();

  // Primary path: decrypt_token, whose key lives in app_secrets — this matches
  // encrypt_token used by the Slack OAuth callback, so it covers all current
  // installs.
  const { data: decrypted, error } = await supabase.rpc("decrypt_token", {
    encrypted_token: encryptedToken,
  });
  if (!error && decrypted) {
    return decrypted;
  }

  // Fallback: legacy workspaces whose bot token was encrypted with
  // SLACK_TOKEN_ENCRYPTION_KEY via decrypt_slack_token. Only reached when the
  // primary path fails, so it cannot regress a working install.
  const encryptionKey = process.env.SLACK_TOKEN_ENCRYPTION_KEY;
  if (encryptionKey) {
    const { data: legacyDecrypted } = await supabase.rpc("decrypt_slack_token", {
      encrypted_token: encryptedToken,
      encryption_key: encryptionKey,
    });
    if (legacyDecrypted) {
      return legacyDecrypted;
    }
  }

  throw new Error(
    `Failed to decrypt Slack token: ${error?.message ?? "no matching encryption key"}`,
  );
}

// ─── Combined workspace + token lookup with caching ─────────────────────────

/**
 * Get workspace ID and decrypted bot token in one call, with 10-minute
 * in-memory cache. Falls back to DB + RPC on cache miss.
 *
 * Call `invalidateWorkspaceCache(teamId)` on Slack API 401 to bust stale tokens.
 */
export async function getWorkspaceWithToken(
  teamId: string,
  eventSlackAppId?: string,
): Promise<{ id: string; botToken: string } | null> {
  const slackAppId = eventSlackAppId || process.env.SLACK_APP_ID || "legacy";
  const cacheKey = `${teamId}:${slackAppId}`;
  const now = Date.now();

  const cached = workspaceTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const workspace = await getWorkspaceByTeamId(teamId, eventSlackAppId);
  if (!workspace) return null;

  const botToken = await decryptBotToken(workspace.bot_token);
  const entry = { id: workspace.id, botToken };

  workspaceTokenCache.set(cacheKey, {
    expiresAt: now + WORKSPACE_CACHE_TTL_MS,
    value: entry,
  });

  return entry;
}

// ─── Slack API wrappers ──────────────────────────────────────────────────────

const SLACK_AUTH_ERRORS = new Set(["invalid_auth", "token_revoked", "not_authed", "account_inactive"]);

export interface SlackPostResult {
  ok: boolean;
  ts?: string;
  channel?: string;
  error?: string;
}

function handleAuthError(result: SlackPostResult, teamId?: string): void {
  if (teamId && result.error && SLACK_AUTH_ERRORS.has(result.error)) {
    log.warn({ authError: result.error, teamId }, "Auth error, invalidating cached token");
    invalidateWorkspaceCache(teamId);
  }
}

export async function sendSlackMessage(
  botToken: string,
  channel: string,
  text: string,
  threadTs?: string,
  teamId?: string,
): Promise<SlackPostResult> {
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({
      channel,
      text,
      thread_ts: threadTs,
    }),
    signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
  });
  const result = await resp.json() as SlackPostResult;
  handleAuthError(result, teamId);
  return result;
}

export async function sendSlackBlockMessage(
  botToken: string,
  channel: string,
  text: string,
  blocks: any[],
  threadTs?: string,
  teamId?: string,
): Promise<SlackPostResult> {
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({
      channel,
      text,
      blocks,
      thread_ts: threadTs,
    }),
    signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
  });
  const result = await resp.json() as SlackPostResult;
  handleAuthError(result, teamId);
  return result;
}

export async function updateSlackMessage(
  botToken: string,
  channel: string,
  ts: string,
  text: string,
  blocks?: any[],
  teamId?: string,
): Promise<SlackPostResult> {
  const body: Record<string, any> = { channel, ts, text };
  if (blocks) body.blocks = blocks;

  const resp = await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
  });
  const result = await resp.json() as SlackPostResult;
  handleAuthError(result, teamId);
  return result;
}

export async function deleteSlackMessage(
  botToken: string,
  channel: string,
  ts: string,
  teamId?: string,
): Promise<void> {
  const resp = await fetch("https://slack.com/api/chat.delete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel, ts }),
    signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
  });
  const result = await resp.json() as SlackPostResult;
  handleAuthError(result, teamId);
}

/**
 * Get a deep-link permalink to a specific Slack message. Used by the error
 * reporter so developers can click straight into the real conversation.
 *
 * Returns null on any failure — never throws.
 */
export async function getSlackPermalink(
  botToken: string,
  channel: string,
  messageTs: string,
): Promise<string | null> {
  try {
    const resp = await fetch(
      `https://slack.com/api/chat.getPermalink?channel=${encodeURIComponent(channel)}&message_ts=${encodeURIComponent(messageTs)}`,
      { headers: { Authorization: `Bearer ${botToken}` }, signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS) },
    );
    const data = await resp.json() as { ok: boolean; permalink?: string };
    return data.ok && data.permalink ? data.permalink : null;
  } catch (err) {
    log.warn({ err }, "getSlackPermalink failed");
    return null;
  }
}

// ─── DM delivery ────────────────────────────────────────────────────────────

export interface PostDmResult {
  ok: boolean;
  channel: string | null;
  ts: string | null;
  error?: string;
}

/**
 * Resolve a user's Slack mapping → open a DM channel → post there.
 *
 * Uses the user-level `slack_user_mappings` row (not org-level settings) so
 * the message routes through the correct Slack app install for the user's
 * env (dev vs staging vs prod). See meeting-followup.ts for the reference
 * pattern this consolidates.
 *
 * Never throws. Returns `{ ok: false }` with a structured `error` reason so
 * callers can skip gracefully without try/catching every autonomous notify.
 */
export async function postDmToUser(opts: {
  agentUserId: string;
  organizationId: string;
  text: string;
  blocks?: unknown[];
  threadTs?: string;
}): Promise<PostDmResult> {
  const { agentUserId, organizationId, text, blocks, threadTs } = opts;
  const supabase = getSupabaseAdmin();

  const { data: mapping, error: mappingErr } = await supabase
    .from("slack_user_mappings")
    .select("slack_user_id, slack_workspace_id")
    .eq("agent_user_id", agentUserId)
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (mappingErr) {
    log.error({ err: mappingErr, agentUserId, organizationId }, "postDmToUser: slack_user_mappings read failed");
    return { ok: false, channel: null, ts: null, error: "mapping_query_failed" };
  }
  if (!mapping?.slack_user_id || !mapping?.slack_workspace_id) {
    return { ok: false, channel: null, ts: null, error: "no_slack_mapping" };
  }

  const { data: workspace, error: wsErr } = await supabase
    .from("slack_workspaces")
    .select("id, team_id, bot_token, is_active")
    .eq("id", mapping.slack_workspace_id)
    .eq("is_active", true)
    .maybeSingle();

  if (wsErr) {
    log.error({ err: wsErr, slackWorkspaceId: mapping.slack_workspace_id }, "postDmToUser: slack_workspaces read failed");
    return { ok: false, channel: null, ts: null, error: "workspace_query_failed" };
  }
  if (!workspace?.bot_token) {
    return { ok: false, channel: null, ts: null, error: "no_bot_token" };
  }

  let botToken: string;
  try {
    botToken = await decryptBotToken(workspace.bot_token);
  } catch (err) {
    log.error({ err, slackWorkspaceId: workspace.id }, "postDmToUser: bot_token decrypt failed");
    return { ok: false, channel: null, ts: null, error: "token_decrypt_failed" };
  }

  const openResp = await fetch("https://slack.com/api/conversations.open", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ users: mapping.slack_user_id }),
    signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
  });
  const openData = (await openResp.json()) as { ok: boolean; channel?: { id: string }; error?: string };
  if (!openData.ok || !openData.channel?.id) {
    log.error({ slackUserId: mapping.slack_user_id, error: openData.error }, "postDmToUser: conversations.open failed");
    handleAuthError({ ok: false, error: openData.error }, workspace.team_id);
    return { ok: false, channel: null, ts: null, error: openData.error || "conversations_open_failed" };
  }

  const dmChannelId = openData.channel.id;

  const postResp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({
      channel: dmChannelId,
      text,
      ...(blocks ? { blocks } : {}),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }),
    signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
  });
  const postData = (await postResp.json()) as SlackPostResult;
  handleAuthError(postData, workspace.team_id);

  if (!postData.ok) {
    log.error({ agentUserId, error: postData.error }, "postDmToUser: chat.postMessage failed");
    return { ok: false, channel: dmChannelId, ts: null, error: postData.error || "postmessage_failed" };
  }
  return { ok: true, channel: dmChannelId, ts: postData.ts ?? null };
}

// ─── Thread context ─────────────────────────────────────────────────────────

/**
 * Fetch messages from a Slack thread so the agent can see prior conversation
 * context even if it hasn't processed those messages before.
 *
 * Requires `channels:history` (public) and/or `groups:history` (private) scopes.
 */
export async function fetchSlackThread(
  botToken: string,
  channel: string,
  threadTs: string,
  teamId?: string,
): Promise<Array<{ role: string; content: string }>> {
  try {
    const resp = await fetch(
      `https://slack.com/api/conversations.replies?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(threadTs)}&limit=20`,
      {
        headers: { Authorization: `Bearer ${botToken}` },
      },
    );
    const data = await resp.json() as any;

    if (!data.ok) {
      handleAuthError({ ok: false, error: data.error }, teamId);
      return [];
    }
    if (!data.messages?.length) return [];

    const history: Array<{ role: string; content: string }> = [];

    for (const msg of data.messages) {
      if (msg.subtype) continue;
      let text = (msg.text || "").trim();
      if (!text) continue;

      // Strip bot @mentions (e.g. <@U12345>)
      text = text.replace(/<@[A-Z0-9]+>/g, "").trim();
      if (!text) continue;

      const role = msg.bot_id ? "assistant" : "user";
      history.push({ role, content: text });
    }

    // Drop the last message — it's the current @mention we're already processing
    if (history.length > 0) history.pop();

    return history;
  } catch (err: any) {
    log.warn({ err }, "Could not fetch thread context");
    return [];
  }
}
