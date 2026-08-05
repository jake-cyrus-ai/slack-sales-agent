/**
 * Prospect dossier — structured qualification snapshot per session.
 *
 * Single row per session, edited in place. Each save bumps `version`. The
 * dossier feeds two seller-facing surfaces:
 *   1. A new Slack post in the configured channel (delivered separately by
 *      `delivery.ts`; this module only persists).
 *   2. The Activity page section on your-app.example.com/activity.
 *
 * It also feeds a single CRM write (Light v1) once finalized — see
 * `crm-sync.ts`.
 */

import { getSupabaseAdmin } from "../supabase";
import { logger } from "../logger";
import type { ConversationStage } from "../../inngest/utils/email-thread-context";

const log = logger.child({ component: "prospect-context-dossier" });

export type FitBand = "low" | "medium" | "high";

/**
 * Per-dossier scratchpad for agent state that doesn't deserve its own column.
 * Schema-on-read; only the agent code understands the keys. Persisted as a
 * JSONB column on `prospect_dossiers`.
 */
export interface DossierMetadata {
  /** Number of price-pushback turns this session. Used by the negotiation ladder. */
  negotiation_pushback_count?: number;
  /** Set when the agent has formally proposed a multi-year deal at least once. */
  multi_year_offered?: boolean;
  /** Set when the prospect rejected the multi-year proposal (so we know we can drop to ladder Step 4+). */
  multi_year_rejected?: boolean;
  /** Set when the prospect clicks accept on a click-through ToS / MSA. */
  terms_accepted_at?: string;
  terms_version?: string;
  /** Allow forward-extensibility without schema churn. */
  [key: string]: unknown;
}

export interface ProspectDossier {
  id: string;
  sessionId: string;
  organizationId: string;
  contactName: string | null;
  contactEmail: string | null;
  contactCompany: string | null;
  contactRole: string | null;
  fitScore: number | null;
  fitBand: FitBand | null;
  strengths: string[];
  gaps: string[];
  currentState: string | null;
  conversationStage: ConversationStage | null;
  dealStage: string | null;
  crmProvider: string | null;
  crmDealId: string | null;
  crmDealUrl: string | null;
  attioWorkspaceId: string | null;
  salesforceOrgId: string | null;
  slackChannelId: string | null;
  slackMessageTs: string | null;
  metadata: DossierMetadata;
  version: number;
  generatedAt: string;
  updatedAt: string;
}

export interface DossierInput {
  fitScore?: number;
  fitBand?: FitBand;
  strengths?: string[];
  gaps?: string[];
  currentState?: string;
  conversationStage?: ConversationStage;
}

interface ProspectDossierRow {
  id: string;
  session_id: string;
  organization_id: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_company: string | null;
  contact_role: string | null;
  fit_score: number | null;
  fit_band: FitBand | null;
  strengths: string[] | null;
  gaps: string[] | null;
  current_state: string | null;
  conversation_stage: string | null;
  deal_stage: string | null;
  crm_provider: string | null;
  crm_deal_id: string | null;
  crm_deal_url: string | null;
  attio_workspace_id: string | null;
  salesforce_org_id: string | null;
  slack_channel_id: string | null;
  slack_message_ts: string | null;
  metadata: DossierMetadata | null;
  version: number;
  generated_at: string;
  updated_at: string;
}

function rowToDossier(row: ProspectDossierRow): ProspectDossier {
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
    conversationStage: (row.conversation_stage as ConversationStage) ?? null,
    dealStage: row.deal_stage,
    crmProvider: row.crm_provider,
    crmDealId: row.crm_deal_id,
    crmDealUrl: row.crm_deal_url,
    attioWorkspaceId: row.attio_workspace_id,
    salesforceOrgId: row.salesforce_org_id,
    slackChannelId: row.slack_channel_id,
    slackMessageTs: row.slack_message_ts,
    metadata: row.metadata ?? {},
    version: row.version,
    generatedAt: row.generated_at,
    updatedAt: row.updated_at,
  };
}

function deriveFitBand(score: number): FitBand {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

export async function getDossierForSession(sessionId: string): Promise<ProspectDossier | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("prospect_dossiers")
    .select("*")
    .eq("session_id", sessionId)
    .maybeSingle();

  if (error) {
    log.error({ err: error, sessionId }, "Failed to load dossier");
    return null;
  }
  return data ? rowToDossier(data) : null;
}

/**
 * Upsert the dossier for a session. Mirrors the latest captured identity
 * fields from `prospect_sessions` so the Slack/Activity views read from a
 * single row.
 */
export async function upsertDossier(args: {
  sessionId: string;
  organizationId: string;
  identity: {
    name: string | null;
    email: string | null;
    company: string | null;
    role: string | null;
  };
  input: DossierInput;
}): Promise<ProspectDossier> {
  const supabase = getSupabaseAdmin();
  const existing = await getDossierForSession(args.sessionId);

  const fitScore = args.input.fitScore ?? existing?.fitScore ?? null;
  const fitBand = args.input.fitBand ?? (fitScore !== null ? deriveFitBand(fitScore) : null);

  const conversationStage = args.input.conversationStage ?? existing?.conversationStage ?? "intro";

  const payload = {
    session_id: args.sessionId,
    organization_id: args.organizationId,
    contact_name: args.identity.name,
    contact_email: args.identity.email,
    contact_company: args.identity.company,
    contact_role: args.identity.role,
    fit_score: fitScore,
    fit_band: fitBand,
    strengths: args.input.strengths ?? existing?.strengths ?? [],
    gaps: args.input.gaps ?? existing?.gaps ?? [],
    current_state: args.input.currentState ?? existing?.currentState ?? null,
    conversation_stage: conversationStage,
  };

  if (existing) {
    const { data, error } = await supabase
      .from("prospect_dossiers")
      .update({ ...payload, version: existing.version + 1 })
      .eq("id", existing.id)
      .select()
      .single();

    if (error || !data) {
      log.error({ err: error, sessionId: args.sessionId }, "Failed to update dossier");
      throw error ?? new Error("Failed to update dossier");
    }
    return rowToDossier(data);
  }

  const { data, error } = await supabase
    .from("prospect_dossiers")
    .insert(payload)
    .select()
    .single();

  if (error || !data) {
    log.error({ err: error, sessionId: args.sessionId }, "Failed to insert dossier");
    throw error ?? new Error("Failed to insert dossier");
  }
  return rowToDossier(data);
}

/**
 * Persist the Slack message coordinates so subsequent updates can edit in
 * place via `chat.update`.
 */
export async function recordDossierSlackPost(
  dossierId: string,
  channelId: string,
  messageTs: string
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("prospect_dossiers")
    .update({ slack_channel_id: channelId, slack_message_ts: messageTs })
    .eq("id", dossierId);
  if (error) log.error({ err: error, dossierId }, "Failed to record dossier slack post");
}

export async function recordDossierCrmDeal(
  dossierId: string,
  provider: "salesforce" | "attio" | "hubspot",
  dealId: string,
  dealUrl?: string,
  identity?: { attioWorkspaceId?: string | null; salesforceOrgId?: string | null },
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const update: Record<string, unknown> = {
    crm_provider: provider,
    crm_deal_id: dealId,
    crm_deal_url: dealUrl ?? null,
  };
  // Stamp the per-provider workspace/org id so we can detect orphaned deals
  // after a workspace switch (sync-time mismatch guard in crm-sync.ts).
  if (provider === "attio") {
    update.attio_workspace_id = identity?.attioWorkspaceId ?? null;
  } else if (provider === "salesforce") {
    update.salesforce_org_id = identity?.salesforceOrgId ?? null;
  }
  const { error } = await supabase
    .from("prospect_dossiers")
    .update(update)
    .eq("id", dossierId);
  if (error) log.error({ err: error, dossierId, provider }, "Failed to record dossier CRM deal");
}

// ---------------------------------------------------------------------------
// Metadata helpers — read-modify-write the dossier's JSONB scratchpad.
//
// JSONB updates in Postgres are non-atomic at the row level, so concurrent
// writes from rapidly-fired tool calls within the same turn could clobber
// each other. The chat agent's iteration loop is sequential per session
// though (one turn at a time, one tool at a time), so the race window is
// narrow. If we ever fan out concurrent writes per session we'll need to
// move to `jsonb_set` server-side, but today read-modify-write is fine.
// ---------------------------------------------------------------------------

async function patchDossierMetadata(
  sessionId: string,
  patch: (existing: DossierMetadata) => DossierMetadata,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data, error: readErr } = await supabase
    .from("prospect_dossiers")
    .select("id, metadata")
    .eq("session_id", sessionId)
    .maybeSingle();
  if (readErr) {
    log.error({ err: readErr, sessionId }, "Failed to read dossier metadata for patch");
    return;
  }
  if (!data) {
    // No dossier yet — nothing to patch. The agent calls these helpers from
    // tool handlers that fire after `finalize_dossier`, so this should be
    // rare; silently skip.
    log.info({ sessionId }, "Skipping metadata patch — no dossier yet for this session");
    return;
  }
  const current = ((data.metadata ?? {}) as DossierMetadata);
  const next = patch(current);
  const { error: writeErr } = await supabase
    .from("prospect_dossiers")
    .update({ metadata: next })
    .eq("id", data.id);
  if (writeErr) {
    log.error({ err: writeErr, sessionId }, "Failed to write dossier metadata patch");
  }
}

/**
 * Increment the in-session price-pushback counter. Called when the chat
 * classifier detects that the prospect's latest message is a price pushback
 * AND the deal is at negotiation stage.
 */
export async function incrementPushbackCount(sessionId: string): Promise<void> {
  await patchDossierMetadata(sessionId, (m) => ({
    ...m,
    negotiation_pushback_count: (m.negotiation_pushback_count ?? 0) + 1,
  }));
}

export async function markMultiYearOffered(sessionId: string): Promise<void> {
  await patchDossierMetadata(sessionId, (m) => ({ ...m, multi_year_offered: true }));
}

export async function markMultiYearRejected(sessionId: string): Promise<void> {
  await patchDossierMetadata(sessionId, (m) => ({ ...m, multi_year_rejected: true }));
}

export async function markTermsAccepted(
  sessionId: string,
  termsVersion: string,
): Promise<void> {
  await patchDossierMetadata(sessionId, (m) => ({
    ...m,
    terms_accepted_at: new Date().toISOString(),
    terms_version: termsVersion,
  }));
}
