/**
 * Centralized tenant resolution for Inngest functions.
 *
 * Replaces inline org-resolution queries that were duplicated across
 * gmail-notification, poll-gmail-inboxes, autonomous-email-agent,
 * slack-message, and slack-interaction.
 *
 * All resolvers use 5-minute in-memory caches and the service-role
 * Supabase client (via getSupabaseAdmin).
 */

import { getSupabaseAdmin } from "./supabase";

const TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Organization resolver (for Gmail/email paths) ─────────────────────────

type OrgCacheEntry = { expiresAt: number; value: string | null };
const orgForUserCache = new Map<string, OrgCacheEntry>();

/**
 * Resolve organization ID for a user via `organization_users` membership.
 * Returns the user's oldest org membership. Cached for 5 minutes per userId.
 *
 * Replaces inline queries in: gmail-notification.ts, poll-gmail-inboxes.ts,
 * autonomous-email-agent.ts, and all Inngest function fallback paths.
 */
export async function resolveOrgForUser(userId: string): Promise<string | null> {
  const now = Date.now();
  const cached = orgForUserCache.get(userId);
  if (cached && cached.expiresAt > now) return cached.value;

  const supabase = getSupabaseAdmin();
  const { data: membership } = await supabase
    .from("organization_users")
    .select("organization_id")
    .eq("user_id", userId)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const orgId = membership?.organization_id || null;
  orgForUserCache.set(userId, { expiresAt: now + TTL_MS, value: orgId });
  return orgId;
}

// ─── Slack user mapping resolver (for Slack paths) ─────────────────────────

export interface SlackUserMapping {
  agentUserId: string;
  organizationId: string | null;
}

type SlackMappingCacheEntry = {
  expiresAt: number;
  value: SlackUserMapping | null;
};
const slackUserMappingCache = new Map<string, SlackMappingCacheEntry>();

/**
 * Resolve a Slack user to their Sales Agent user ID and organization.
 * Cached for 5 minutes per slackUserId:workspaceId.
 *
 * Includes 2-tier org fallback:
 *   1. slack_user_mappings.organization_id
 *   2. organization_users (oldest membership, with backfill to mapping)
 *
 * NOTE: Does NOT handle auto-linking on first message — that logic
 * remains in slack-message.ts since it requires Slack API calls.
 */
export async function resolveSlackUserMapping(
  slackUserId: string,
  slackWorkspaceId: string,
): Promise<SlackUserMapping | null> {
  const cacheKey = `${slackUserId}:${slackWorkspaceId}`;
  const now = Date.now();
  const cached = slackUserMappingCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;

  const supabase = getSupabaseAdmin();
  const { data: mapping, error } = await supabase
    .from("slack_user_mappings")
    .select("agent_user_id, organization_id")
    .eq("slack_workspace_id", slackWorkspaceId)
    .eq("slack_user_id", slackUserId)
    .eq("is_active", true)
    .maybeSingle();

  if (error || !mapping?.agent_user_id) {
    slackUserMappingCache.set(cacheKey, { expiresAt: now + TTL_MS, value: null });
    return null;
  }

  let organizationId = mapping.organization_id as string | null;

  // Tier 2: organization_users (oldest membership, with backfill to mapping)
  if (!organizationId) {
    organizationId = await resolveOrgForUser(mapping.agent_user_id);
    if (organizationId) {
      // Backfill slack_user_mappings so future lookups skip tier 2
      await supabase
        .from("slack_user_mappings")
        .update({ organization_id: organizationId })
        .eq("slack_user_id", slackUserId)
        .eq("slack_workspace_id", slackWorkspaceId);
    }
  }

  const result: SlackUserMapping = {
    agentUserId: mapping.agent_user_id,
    organizationId,
  };

  slackUserMappingCache.set(cacheKey, { expiresAt: now + TTL_MS, value: result });
  return result;
}

/**
 * Invalidate cached Slack user mapping (e.g., after auto-linking or unlinking).
 */
export function invalidateSlackUserMappingCache(
  slackUserId: string,
  slackWorkspaceId: string,
): void {
  slackUserMappingCache.delete(`${slackUserId}:${slackWorkspaceId}`);
}

/** @internal Exposed for tests only. */
export function __resetTenantResolverCacheForTests(): void {
  orgForUserCache.clear();
  slackUserMappingCache.clear();
}
