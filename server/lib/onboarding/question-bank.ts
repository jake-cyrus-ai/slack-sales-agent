/**
 * Onboarding Q&A question bank.
 *
 * Code-defined (not DB-stored): product-driven, version-controlled, and small
 * enough that an explicit module is clearer than a query. The bank is the
 * source of truth for what Sales Agent needs to know about a customer's sales
 * motion. Adding a question is a one-line edit + a deploy.
 *
 * Two priority tiers above `advisory`:
 *   - `critical` (subset of `required`) — gates `mark_onboarding_complete`.
 *     Sales Agent literally cannot operate autonomously without these.
 *   - `required` — gates the 100% readiness score. Important but not
 *     immediately blocking for a first kickoff.
 *
 * Topic labels are the CANONICAL strings from `topics.ts` and must match
 * exactly — the readiness engine matches answers to topics by label.
 */

import { ONBOARDING_TOPICS } from "./topics";
import type { PlaybookKnowledge } from "./types";

export type TopicLabel = (typeof ONBOARDING_TOPICS)[number]["label"];

export interface OnboardingQuestion {
  key: string;
  topic: TopicLabel;
  text: string;
  /** Gates the 100% readiness score. */
  required: boolean;
  /** Subset of required: gates mark_onboarding_complete. */
  critical: boolean;
  /** Optional hints the agent uses to probe a vague first answer. */
  follow_up_hints?: string[];
  /**
   * Short, common answers the frontend renders as clickable chips below the
   * agent's question. Click pre-fills the input so the admin can edit before
   * sending. Omit for questions where answers are entirely org-specific
   * (URLs, names, headcount numbers).
   */
  suggested_answers?: string[];
}

// Convenience constants — typo-safe references to the canonical labels.
const T_ICP: TopicLabel = "ICP & positioning";
const T_COMP: TopicLabel = "Competitors";
const T_NEG: TopicLabel = "Negotiation guidance";
const T_LEGAL: TopicLabel = "Legal & approval routes";
const T_SEC: TopicLabel = "Security posture";
const T_REPS: TopicLabel = "Reps & escalation";

export const QUESTION_BANK: OnboardingQuestion[] = [
  // ICP & positioning -------------------------------------------------------
  {
    key: "icp.firmographics",
    topic: T_ICP,
    text: "Who's your ideal customer? Industry, headcount or ARR band, and geography.",
    required: true,
    critical: true,
    follow_up_hints: ["headcount range", "ARR range", "primary geographies", "industry vertical"],
    suggested_answers: [
      "Mid-market SaaS, 100–500 employees, North America",
      "Enterprise (1000+ employees), global, all industries",
      "SMB / startups (<100 employees), US-only",
      "PLG product, individual users + small teams worldwide",
    ],
  },
  {
    key: "icp.disqualifiers",
    topic: T_ICP,
    text: "Who do you NOT sell to? What signals kick a deal out early?",
    required: true,
    critical: false,
    follow_up_hints: ["company size floor or ceiling", "industries you avoid", "buyer titles that signal bad-fit"],
    suggested_answers: [
      "Companies under 50 employees",
      "Public sector / government / education",
      "Outside North America and EU",
      "No clear budget or decision-maker on the call",
    ],
  },
  {
    key: "icp.use_cases",
    topic: T_ICP,
    text: "Top 2–3 use cases that actually drive a buy.",
    required: true,
    critical: false,
    follow_up_hints: ["pain point per use case", "trigger event that surfaces the pain"],
  },
  {
    key: "icp.value_prop",
    topic: T_ICP,
    text: "What's your one-line pitch for a cold prospect?",
    required: true,
    critical: false,
    follow_up_hints: ["concrete outcome", "differentiator vs status quo"],
  },
  {
    key: "icp.proof_points",
    topic: T_ICP,
    text: "Best 2–3 logos, results, or case studies I can cite live.",
    required: false,
    critical: false,
    follow_up_hints: ["customer name + outcome metric", "case-study URL if public"],
  },
  {
    key: "icp.discovery_questions",
    topic: T_ICP,
    text: "Top 3–5 questions you ask to qualify a prospect.",
    required: false,
    critical: false,
  },

  // Competitors -------------------------------------------------------------
  {
    key: "competitors.top_3",
    topic: T_COMP,
    text: "Top 3 competitors you see in deals.",
    required: true,
    critical: false,
    follow_up_hints: ["competitor names", "when they show up (which segments)"],
  },
  {
    key: "competitors.objection_handling",
    topic: T_COMP,
    text: "For each top competitor, your one-line response when a prospect says 'we already use them.'",
    required: true,
    critical: false,
    follow_up_hints: ["per-competitor rebuttal", "concrete differentiator, not vague claims"],
  },
  {
    key: "competitors.win_themes",
    topic: T_COMP,
    text: "Why do prospects pick you when you win?",
    required: false,
    critical: false,
  },
  {
    key: "competitors.disqualify_signals",
    topic: T_COMP,
    text: "Signals that mean 'walk away — this is a competitor stronghold.'",
    required: false,
    critical: false,
  },
  {
    key: "competitors.unique_wedge",
    topic: T_COMP,
    text: "One capability or angle competitors can't match.",
    required: false,
    critical: false,
  },

  // Negotiation guidance ----------------------------------------------------
  {
    key: "pricing.discount_authority",
    topic: T_NEG,
    text: "Max discount I can offer without escalating (% or $, or 'never discount').",
    required: true,
    critical: true,
    follow_up_hints: ["specific percent or dollar cap", "any conditions (annual prepay, multi-year)"],
    suggested_answers: [
      "Up to 10% with no conditions",
      "Up to 15% with annual prepay",
      "Up to 20% with multi-year commit",
      "Never — list price only, escalate any ask",
    ],
  },
  {
    key: "pricing.escalation_triggers",
    topic: T_NEG,
    text: "Conditions that must escalate to a human (discount > X, term > Y, custom contract asks…).",
    required: true,
    critical: true,
    follow_up_hints: ["price thresholds", "term thresholds", "custom-redline triggers"],
    suggested_answers: [
      "Any discount > 15%, any custom contract term, any redline",
      "Deals > $50k ACV, anything multi-year, security questionnaires",
      "Any ask outside our published pricing or standard MSA",
      "Procurement involvement or competitive bake-off",
    ],
  },
  {
    key: "pricing.published_price",
    topic: T_NEG,
    text: "Public pricing or quote-driven? What anchor numbers should I lead with?",
    required: false,
    critical: false,
    suggested_answers: [
      "Public pricing on website — lead with list",
      "Quote-driven for all deals — never share numbers without a discovery call",
      "Public starter tiers; enterprise is custom",
    ],
  },
  {
    key: "pricing.contract_term_default",
    topic: T_NEG,
    text: "Standard contract term length; multi-year posture.",
    required: false,
    critical: false,
    suggested_answers: [
      "12 months annual, auto-renew",
      "Monthly subscription, no commit",
      "Multi-year preferred (24–36 months) with price-lock",
    ],
  },
  {
    key: "pricing.payment_terms",
    topic: T_NEG,
    text: "Default payment terms (Net 30 / Net 60?) and when you flex.",
    required: false,
    critical: false,
    suggested_answers: [
      "Net 30 default, no flex",
      "Net 30 default, Net 60 for enterprise on request",
      "Annual upfront preferred; quarterly accepted with surcharge",
    ],
  },
  {
    key: "pricing.deal_size_floor",
    topic: T_NEG,
    text: "Below what ACV should I disqualify or push to self-serve?",
    required: false,
    critical: false,
    suggested_answers: [
      "Below $5k ACV → push to self-serve",
      "Below $10k ACV → push to self-serve",
      "Below $25k ACV → disqualify",
      "No floor — every deal is worth taking",
    ],
  },

  // Legal & approval routes -------------------------------------------------
  {
    key: "legal.msa_url",
    topic: T_LEGAL,
    text: "Where's your standard MSA / order form / SOW template? (link or location)",
    required: true,
    critical: false,
  },
  {
    key: "legal.redline_authority",
    topic: T_LEGAL,
    text: "What can I accept on redlines vs must escalate (liability cap, IP, governing law…)?",
    required: true,
    critical: false,
    suggested_answers: [
      "Accept clean signature only — escalate any redline",
      "Accept standard SOC 2 / security clauses; escalate liability, IP, or governing law changes",
      "Accept anything inside our pre-approved redline matrix; escalate the rest",
    ],
  },
  {
    key: "legal.approver_map",
    topic: T_LEGAL,
    text: "Who approves what: pricing approver, legal approver, security approver.",
    required: true,
    critical: false,
    follow_up_hints: ["name or role per category", "Slack handle or email"],
  },
  {
    key: "legal.dpa_required",
    topic: T_LEGAL,
    text: "When is a DPA required (geo, customer type, data sensitivity)?",
    required: false,
    critical: false,
    suggested_answers: [
      "EU + UK customers only",
      "All international customers",
      "Healthcare or financial-services customers",
      "Anyone who asks — never refuse",
    ],
  },
  {
    key: "legal.security_questionnaire_owner",
    topic: T_LEGAL,
    text: "Who fills inbound security questionnaires, and where do the canned answers live?",
    required: false,
    critical: false,
  },

  // Security posture --------------------------------------------------------
  {
    key: "security.certifications",
    topic: T_SEC,
    text: "Active certifications (SOC 2 / ISO 27001 / HIPAA / GDPR…) and how a prospect requests the report.",
    required: true,
    critical: false,
    follow_up_hints: ["which certs active vs in-progress", "NDA-gated link or contact"],
    suggested_answers: [
      "SOC 2 Type II — NDA-gated, request via security@",
      "SOC 2 Type II + ISO 27001 — public summary, full report under NDA",
      "SOC 2 Type I in progress — no report yet, can share gap assessment",
      "No formal certifications yet — share our security posture doc instead",
    ],
  },
  {
    key: "security.canned_answers_url",
    topic: T_SEC,
    text: "Pointer to your vendor-questionnaire answer library (URL or location).",
    required: true,
    critical: false,
  },
  {
    key: "security.security_page_url",
    topic: T_SEC,
    text: "Public trust / security page URL.",
    required: false,
    critical: false,
  },
  {
    key: "security.data_handling_summary",
    topic: T_SEC,
    text: "One-paragraph data-handling pitch I can give prospects on a call.",
    required: false,
    critical: false,
  },
  {
    key: "security.subprocessors_url",
    topic: T_SEC,
    text: "Subprocessor list URL.",
    required: false,
    critical: false,
  },

  // Reps & escalation -------------------------------------------------------
  {
    key: "reps.handoff_triggers",
    topic: T_REPS,
    text: "Conditions that should hand off to a human (enterprise tier, named accounts, sensitive asks…).",
    required: true,
    critical: true,
    follow_up_hints: ["ACV threshold", "named account list location", "topics that always escalate"],
    suggested_answers: [
      "Deals > $50k ACV, named accounts, or any redline",
      "Enterprise tier only — everything else I handle end-to-end",
      "Any security questionnaire, legal redline, or procurement involvement",
      "Anything the prospect explicitly asks to talk to a human about",
    ],
  },
  {
    key: "reps.escalation_routing",
    topic: T_REPS,
    text: "Where do escalations land? Specific person, Slack channel, or paging behavior.",
    required: true,
    critical: true,
    follow_up_hints: ["which channel or person", "expected response time"],
    suggested_answers: [
      "#agent-escalations Slack channel, round-robin to on-call AE",
      "Direct DM to VP Sales, expect reply within 2 business hours",
      "Email alias sales-escalations@ with PagerDuty rotation",
    ],
  },
  {
    key: "reps.roster",
    topic: T_REPS,
    text: "Who are the reps and what's each one's coverage (region, segment, named accounts)?",
    required: false,
    critical: false,
  },
  {
    key: "reps.tone_voice",
    topic: T_REPS,
    text: "Voice and tone I should use; phrases to use or avoid.",
    required: false,
    critical: false,
    suggested_answers: [
      "Professional and concise — no slang, no exclamation marks",
      "Casual and friendly, first-name basis, light humor okay",
      "Formal enterprise tone, full sentences, polished",
    ],
  },
  {
    key: "reps.signature_block",
    topic: T_REPS,
    text: "Email signature I should use when acting as the autonomous rep.",
    required: false,
    critical: false,
  },
  {
    key: "reps.working_hours",
    topic: T_REPS,
    text: "Time-zone respect for booking; how I should behave after hours.",
    required: false,
    critical: false,
    suggested_answers: [
      "Mon–Fri 9am–5pm rep's local time, no weekends",
      "24/7 always-on — book whenever the prospect wants",
      "Business hours only; after-hours, take a message and reply next morning",
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const QUESTIONS_BY_KEY = new Map<string, OnboardingQuestion>(
  QUESTION_BANK.map((q) => [q.key, q]),
);

export function getQuestionByKey(key: string): OnboardingQuestion | undefined {
  return QUESTIONS_BY_KEY.get(key);
}

export function getQuestionsByTopic(topic: string): OnboardingQuestion[] {
  return QUESTION_BANK.filter((q) => q.topic === topic);
}

export function getAllTopics(): TopicLabel[] {
  return ONBOARDING_TOPICS.map((t) => t.label as TopicLabel);
}

/**
 * Keys with ANY record (any of the active confidence states). Used to
 * suppress re-asking and to count "answered" in the coverage sidebar. We do
 * NOT include `stale` here — Phase 3 will re-ask stale answers as if open.
 * `pending_portal` counts as "tell the admin we've captured a draft" but
 * does NOT pass readiness — the portal confirm step is what flips it.
 */
function answeredKeysFor(
  knowledge: PlaybookKnowledge,
  topic: string,
): Set<string> {
  const entries = knowledge[topic] ?? [];
  return new Set(
    entries
      .filter((e) => {
        const c = e.confidence;
        const hasText = typeof e.answer_text === "string" && e.answer_text.trim().length > 0;
        if (c === "unknown" || c === "not_applicable") return true;
        if (c === "pending_portal") return true;
        return (c === "confirmed" || c === "draft") && hasText;
      })
      .map((e) => e.question_key),
  );
}

/**
 * Keys whose record state satisfies the 100% readiness bar: `confirmed`
 * (real answer) OR `not_applicable` (admin disclaimed with a reason — the
 * question is resolved). `draft`, `unknown`, `pending_portal` are not enough.
 */
function passingKeysFor(
  knowledge: PlaybookKnowledge,
  topic: string,
): Set<string> {
  const entries = knowledge[topic] ?? [];
  return new Set(
    entries
      .filter((e) => {
        if (e.confidence === "not_applicable") return true;
        if (e.confidence !== "confirmed") return false;
        return typeof e.answer_text === "string" && e.answer_text.trim().length > 0;
      })
      .map((e) => e.question_key),
  );
}

/** Per-topic counts based on the current knowledge map. */
export function getCoverage(knowledge: PlaybookKnowledge) {
  return ONBOARDING_TOPICS.map((topic) => {
    const all = getQuestionsByTopic(topic.label);
    const answered = answeredKeysFor(knowledge, topic.label);
    const required = all.filter((q) => q.required);
    const critical = all.filter((q) => q.critical);
    return {
      name: topic.label,
      answered: all.filter((q) => answered.has(q.key)).length,
      total: all.length,
      required_answered: required.filter((q) => answered.has(q.key)).length,
      required_total: required.length,
      critical_answered: critical.filter((q) => answered.has(q.key)).length,
      critical_total: critical.length,
    };
  });
}

/**
 * Priority-sorted next unanswered questions:
 *   critical > required > advisory
 * Tiebreak: insertion order in QUESTION_BANK (stable).
 */
export function getNextQuestions(
  knowledge: PlaybookKnowledge,
  n = 3,
): OnboardingQuestion[] {
  const answeredByTopic = new Map<string, Set<string>>();
  for (const topic of ONBOARDING_TOPICS) {
    answeredByTopic.set(topic.label, answeredKeysFor(knowledge, topic.label));
  }
  const unanswered = QUESTION_BANK.filter(
    (q) => !answeredByTopic.get(q.topic)?.has(q.key),
  );
  const score = (q: OnboardingQuestion) =>
    q.critical ? 0 : q.required ? 1 : 2;
  unanswered.sort((a, b) => score(a) - score(b));
  return unanswered.slice(0, n);
}

/**
 * True iff every `required` question in the topic is resolved — confidence
 * is either `confirmed` (real answer) or `not_applicable` (admin disclaimed
 * with a reason). `draft` and `unknown` do NOT count.
 */
export function topicFullyTaught(
  knowledge: PlaybookKnowledge,
  topicLabel: string,
): boolean {
  const required = getQuestionsByTopic(topicLabel).filter((q) => q.required);
  if (required.length === 0) return true;
  const passing = passingKeysFor(knowledge, topicLabel);
  return required.every((q) => passing.has(q.key));
}

/**
 * True iff a topic has at least one answered question in any active state
 * (confirmed | draft | not_applicable | unknown). Used by the kickoff
 * completion precondition — minimum-viable bar that lets the admin finish
 * even if they deferred some questions for later.
 */
export function topicHasAnyAnswer(
  knowledge: PlaybookKnowledge,
  topicLabel: string,
): boolean {
  return answeredKeysFor(knowledge, topicLabel).size > 0;
}

// ---------------------------------------------------------------------------
// N/A guardrails: critical questions cannot be skipped via skip_question
// ---------------------------------------------------------------------------

/**
 * Questions that must NEVER be marked `not_applicable` — the operational
 * guardrails Sales Agent literally cannot run autonomously without. Admins must
 * give a real answer (or use `acknowledge_unknown` to defer briefly), even
 * if it's a degenerate one like "never discount" or "always escalate".
 *
 * Source: every `critical: true` question in the bank. We expose it as a
 * Set so the agent's skip_question handler can reject in O(1).
 */
export const CRITICAL_NON_NA: ReadonlySet<string> = new Set(
  QUESTION_BANK.filter((q) => q.critical).map((q) => q.key),
);

/**
 * Questions whose canonical answer is portal-only — the chat agent may
 * propose a value (writes to `proposed_value` with confidence='pending_portal')
 * but the actual `answer_text` change requires the admin to confirm via the
 * Operational Rules dashboard. Captures the Notion vision: "Sales Agent can ask.
 * Sales Agent cannot rewrite the rules."
 *
 * These are the operational + legal guardrails — discount authority,
 * escalation routes, redline ceilings, approver map. Wrong values here mean
 * Sales Agent gives away the deal, escalates to nobody, or signs a redline it
 * shouldn't. The portal step is a deliberate two-key turn.
 */
export const PORTAL_ONLY_KEYS: ReadonlySet<string> = new Set([
  "pricing.discount_authority",
  "pricing.escalation_triggers",
  "reps.handoff_triggers",
  "reps.escalation_routing",
  "legal.redline_authority",
  "legal.approver_map",
]);

export function isPortalOnly(questionKey: string): boolean {
  return PORTAL_ONLY_KEYS.has(questionKey);
}

// ---------------------------------------------------------------------------
// Knowledge depth — surfaces "there's still more to teach Sales Agent" above the
// 100% readiness bar. Depth keeps growing even after a kickoff completes.
// ---------------------------------------------------------------------------

export interface KnowledgeDepth {
  /** Total questions in the bank (constant). */
  total_questions: number;
  /** Questions with `confirmed` confidence — the strongest signal. */
  confirmed: number;
  /** Questions with `not_applicable` (admin disclaimed with a reason). */
  not_applicable: number;
  /** Questions with `unknown` (deferred — depth meter surfaces them). */
  unknown: number;
  /** Questions with `draft` (vague — worth revisiting). */
  draft: number;
  /** Questions with no record at all (never asked or never answered). */
  open: number;
  /**
   * % of bank that has a `confirmed` or `not_applicable` answer. Caps at 100.
   * Distinct from readiness %: this measures depth across ALL 33 questions
   * (advisory + required + critical), not just the required ones.
   */
  depth_pct: number;
}

export function getKnowledgeDepth(knowledge: PlaybookKnowledge): KnowledgeDepth {
  let confirmed = 0;
  let notApplicable = 0;
  let unknown = 0;
  let draft = 0;
  let recorded = 0;

  for (const q of QUESTION_BANK) {
    const topicEntries = knowledge[q.topic] ?? [];
    const entry = topicEntries.find((e) => e.question_key === q.key);
    if (!entry) continue;
    recorded += 1;
    if (entry.confidence === "confirmed") confirmed += 1;
    else if (entry.confidence === "not_applicable") notApplicable += 1;
    else if (entry.confidence === "unknown") unknown += 1;
    else if (entry.confidence === "draft") draft += 1;
    // pending_portal counts as "recorded" so it's not double-counted as open,
    // but doesn't fall into any of the depth-meter visible buckets — it's
    // surfaced separately by the portal UI.
  }

  const total = QUESTION_BANK.length;
  const open = total - recorded;
  const depthPct = total === 0 ? 100 : Math.round(((confirmed + notApplicable) / total) * 100);

  return {
    total_questions: total,
    confirmed,
    not_applicable: notApplicable,
    unknown,
    draft,
    open,
    depth_pct: depthPct,
  };
}