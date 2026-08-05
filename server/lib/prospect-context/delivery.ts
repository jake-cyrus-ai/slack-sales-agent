/**
 * Dossier delivery orchestrator — Slack post + CRM write.
 *
 * Called fire-and-forget from the agent's `finalize_dossier` tool. Order:
 *   1. CRM sync first (so the resulting deal/lead URL can land in the Slack
 *      post on the same delivery cycle).
 *   2. Slack post (or chat.update + threaded reply on subsequent versions).
 *
 * Both side effects are independent — Slack delivers even if CRM is not
 * connected, and vice versa.
 */

import { logger } from "../logger";
import { getSupabaseAdmin } from "../supabase";
import { getDossierForSession, type ProspectDossier } from "./dossier";
import { syncDossierToCrm } from "./crm-sync";
import { sendDossierToSlack } from "./slack-post";

const log = logger.child({ component: "prospect-context-delivery" });

export async function onDossierFinalized(dossier: ProspectDossier): Promise<void> {
  log.info(
    {
      dossierId: dossier.id,
      sessionId: dossier.sessionId,
      organizationId: dossier.organizationId,
      version: dossier.version,
      fitScore: dossier.fitScore,
      fitBand: dossier.fitBand,
    },
    "Delivering dossier to seller surfaces",
  );

  try {
    await syncDossierToCrm(dossier);
  } catch (err) {
    log.error({ err, dossierId: dossier.id }, "CRM sync threw (non-blocking)");
  }

  // Re-read so the Slack post sees the freshly-stored crm_deal_url.
  const refreshed = (await getDossierForSession(dossier.sessionId)) ?? dossier;

  // Look up the assigned rep user ID for dm_to_rep notification destination
  let assignedRepUserId: string | null = null;
  try {
    const supabase = getSupabaseAdmin(); // system context — reading session metadata
    const { data: session } = await supabase
      .from("prospect_sessions")
      .select("assigned_rep_user_id")
      .eq("id", dossier.sessionId)
      .maybeSingle();
    assignedRepUserId = session?.assigned_rep_user_id ?? null;
  } catch (err) {
    log.warn({ err, sessionId: dossier.sessionId }, "Failed to look up assigned rep user ID (non-blocking)");
  }

  try {
    const isHandoff = refreshed.conversationStage === "meeting_scheduled";
    await sendDossierToSlack(refreshed, assignedRepUserId, isHandoff);
  } catch (err) {
    log.error({ err, dossierId: dossier.id }, "Slack delivery threw (non-blocking)");
  }
}
