/**
 * Session resolution for the email agent pipeline.
 *
 * When an inbound email arrives, we check whether the sender previously
 * chatted with Sales Agent via the prospect widget (a "warm handoff"). If a
 * session exists we pull the cached enrichment + dossier so the email
 * agent can skip redundant research and reference the prior conversation.
 *
 * All queries use getSupabaseAdmin() — the email agent runs in a system
 * context with no user JWT.
 */

import { getSupabaseAdmin } from "../supabase";
import { logger } from "../logger";
import type { ProspectSession } from "./types";
import type { ProspectDossier } from "./dossier";

const log = logger.child({ component: "prospect-session-lookup" });

/** Hard query timeout so session resolution never blocks the email pipeline. */
const QUERY_TIMEOUT_MS = 2_000;

/**
 * Find the most recent prospect session for a given email address within
 * an organization. Prefers active/idle sessions over closed ones.
 *
 * Uses the partial index on `(organization_id, captured_email)`.
 */
export async function findSessionByEmail(
  organizationId: string,
  email: string,
): Promise<ProspectSession | null> {
  const supabase = getSupabaseAdmin();

  try {
    const result = await Promise.race([
      supabase
        .from("prospect_sessions")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("captured_email", email.toLowerCase())
        .order("status", { ascending: true }) // active < closed < idle — active first
        .order("last_active_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Session lookup timed out")), QUERY_TIMEOUT_MS),
      ),
    ]);

    if (result.error) {
      log.error({ err: result.error, organizationId, email }, "Session lookup query failed");
      return null;
    }

    if (!result.data) return null;

    const row = result.data;
    return {
      id: row.id,
      organizationId: row.organization_id,
      capturedName: row.captured_name,
      capturedEmail: row.captured_email,
      capturedCompany: row.captured_company,
      capturedRole: row.captured_role,
      capturedUseCase: row.captured_use_case,
      intent: row.intent ?? null,
      enrichment: row.enrichment ?? null,
      status: row.status,
      startedAt: row.started_at,
      lastActiveAt: row.last_active_at,
    };
  } catch (err) {
    log.warn({ err, organizationId, email }, "Session lookup failed (timeout or unexpected error)");
    return null;
  }
}

/**
 * Load the prospect dossier for a given session. Returns null if no
 * dossier exists yet.
 */
export async function findDossierBySession(
  sessionId: string,
  organizationId: string,
): Promise<ProspectDossier | null> {
  const supabase = getSupabaseAdmin();

  try {
    const result = await Promise.race([
      supabase
        .from("prospect_dossiers")
        .select("*")
        .eq("session_id", sessionId)
        .eq("organization_id", organizationId)
        .maybeSingle(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Dossier lookup timed out")), QUERY_TIMEOUT_MS),
      ),
    ]);

    if (result.error) {
      log.error({ err: result.error, sessionId }, "Dossier lookup query failed");
      return null;
    }

    if (!result.data) return null;

    const row = result.data;
    return {
      id: row.id,
      sessionId: row.session_id,
      organizationId: row.organization_id,
      contactName: row.contact_name,
      contactEmail: row.contact_email,
      contactCompany: row.contact_company,
      contactRole: row.contact_role,
      fitScore: row.fit_score,
      fitBand: row.fit_band,
      strengths: row.strengths ?? [],
      gaps: row.gaps ?? [],
      currentState: row.current_state,
      crmProvider: row.crm_provider,
      crmDealId: row.crm_deal_id,
      crmDealUrl: row.crm_deal_url,
      slackChannelId: row.slack_channel_id,
      slackMessageTs: row.slack_message_ts,
      conversationStage: row.conversation_stage ?? null,
      dealStage: row.deal_stage ?? null,
      attioWorkspaceId: row.attio_workspace_id ?? null,
      salesforceOrgId: row.salesforce_org_id ?? null,
      metadata: row.metadata ?? {},
      version: row.version,
      generatedAt: row.generated_at,
      updatedAt: row.updated_at,
    };
  } catch (err) {
    log.warn({ err, sessionId }, "Dossier lookup failed (timeout or unexpected error)");
    return null;
  }
}

/**
 * Load a condensed summary of the last N chat messages from a prospect
 * session. Used to inject chat context into the email agent's response
 * generation prompt.
 *
 * Note: `prospect_messages` does not have an `organization_id` column.
 * Org ownership is guaranteed by the caller — `sessionId` is always
 * resolved via `findSessionByEmail`, which filters by `organization_id`.
 */
export async function loadChatSummary(
  sessionId: string,
  limit = 10,
): Promise<string | null> {
  const supabase = getSupabaseAdmin();

  try {
    const { data, error } = await Promise.race([
      supabase
        .from("prospect_messages")
        .select("role, content, created_at")
        .eq("session_id", sessionId)
        .in("role", ["user", "assistant"])
        .order("created_at", { ascending: false })
        .limit(limit),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Chat summary lookup timed out")), QUERY_TIMEOUT_MS),
      ),
    ]);

    if (error || !data?.length) return null;

    // Build summary from newest to oldest, respecting a total character budget.
    // Data is already ordered by created_at desc from the query.
    const TOTAL_BUDGET = 1_500;
    let remaining = TOTAL_BUDGET;
    const lines: string[] = [];

    for (const m of data) {
      const role = m.role === "user" ? "Prospect" : "Sales Agent";
      const line = `${role}: ${m.content || ""}`;
      if (line.length > remaining) break;
      lines.push(line);
      remaining -= line.length + 1; // +1 for the newline separator
      if (remaining <= 0) break;
    }

    // Reverse to chronological order for the final output
    lines.reverse();

    return lines.join("\n");
  } catch (err) {
    log.warn({ err, sessionId }, "Chat summary lookup failed");
    return null;
  }
}
