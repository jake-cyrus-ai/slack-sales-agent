/**
 * Onboarding topic registry — server side.
 *
 * Mirrors the client-side `brainTopicRegistry.ts`. Two registries exist
 * intentionally: the client one carries UI-only fields (placeholders,
 * blurbs, mode visibility) the server doesn't need; the server one
 * carries only the fields the readiness rules engine cares about.
 *
 * The `label` on each row is the source of truth for matching:
 * wizard-uploaded playbooks have `name === label`. Renaming a label
 * here detaches it from any in-the-wild playbooks of that name; treat
 * labels as stable.
 */

export type OnboardingTopicId =
  | "icp"
  | "competitors"
  | "negotiation"
  | "legal_routes"
  | "security"
  | "reps_and_escalation";

export type OnboardingMode = "enterprise" | "plg";

export interface OnboardingTopic {
  id: OnboardingTopicId;
  /** Stable display label. Wizard uses this as the playbook `name`. */
  label: string;
  /** Why this topic matters — surfaces in the readiness gap UI. */
  whyItMatters: string;
  /** Modes where this topic is required to pass readiness. */
  requiredFor: OnboardingMode[];
}

export const ONBOARDING_TOPICS: OnboardingTopic[] = [
  {
    id: "icp",
    label: "ICP & positioning",
    whyItMatters:
      "Without a defined ICP, Sales Agent qualifies every prospect the same way and can't separate fits from tire-kickers.",
    requiredFor: ["enterprise", "plg"],
  },
  {
    id: "competitors",
    label: "Competitors",
    whyItMatters:
      "When prospects ask 'how does this compare to X', Sales Agent has nothing concrete to say and falls back to generic feature lists.",
    requiredFor: ["enterprise"],
  },
  {
    id: "negotiation",
    label: "Negotiation guidance",
    whyItMatters:
      "If a prospect asks for pricing flexibility and Sales Agent has no guardrails, it either over-promises or punts every deal to a rep.",
    requiredFor: ["enterprise"],
  },
  {
    id: "legal_routes",
    label: "Legal & approval routes",
    whyItMatters:
      "Redline asks (MSA, DPA, indemnification) need named approvers. Without them Sales Agent can't route correctly and conversations stall.",
    requiredFor: ["enterprise"],
  },
  {
    id: "security",
    label: "Security posture",
    whyItMatters:
      "Enterprise prospects ask about SOC 2 / ISO / pen-tests early. With no posture defined, Sales Agent has to defer every time and you lose momentum.",
    requiredFor: ["enterprise"],
  },
  {
    id: "reps_and_escalation",
    label: "Reps & escalation",
    whyItMatters:
      "When Sales Agent needs to hand off to a human, it has to know who. Missing this means warm prospects hit dead ends.",
    requiredFor: ["enterprise", "plg"],
  },
];
