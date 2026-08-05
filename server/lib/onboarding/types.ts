/**
 * Shared types for the onboarding Q&A trainer.
 *
 * Storage: `organizations.settings.prospect_chat_knowledge` is a JSON object
 * keyed by the canonical topic label (see topics.ts), each value an array of
 * answered/draft question records. Old `prospect_chat_playbooks` (free-text
 * per topic) is left intact and consulted only for backfill via
 * `read_imported_notes`.
 */

/**
 * Confidence states for a stored Q&A answer.
 *   - `confirmed`      — concrete, complete answer.
 *   - `draft`          — vague/partial answer saved after one follow-up.
 *   - `not_applicable` — admin explicitly disclaimed with a reason
 *                        (stored in `na_reason`). Counts toward 100% readiness
 *                        because the question is resolved.
 *   - `unknown`        — admin deferred ("ask me later"). Counts as
 *                        "answered" for the kickoff bar but NOT for 100%
 *                        readiness — depth meter surfaces it.
 *   - `pending_portal` — chat captured a proposed value for a PORTAL_ONLY
 *                        question, but admin must confirm via the portal
 *                        before it becomes canonical. `proposed_value`
 *                        carries the chat's draft; `answer_text` stays
 *                        whatever was last confirmed. Does NOT count toward
 *                        readiness — the portal confirmation does.
 *   - `stale`          — Phase 3 forward-compat: confirmed answers that
 *                        expired after N days and need re-asking.
 */
export type AnswerConfidence =
  | "draft"
  | "confirmed"
  | "stale"
  | "not_applicable"
  | "unknown"
  | "pending_portal";

export interface KnowledgeAnswer {
  question_key: string;
  question_text: string;
  answer_text: string;
  confidence: AnswerConfidence;
  updated_at: string;
  /** Populated only when confidence='not_applicable'. Required by the RPC (>=8 chars). */
  na_reason?: string;
  /** Chat-proposed value awaiting portal confirmation (PORTAL_ONLY questions). */
  proposed_value?: string;
  /** When the proposal was captured. */
  proposed_at?: string;
  /** Audit channel: 'chat' | 'portal'. Records which surface produced the write. */
  updated_via?: "chat" | "portal";
}

/** Topic label → list of answered questions under that topic. */
export type PlaybookKnowledge = Record<string, KnowledgeAnswer[]>;

export interface TopicCoverage {
  /** Canonical label from topics.ts. */
  name: string;
  answered: number;
  total: number;
  required_answered: number;
  required_total: number;
  critical_answered: number;
  critical_total: number;
}