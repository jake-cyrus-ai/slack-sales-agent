/**
 * Typed access to organization feature flags.
 *
 * Centralizes the untyped `(org?.feature_flags as any)` access pattern
 * so flag reads are consistent and easy to find/update.
 */

import { getSupabaseAdmin } from "./supabase";
import { getLocalMidnight } from "./timezone-helpers";

// ── Flag shapes ──────────────────────────────────────────────────────────────

export interface EmailAutoResponseFlags {
  enabled?: boolean;
  auto_send_enabled?: boolean;
  auto_send_threshold?: number;
  fast_path_enabled?: boolean;
  auto_triage_enabled?: boolean;
  skip_confirmation?: boolean;
}

export interface DealNudgeFlags {
  auto_followup_enabled?: boolean;
  skip_confirmation?: boolean;
}

export interface AutonomousModeFlags {
  enabled?: boolean;
  enabled_at?: string;
  disabled_at?: string;
  enabled_by?: string;
}

export interface GuardrailsFlags {
  max_emails_per_day?: number;
  max_actions_per_day?: number;
  cool_down_hours?: number;
  deal_value_approval_threshold?: number;
}

export interface OrgFeatureFlags {
  autonomous_mode?: AutonomousModeFlags;
  email_auto_response?: EmailAutoResponseFlags;
  deal_nudge?: DealNudgeFlags;
  autonomous_emails?: { enabled?: boolean };
  guardrails?: GuardrailsFlags;
}

// ── Guardrail check results ────────────────────────────────────────────────

export interface GuardrailCheckResult {
  allowed: boolean;
  reason?: string;
  count?: number;
  limit?: number;
}

// ── Fetcher ──────────────────────────────────────────────────────────────────

/**
 * Fetch and return typed feature flags for an organization.
 * Returns an empty object (all flags undefined) if org not found.
 */
export async function getOrgFeatureFlags(orgId: string | null): Promise<OrgFeatureFlags> {
  if (!orgId) return {};

  const supabase = getSupabaseAdmin();
  const { data: org } = await supabase
    .from("organizations")
    .select("feature_flags")
    .eq("id", orgId)
    .single();

  return (org?.feature_flags as OrgFeatureFlags) || {};
}

/**
 * Check if autonomous mode is enabled for an organization.
 * This is the master gate — when false, all autonomous actions
 * should route to approval flows instead.
 */
export async function isAutonomousModeEnabled(orgId: string | null): Promise<boolean> {
  if (!orgId) return false;
  const flags = await getOrgFeatureFlags(orgId);
  return flags.autonomous_mode?.enabled === true;
}

// ── Guardrail helpers ──────────────────────────────────────────────────────

/**
 * Get guardrails config for an org, with sensible defaults.
 * Returns null values for unconfigured limits (meaning unlimited).
 */
export async function getGuardrails(orgId: string | null): Promise<GuardrailsFlags> {
  if (!orgId) return {};
  const flags = await getOrgFeatureFlags(orgId);
  return flags.guardrails || {};
}

/**
 * Check if a user has exceeded the daily auto-sent email limit.
 * Uses the user's timezone (from profiles) to scope "today".
 */
export async function checkEmailRateLimit(
  orgId: string,
  userId: string,
): Promise<GuardrailCheckResult> {
  const guardrails = await getGuardrails(orgId);
  const limit = guardrails.max_emails_per_day;

  // No limit configured = unlimited
  if (!limit) return { allowed: true };

  const supabase = getSupabaseAdmin();

  // Get user timezone
  const { data: profile } = await supabase
    .from("profiles")
    .select("timezone")
    .eq("user_id", userId)
    .single();
  const tz = profile?.timezone || "America/New_York";

  // Get UTC boundaries for today in user's timezone
  const dayStart = getLocalMidnight(tz, 0);
  const dayEnd = getLocalMidnight(tz, 1);

  const { count, error } = await supabase
    .from("email_auto_response_drafts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("organization_id", orgId)
    .in("status", ["auto_sent", "sent"])
    .gte("sent_at", dayStart.toISOString())
    .lt("sent_at", dayEnd.toISOString());

  const currentCount = count || 0;

  if (currentCount >= limit) {
    return {
      allowed: false,
      reason: `Daily auto-send limit reached (${currentCount}/${limit})`,
      count: currentCount,
      limit,
    };
  }

  return { allowed: true, count: currentCount, limit };
}

/**
 * Check if an email to a specific recipient is within the cool-down period.
 * Prevents spamming the same contact with autonomous emails.
 */
export async function checkCooldownPeriod(
  orgId: string,
  userId: string,
  recipientEmail: string,
): Promise<GuardrailCheckResult> {
  const guardrails = await getGuardrails(orgId);
  const coolDownHours = guardrails.cool_down_hours;

  // No cool-down configured = no restriction
  if (!coolDownHours) return { allowed: true };

  const supabase = getSupabaseAdmin();
  const cutoff = new Date(Date.now() - coolDownHours * 60 * 60 * 1000).toISOString();

  const { data } = await supabase
    .from("email_auto_response_drafts")
    .select("sent_at")
    .eq("user_id", userId)
    .eq("organization_id", orgId)
    .eq("to_email", recipientEmail)
    .in("status", ["auto_sent", "sent"])
    .gte("sent_at", cutoff)
    .order("sent_at", { ascending: false })
    .limit(1);

  if (data && data.length > 0) {
    return {
      allowed: false,
      reason: `Cool-down active: last email to ${recipientEmail} sent ${_timeAgo(data[0].sent_at)}. ${coolDownHours}h cool-down in effect.`,
    };
  }

  return { allowed: true };
}

/**
 * Check if a deal's value exceeds the threshold requiring manual approval.
 */
export async function checkDealValueThreshold(
  orgId: string,
  dealValue: number | null,
): Promise<GuardrailCheckResult> {
  const guardrails = await getGuardrails(orgId);
  const threshold = guardrails.deal_value_approval_threshold;

  // No threshold configured = no restriction
  if (!threshold) return { allowed: true };

  // No deal value = allow (can't evaluate)
  if (dealValue === null || dealValue === undefined) return { allowed: true };

  if (dealValue >= threshold) {
    return {
      allowed: false,
      reason: `Deal value $${dealValue.toLocaleString()} exceeds approval threshold of $${threshold.toLocaleString()}`,
    };
  }

  return { allowed: true };
}

/** Format a timestamp as a relative time string (e.g., "2h ago"). */
function _timeAgo(isoTimestamp: string): string {
  const diffMs = Date.now() - new Date(isoTimestamp).getTime();
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor(diffMs / (1000 * 60)) % 60;
  if (hours > 0) return `${hours}h ${minutes}m ago`;
  return `${minutes}m ago`;
}
