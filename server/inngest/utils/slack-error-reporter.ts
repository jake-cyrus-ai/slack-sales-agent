/**
 * Slack Error Reporter — append-only forensic logging for Slack handler errors.
 *
 * Every catch block in handleSlackMessage calls writeErrorEvent() with the
 * error and local context. The helper classifies the error, strips anything
 * secret-shaped, fetches a Slack thread permalink, and inserts a row into
 * slack_error_events. It NEVER throws — telemetry must never block recovery.
 *
 * When an Inngest retry eventually succeeds, call markErrorsResolved(runId)
 * to set resolved_at on earlier rows for that run so dashboards can
 * distinguish intermittent (self-healed) from terminal failures.
 */

import { getSupabaseAdmin } from "./supabase";
import { getSlackPermalink } from "./slack-helpers";
import { logger } from "../../lib/logger";

const log = logger.child({ util: "slack-error-reporter" });

// ─── Error classification ────────────────────────────────────────────────────

export type ErrorCategory =
  | "agent"
  | "db"
  | "slack_api"
  | `integration:${string}`
  | "auth"
  | "unknown";

/**
 * Classify a caught error into a coarse category. The category powers both
 * telemetry filtering and the user-facing error message in the backup flow.
 */
export function classifyError(err: unknown): ErrorCategory {
  if (!err || typeof err !== "object") return "unknown";

  const e = err as { name?: string; message?: string; code?: string; status?: number };
  const message = (e.message || "").toLowerCase();
  const name = (e.name || "").toLowerCase();

  // Auth failures (Slack or Supabase)
  if (message.includes("invalid_auth") || message.includes("token_revoked") || message.includes("not_authed")) {
    return "auth";
  }
  if (message.includes("jwt") || message.includes("unauthorized") || e.status === 401 || e.status === 403) {
    return "auth";
  }

  // Slack API errors — our wrappers throw with "slack api error" in the message
  if (message.includes("slack api error") || message.includes("chat.update") || message.includes("chat.postmessage")) {
    return "slack_api";
  }

  // Database errors (Supabase / PostgREST)
  if (name.includes("postgres") || message.includes("supabase") || message.includes("database") || message.includes("relation ") || e.code === "ECONNREFUSED") {
    return "db";
  }

  // Integration-specific errors — match common service names in the message
  const integrations = ["salesforce", "hubspot", "attio", "gmail", "google calendar", "granola", "anthropic"];
  for (const svc of integrations) {
    if (message.includes(svc)) return `integration:${svc.replace(/\s+/g, "_")}`;
  }

  // Agent / LangGraph / recursion errors
  if (message.includes("recursion") || message.includes("langgraph") || message.includes("skill ") || message.includes("timed out")) {
    return "agent";
  }

  return "unknown";
}

// ─── Secret sanitization ─────────────────────────────────────────────────────

const SECRET_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /api[-_]?key/i,
  /authorization/i,
  /encryption[-_]?key/i,
  /access[-_]?key/i,
  /private[-_]?key/i,
  /bearer/i,
  /xoxb-/,
  /xoxp-/,
  /xoxe-/,
];

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(key));
}

/**
 * Deep-clone a value while redacting any field whose key looks secret-shaped.
 * Strings that are themselves obvious tokens are also redacted regardless of
 * their key. Used on Slack event payloads before persisting them.
 */
export function sanitizeForLogging(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[max depth]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    // Redact plausible tokens embedded as raw strings
    if (/^xox[bpea]-/.test(value) || /^Bearer\s+/i.test(value)) return "[REDACTED]";
    return value;
  }

  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((v) => sanitizeForLogging(v, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(k)) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = sanitizeForLogging(v, depth + 1);
    }
  }
  return out;
}

// ─── writeErrorEvent ─────────────────────────────────────────────────────────

export interface ErrorEventParams {
  // Who
  organizationId?: string | null;
  agentUserId?: string | null;
  slackUserId?: string | null;

  // Where (Slack)
  slackTeamId?: string | null;
  slackChannelId?: string | null;
  slackThreadTs?: string | null;
  thinkingTs?: string | null;

  // Where (Sales Agent)
  conversationId?: string | null;

  // Where (Inngest)
  inngestRunId?: string | null;
  inngestFunctionId?: string | null;
  attempt?: number | null;
  /** Step name: resolve-context | prepare-chat-context | run-agent | post-and-save | fast-path:{name} | top-level */
  step: string;

  // What
  error: unknown;

  // Request context
  userMessage?: string | null;
  classifiedIntent?: string | null;
  domainSignals?: Record<string, unknown> | null;
  /** Last onProgress status, tool/skill in flight, partial response. */
  agentState?: Record<string, unknown> | null;
  /** Original Slack event payload. Will be sanitized before writing. */
  rawEventPayload?: Record<string, unknown> | null;

  // Backup flow
  backupOutcome?: "not_attempted" | "succeeded" | "failed" | null;
  backupResponsePreview?: string | null;

  // Used to fetch a permalink if possible. Never persisted.
  botToken?: string;
}

const STACK_LIMIT = 2048;

function extractErrorFields(err: unknown): { name: string; message: string; stack: string | null } {
  if (err && typeof err === "object") {
    const e = err as { name?: string; message?: string; stack?: string };
    return {
      name: e.name || "Error",
      message: (e.message || String(err)).slice(0, 4096),
      stack: e.stack ? e.stack.slice(0, STACK_LIMIT) : null,
    };
  }
  return { name: "Error", message: String(err).slice(0, 4096), stack: null };
}

/**
 * Write a row to slack_error_events. Fire-and-forget: logs on failure, never throws.
 * Returns the inserted row id, or null if the write failed.
 */
export async function writeErrorEvent(params: ErrorEventParams): Promise<string | null> {
  try {
    const { name, message, stack } = extractErrorFields(params.error);
    const category = classifyError(params.error);

    // Best-effort Slack permalink — one API call, swallowed on failure.
    let permalink: string | null = null;
    if (params.botToken && params.slackChannelId && params.slackThreadTs) {
      permalink = await getSlackPermalink(params.botToken, params.slackChannelId, params.slackThreadTs);
    }

    const row = {
      organization_id: params.organizationId ?? null,
      agent_user_id: params.agentUserId ?? null,
      slack_user_id: params.slackUserId ?? null,
      slack_team_id: params.slackTeamId ?? null,
      slack_channel_id: params.slackChannelId ?? null,
      slack_thread_ts: params.slackThreadTs ?? null,
      thinking_ts: params.thinkingTs ?? null,
      thread_permalink: permalink,
      conversation_id: params.conversationId ?? null,
      inngest_run_id: params.inngestRunId ?? null,
      inngest_function_id: params.inngestFunctionId ?? null,
      attempt: params.attempt ?? null,
      step: params.step,
      error_name: name,
      error_message: message,
      error_stack: stack,
      error_category: category,
      user_message: params.userMessage ?? null,
      classified_intent: params.classifiedIntent ?? null,
      domain_signals: params.domainSignals ?? null,
      agent_state: params.agentState ?? null,
      sanitized_event_payload: params.rawEventPayload
        ? (sanitizeForLogging(params.rawEventPayload) as Record<string, unknown>)
        : null,
      backup_outcome: params.backupOutcome ?? null,
      backup_response_preview: params.backupResponsePreview ?? null,
    };

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("slack_error_events")
      .insert(row)
      .select("id")
      .maybeSingle();

    if (error) {
      log.error({ err: error }, "insert failed");
      return null;
    }

    log.info({ id: data?.id, category, step: params.step, errorName: name }, "Wrote error event");
    return data?.id ?? null;
  } catch (err) {
    log.error({ err }, "unexpected error");
    return null;
  }
}

/**
 * Mark all unresolved error rows for a given Inngest run as resolved.
 * Called from the top of the handler on a successful attempt, so a later
 * retry that self-heals is visible in telemetry as an intermittent failure.
 */
export async function markErrorsResolved(inngestRunId: string | null | undefined): Promise<void> {
  if (!inngestRunId) return;
  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("slack_error_events")
      .update({ resolved_at: new Date().toISOString() })
      .eq("inngest_run_id", inngestRunId)
      .is("resolved_at", null);
    if (error) {
      log.error({ err: error }, "markErrorsResolved failed");
    }
  } catch (err) {
    log.error({ err }, "markErrorsResolved unexpected error");
  }
}

// ─── Request IDs ─────────────────────────────────────────────────────────────

/**
 * Build a short, user-safe request ID from an Inngest run ID.
 * Used in Tier B apology messages so users can reference an incident.
 */
export function toRequestId(inngestRunId: string | null | undefined): string {
  if (!inngestRunId) return "unknown";
  // Inngest run IDs are long ULIDs; take the last 8 chars for a terse reference
  return inngestRunId.slice(-8);
}
