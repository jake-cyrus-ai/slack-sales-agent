/**
 * Org readiness evaluator.
 *
 * Two Inngest functions:
 *
 *   - `evaluateOrgReadiness` — runs the rules engine for ONE org.
 *     Fired by:
 *       • `inngest.send("org/readiness.evaluate", { orgId })` from the
 *         playbooks PUT route after a successful save (lazy recompute
 *         so admins see fresh scores immediately).
 *       • the scanner below (nightly fan-out).
 *
 *   - `evaluateAllOrgsReadiness` — nightly cron. Lists every org and
 *     emits a `org/readiness.evaluate` event for each one. Catches
 *     orgs whose lazy-recompute path hasn't fired in a while.
 *
 * Output of every run: one upsert into `org_readiness_snapshots`. The
 * dashboard banner reads that table and never calls the engine directly.
 */

import { logger } from "../../../lib/logger";
import { inngest } from "../../client";
import { getSupabaseAdmin } from "../../utils/supabase";
import { evaluate } from "../../../lib/onboarding/readiness-rules";
import type { OnboardingMode } from "../../../lib/onboarding/topics";
import type {
  PlaybookKnowledge,
  AnswerConfidence,
} from "../../../lib/onboarding/types";

const log = logger.child({ fn: "evaluate-readiness" });

// Today every paid org is enterprise — PLG mode is a hostname-only
// concept on the client. The readiness engine grades all orgs against
// the strictest rule set. When PLG becomes a real customer tier, plumb
// mode through `organizations.settings.app_mode` or a dedicated column.
function resolveMode(): OnboardingMode {
  return "enterprise";
}

function parseKnowledge(raw: unknown): PlaybookKnowledge {
  if (typeof raw !== "object" || raw === null) return {};
  const out: PlaybookKnowledge = {};
  for (const [topic, entries] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    out[topic] = entries
      .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
      .map((e) => ({
        question_key: String(e.question_key ?? ""),
        question_text: String(e.question_text ?? ""),
        answer_text: String(e.answer_text ?? ""),
        confidence:
          e.confidence === "confirmed" || e.confidence === "stale" || e.confidence === "draft"
            ? (e.confidence as AnswerConfidence)
            : "draft",
        updated_at: String(e.updated_at ?? ""),
      }))
      .filter((e) => e.question_key.length > 0);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-org evaluation — fires on event
// ---------------------------------------------------------------------------
export const evaluateOrgReadiness = inngest.createFunction(
  {
    id: "evaluate-org-readiness",
    // No concurrency override — readiness is a per-org sporadic
    // evaluation (one event per save or nightly), well under any
    // plan-level cap. Adding a per-fn limit here only risks tripping
    // the Inngest plan limit and blocking the entire registration sync.
    retries: 2,
  },
  { event: "org/readiness.evaluate" },
  async ({ event, step }) => {
    const { orgId } = event.data as { orgId?: string };
    if (!orgId) {
      log.warn({ event: event.name }, "Missing orgId in event payload");
      return { skipped: "missing_org_id" };
    }

    const result = await step.run("load-org-context", async () => {
      const supabase = getSupabaseAdmin();

      const orgRes = await supabase
        .from("organizations")
        .select("id, settings")
        .eq("id", orgId)
        .maybeSingle();

      if (orgRes.error || !orgRes.data) {
        log.warn(
          { err: orgRes.error, orgId },
          "Organization not found for readiness evaluation",
        );
        return null;
      }

      const settings = (orgRes.data.settings ?? {}) as Record<string, unknown>;
      const knowledge = parseKnowledge(settings.prospect_chat_knowledge);

      return { orgId: orgRes.data.id ?? orgId, knowledge };
    });

    if (!result) return { skipped: "org_not_found", orgId };

    const mode = resolveMode();
    const knowledge = result.knowledge as PlaybookKnowledge;
    const snapshot = evaluate({ mode, knowledge });

    await step.run("write-snapshot", async () => {
      const supabase = getSupabaseAdmin();
      const { error } = await supabase
        .from("org_readiness_snapshots")
        .upsert(
          {
            organization_id: orgId,
            score: snapshot.score,
            rules_evaluated: snapshot.rulesEvaluated,
            rules_passed: snapshot.rulesPassed,
            blocking_gaps: snapshot.blockingGaps,
            advisory_gaps: snapshot.advisoryGaps,
            evaluated_at: new Date().toISOString(),
          },
          { onConflict: "organization_id" },
        );
      if (error) {
        log.error(
          { err: error, orgId, score: snapshot.score },
          "Failed to upsert readiness snapshot",
        );
        throw error;
      }
    });

    log.info(
      {
        orgId,
        mode,
        score: snapshot.score,
        rulesEvaluated: snapshot.rulesEvaluated,
        blocking: snapshot.blockingGaps.length,
        advisory: snapshot.advisoryGaps.length,
        knowledgeTopics: Object.keys(knowledge).length,
      },
      "Wrote readiness snapshot",
    );

    return {
      orgId,
      score: snapshot.score,
      rulesEvaluated: snapshot.rulesEvaluated,
      blocking: snapshot.blockingGaps.length,
      advisory: snapshot.advisoryGaps.length,
    };
  },
);

// ---------------------------------------------------------------------------
// Nightly fan-out — emits one event per org
// ---------------------------------------------------------------------------
//
// 06:00 UTC = roughly 22:00–02:00 across US working hours, so admins
// see a fresh score when they open the dashboard the next morning.
export const evaluateAllOrgsReadiness = inngest.createFunction(
  {
    id: "evaluate-all-orgs-readiness",
    retries: 1,
  },
  { cron: "0 6 * * *" },
  async ({ step }) => {
    const orgs = await step.run("list-orgs", async () => {
      const supabase = getSupabaseAdmin();
      const { data, error } = await supabase.from("organizations").select("id");
      if (error) {
        log.error({ err: error }, "Failed to list organizations");
        return [];
      }
      return (data ?? []) as Array<{ id: string }>;
    });

    if (orgs.length === 0) return { fanned: 0 };

    await step.run("fan-out", async () => {
      // One send call with all events. Inngest batches on the wire.
      await inngest.send(
        orgs.map((o) => ({
          name: "org/readiness.evaluate" as const,
          data: { orgId: o.id },
        })),
      );
    });

    log.info({ count: orgs.length }, "Fanned out readiness re-evaluations");
    return { fanned: orgs.length };
  },
);
