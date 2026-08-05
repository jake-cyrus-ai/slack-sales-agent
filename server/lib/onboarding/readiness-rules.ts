/**
 * Readiness rules — declarative checks an org has to pass to be
 * "ready" for production use of Sales Agent.
 *
 * v2 (Q&A trainer): each topic passes iff every REQUIRED question for that
 * topic has been answered with confidence='confirmed' in
 * organizations.settings.prospect_context_knowledge. This replaces the v1
 * check ("playbook with this name has non-empty content"), which couldn't
 * tell shallow answers from complete ones.
 *
 * Legacy free-text `prospect_context_playbooks` is no longer counted toward
 * readiness — orgs that pre-date the Q&A flow show a 0% topic score until
 * they re-do kickoff, which is the desired prompt to migrate.
 *
 * Future rules drop into `READINESS_RULES`:
 *   - Required documents (SOC2 report doc_type, MSA template doc_type)
 *   - Connected integrations (Salesforce, Slack default channel, …)
 *
 * Score formula:
 *   - blocking pass rate weighted 80%
 *   - advisory pass rate weighted 20%
 *   - all-passing → 100; nothing applicable → 100 (no rules to fail)
 */

import {
  ONBOARDING_TOPICS,
  type OnboardingMode,
  type OnboardingTopicId,
} from "./topics";
import { topicFullyTaught } from "./question-bank";
import type { PlaybookKnowledge } from "./types";

export type Severity = "blocking" | "advisory";

// ---------------------------------------------------------------------------
// Rule shape
// ---------------------------------------------------------------------------

export interface ReadinessFix {
  /** When set, the gap UI deep-links the admin to teach this onboarding topic. */
  topic?: OnboardingTopicId;
  /** Otherwise, a hash route (e.g. "/activity#operating-playbooks") or external URL. */
  href?: string;
}

export interface ReadinessRule {
  id: string;
  /** Short label shown in the gap card header. */
  label: string;
  /** One-sentence "why this matters", surfaced in the gap UI. */
  whyItMatters: string;
  severity: Severity;
  /** Modes this rule fires for. Rules absent for a mode are ignored, not failed. */
  appliesTo: OnboardingMode[];
  /** True = rule satisfied. False = gap. */
  passes: (ctx: ReadinessContext) => boolean;
  fix: ReadinessFix;
}

export interface ReadinessContext {
  mode: OnboardingMode;
  /**
   * Q&A knowledge read from organizations.settings.prospect_context_knowledge.
   * A topic passes its readiness rule iff every REQUIRED question for that
   * topic has confidence='confirmed'.
   */
  knowledge: PlaybookKnowledge;
}

// ---------------------------------------------------------------------------
// Rule registry
// ---------------------------------------------------------------------------

const TOPIC_RULES: ReadinessRule[] = ONBOARDING_TOPICS.map((topic) => ({
  id: `topic.${topic.id}.taught`,
  label: `Teach Sales Agent about ${topic.label}`,
  whyItMatters: topic.whyItMatters,
  severity: "blocking" as Severity,
  appliesTo: topic.requiredFor,
  passes: (ctx) => topicFullyTaught(ctx.knowledge, topic.label),
  fix: { topic: topic.id },
}));

export const READINESS_RULES: ReadinessRule[] = [
  ...TOPIC_RULES,
  // Future rules append here.
];

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface ReadinessGap {
  ruleId: string;
  label: string;
  whyItMatters: string;
  severity: Severity;
  fix: ReadinessFix;
}

export interface ReadinessSnapshot {
  score: number; // 0–100
  rulesEvaluated: number;
  rulesPassed: number;
  blockingGaps: ReadinessGap[];
  advisoryGaps: ReadinessGap[];
}

export function evaluate(ctx: ReadinessContext): ReadinessSnapshot {
  const applicable = READINESS_RULES.filter((r) => r.appliesTo.includes(ctx.mode));

  const blocking = applicable.filter((r) => r.severity === "blocking");
  const advisory = applicable.filter((r) => r.severity === "advisory");

  const blockingPassed = blocking.filter((r) => r.passes(ctx)).length;
  const advisoryPassed = advisory.filter((r) => r.passes(ctx)).length;

  const blockingGaps: ReadinessGap[] = blocking
    .filter((r) => !r.passes(ctx))
    .map(toGap);
  const advisoryGaps: ReadinessGap[] = advisory
    .filter((r) => !r.passes(ctx))
    .map(toGap);

  let score: number;
  if (applicable.length === 0) {
    score = 100;
  } else if (blocking.length === 0) {
    score = Math.round((advisoryPassed / advisory.length) * 100);
  } else {
    const blockingPct = blockingPassed / blocking.length;
    const advisoryPct =
      advisory.length > 0 ? advisoryPassed / advisory.length : 1;
    score = Math.round(blockingPct * 80 + advisoryPct * 20);
  }

  return {
    score,
    rulesEvaluated: applicable.length,
    rulesPassed: blockingPassed + advisoryPassed,
    blockingGaps,
    advisoryGaps,
  };
}

function toGap(rule: ReadinessRule): ReadinessGap {
  return {
    ruleId: rule.id,
    label: rule.label,
    whyItMatters: rule.whyItMatters,
    severity: rule.severity,
    fix: rule.fix,
  };
}
