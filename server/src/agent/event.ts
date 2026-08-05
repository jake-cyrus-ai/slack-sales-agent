/**
 * Normalized Event Schema — all inbound triggers (Slack, email, calendar)
 * are normalized into this shape before entering the orchestrator.
 */

import { randomUUID } from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export type EventSource = 'slack_dm' | 'slack_mention' | 'email_webhook' | 'calendar_trigger';
export type EventType = 'user_message' | 'inbound_email' | 'calendar_change';
export type Urgency = 'low' | 'medium' | 'high';

export interface InferredEntities {
  deal_id?: string;
  account_id?: string;
  contact_id?: string;
  company_name?: string;
  person_name?: string;
}

export interface RoutingHints {
  urgency: Urgency;
  intent: string;
  requires_deep_research: boolean;
  domain_hint?: string;
}

export interface NormalizedEvent {
  id: string;
  org_id: string;
  user_id: string;
  source: EventSource;
  type: EventType;
  timestamp: string;
  raw_payload_ref: string;
  extracted_text: string;
  inferred_entities: InferredEntities;
  routing_hints: RoutingHints;
}

// ─── Entity extraction helpers ──────────────────────────────────────────────

const EMAIL_RE = /[\w.-]+@[\w.-]+\.\w{2,}/g;
const COMPANY_DOMAIN_RE = /@([\w-]+)\.\w{2,}/;

/**
 * Light-weight entity extraction from free text.
 * Does NOT call an LLM — regex + heuristics only.
 */
function extractEntities(text: string): InferredEntities {
  const entities: InferredEntities = {};

  // Extract company name from email domains mentioned
  const emails = text.match(EMAIL_RE) || [];
  if (emails.length > 0) {
    const domainMatch = emails[0].match(COMPANY_DOMAIN_RE);
    if (domainMatch) {
      const domain = domainMatch[1].toLowerCase();
      const CONSUMER_DOMAINS = ['gmail', 'yahoo', 'hotmail', 'outlook', 'icloud'];
      if (!CONSUMER_DOMAINS.includes(domain)) {
        entities.company_name = domain.charAt(0).toUpperCase() + domain.slice(1);
      }
    }
  }

  // Extract person names from common patterns: "from John Smith", "with Jane Doe"
  const namePatterns = [
    /(?:from|with|to|cc|meet(?:ing)?\s+with)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/g,
  ];
  for (const pattern of namePatterns) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      entities.person_name = match[1];
      break;
    }
  }

  return entities;
}

// ─── Routing hint extraction ────────────────────────────────────────────────

const URGENCY_HIGH_PATTERNS = [
  /\b(?:urgent|asap|immediately|critical|deadline|due\s+(?:today|tomorrow|next\s+week))\b/i,
  /\b(?:cfo|ceo|cto|vp|board|executive)\b/i,
];

const URGENCY_MEDIUM_PATTERNS = [
  /\b(?:business\s*case|proposal|contract|pricing|close|next\s*step)/i,
  /\b(?:follow[- ]?up|meeting|demo|call)\b/i,
];

const DEEP_RESEARCH_PATTERNS = [
  /\b(?:research|look\s*up|find\s+(?:info|out)|who\s+is|background|linkedin)\b/i,
  /\b(?:cfo|ceo|cto|vp|chief)\b/i,
];

function extractRoutingHints(text: string, domainHint?: string): RoutingHints {
  const lower = text.toLowerCase();

  let urgency: Urgency = 'low';
  if (URGENCY_HIGH_PATTERNS.some(p => p.test(lower))) {
    urgency = 'high';
  } else if (URGENCY_MEDIUM_PATTERNS.some(p => p.test(lower))) {
    urgency = 'medium';
  }

  const requires_deep_research = DEEP_RESEARCH_PATTERNS.some(p => p.test(lower));

  // Simple intent extraction (not LLM — just regex signal)
  let intent = 'general';
  if (/\b(?:deal|pipeline|stage|crm|opportunity)\b/i.test(lower)) intent = 'deal_update';
  else if (/\b(?:playbook|battle\s*card|objection|what\s+should\s+I)\b/i.test(lower)) intent = 'enablement';
  else if (/\b(?:calendar|schedule|free|busy|slot|available|book)\b/i.test(lower)) intent = 'scheduling';
  else if (/\b(?:meeting\s+notes|transcript|granola|what\s+was\s+discussed)\b/i.test(lower)) intent = 'transcript';
  else if (/\b(?:research|linkedin|background|who\s+is)\b/i.test(lower)) intent = 'research';
  else if (/\b(?:email|gmail|inbox|reply|send|draft)\b/i.test(lower)) intent = 'email';
  else if (/\b(?:pricing|soc|security|compliance|doc|knowledge)\b/i.test(lower)) intent = 'knowledge';

  return {
    urgency,
    intent,
    requires_deep_research,
    domain_hint: domainHint,
  };
}

// ─── Builder ────────────────────────────────────────────────────────────────

export interface BuildEventParams {
  org_id: string;
  user_id: string;
  source: EventSource;
  type: EventType;
  extracted_text: string;
  raw_payload_ref?: string;
  domain_hint?: string;
}

/**
 * Build a NormalizedEvent from raw input.
 * Entity extraction and routing hints are computed synchronously (no LLM).
 */
export function buildNormalizedEvent(params: BuildEventParams): NormalizedEvent {
  return {
    id: randomUUID(),
    org_id: params.org_id,
    user_id: params.user_id,
    source: params.source,
    type: params.type,
    timestamp: new Date().toISOString(),
    raw_payload_ref: params.raw_payload_ref || '',
    extracted_text: params.extracted_text,
    inferred_entities: extractEntities(params.extracted_text),
    routing_hints: extractRoutingHints(params.extracted_text, params.domain_hint),
  };
}
