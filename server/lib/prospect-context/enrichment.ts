/**
 * Shared prospect enrichment — cache-first Exa research.
 *
 * Both the chat agent and the email agent call `enrichProspect()` to get
 * company/person data. Results are cached in `prospect_dossiers.enrichment`
 * (JSONB) keyed by dossier ID, with a 24-hour TTL.
 */

import { getSupabaseAdmin } from "../supabase";
import {
  researchProspect,
  type ProspectResearchResult,
} from "../../inngest/utils/prospect-research";
import { logger } from "../logger";

const log = logger.child({ component: "prospect-enrichment" });

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RESEARCH_TIMEOUT_MS = 15_000;

/**
 * Enrich a prospect with company + person research.
 *
 * 1. If `dossierId` is provided, check `prospect_dossiers.enrichment` for cached data.
 * 2. If cached enrichment exists and is < 24h old, return it.
 * 3. Otherwise, call `researchProspect()` via Exa.
 * 4. If `dossierId` is provided, persist the result to `prospect_dossiers.enrichment`.
 * 5. Return the result.
 */
export async function enrichProspect(args: {
  organizationId: string;
  email: string;
  name?: string | null;
  company?: string | null;
  dossierId?: string | null;
}): Promise<ProspectResearchResult | null> {
  const { organizationId, email, name, company, dossierId } = args;

  // Step 1+2: Check cache if we have a dossier ID
  if (dossierId) {
    try {
      const supabase = getSupabaseAdmin(); // System-level read on prospect_dossiers — no user context
      const { data, error } = await supabase
        .from("prospect_dossiers")
        .select("enrichment")
        .eq("id", dossierId)
        .maybeSingle();

      if (error) {
        log.warn({ err: error, dossierId }, "Failed to read dossier cache");
      } else if (data?.enrichment) {
        const cachedAt = (data.enrichment as any)?._cachedAt;
        const age = cachedAt ? Date.now() - new Date(cachedAt).getTime() : Infinity;
        if (age < CACHE_TTL_MS) {
          log.info({ dossierId, ageMs: age }, "Returning cached enrichment");
          return data.enrichment as ProspectResearchResult;
        }
        log.info({ dossierId, ageMs: age }, "Cached enrichment expired, refreshing");
      }
    } catch (err) {
      log.warn({ err, dossierId }, "Cache lookup failed, falling back to live research");
    }
  }

  // Step 3: Call Exa research
  const domain = email.split("@")[1];
  if (!domain) {
    log.warn({ email, organizationId }, "Cannot extract domain from email");
    return null;
  }

  let result: ProspectResearchResult;
  try {
    result = await Promise.race([
      researchProspect({
        senderEmail: email,
        senderName: name ?? null,
        senderDomain: domain,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("researchProspect timed out after 15s")), RESEARCH_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    log.error({ err, email, organizationId }, "Prospect research failed");
    return null;
  }

  // Step 4: Persist to dossier if we have an ID
  if (dossierId) {
    try {
      const supabase = getSupabaseAdmin(); // System-level write to persist enrichment cache
      const { error } = await supabase
        .from("prospect_dossiers")
        .update({ enrichment: { ...result, _cachedAt: new Date().toISOString() } as any })
        .eq("id", dossierId);

      if (error) {
        log.warn({ err: error, dossierId }, "Failed to persist enrichment to dossier");
      } else {
        log.info({ dossierId }, "Persisted enrichment to dossier");
      }
    } catch (err) {
      log.warn({ err, dossierId }, "Enrichment persistence failed (non-blocking)");
    }
  }

  return result;
}
