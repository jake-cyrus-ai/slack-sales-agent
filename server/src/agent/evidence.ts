/**
 * Evidence utilities — query scope resolution, entity extraction, intent inference.
 *
 * The heavy claim extraction, scoring, and conflict detection that lived here
 * has been replaced by LLM-native evidence assessment in synthesizeNode.
 */

import { isBusinessDomain } from './tenant-context.js';

export type QueryIntentType = 'pricing' | 'commitment' | 'next_steps' | 'timeline' | 'general_status';
export type QueryEntityType = 'customer' | 'deal' | 'person' | 'unknown';

export interface QueryScope {
  entityName: string | null;
  entityNames: string[];
  entityType: QueryEntityType;
  intentType: QueryIntentType;
  rawQuery?: string | null;
}

export function resolveQueryScopeFromText(text: string, _strictMode?: boolean): QueryScope {
  const entities = extractEntities(text);
  const entityName = entities[0] ?? null;
  const intentType = inferIntent(text);
  const entityType: QueryEntityType = entityName ? 'customer' : inferEntityType(text);

  return {
    entityName,
    entityNames: entities,
    entityType,
    intentType,
    rawQuery: text,
  };
}

const ENTITY_STOPWORDS = new Set([
  'The', 'This', 'That', 'Some', 'Any', 'Our', 'Their', 'My', 'Your',
  'Here', 'There', 'What', 'How', 'When', 'Where', 'Which', 'Who',
  'He', 'She', 'It', 'Him', 'Her', 'His', 'Its', 'We', 'Us', 'Them',
  'All', 'Every', 'Everyone', 'Someone', 'Anyone', 'No', 'None',
  'Next', 'New', 'First', 'Last', 'Do',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
]);

const ENTITY_WORD = '[A-Z][\\w&\'-]*';
const ENTITY_CONT = `(?:\\s+${ENTITY_WORD}){0,3}`;
const ENTITY_GROUP = `([A-Z][\\w&'-]*(?:\\.\\w+)*${ENTITY_CONT})`;

export function extractEntities(text: string): string[] {
  const normalized = text.trim();
  const patterns = [
    new RegExp(`\\b(?:[Dd]eal|[Ss]tatus|[Rr]elationship|[Cc]ustomer|[Aa]ccount|[Pp]ricing|[Tt]erms)\\s+(?:with|for)\\s+${ENTITY_GROUP}`),
    new RegExp(`\\b(?:[Ee]mail|[Mm]essage|[Nn]ote|[Ff]ollow[ -]?up)\\s+(?:to|for)\\s+${ENTITY_GROUP}`),
    new RegExp(`\\b[Ww]ith\\s+${ENTITY_GROUP}`),
    new RegExp(`\\b[Aa]bout\\s+${ENTITY_GROUP}`),
    new RegExp(`\\b[Aa]t\\s+${ENTITY_GROUP}`),
  ];

  const seen = new Set<string>();
  const entities: string[] = [];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      const entity = match[1].trim();
      if (ENTITY_STOPWORDS.has(entity.split(' ')[0])) continue;
      const key = entity.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        entities.push(entity);
      }
    }
  }
  return entities;
}

export function inferIntent(text: string): QueryIntentType {
  const lower = text.toLowerCase();
  if (/price|pricing|terms|pay|contract/.test(lower)) return 'pricing';
  if (/agree|commit|committed|promis|obligation/.test(lower)) return 'commitment';
  if (/next step|follow up|todo|action item/.test(lower)) return 'next_steps';
  if (/when|timeline|date|deadline|this week|next week/.test(lower)) return 'timeline';
  return 'general_status';
}

function inferEntityType(text: string): QueryEntityType {
  const lower = text.toLowerCase();
  if (/\bdeal|account|customer|prospect|opportunity\b/.test(lower)) return 'deal';
  if (/\bwith [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/.test(text)) return 'person';
  return 'unknown';
}

export function classifyEmailDirection(
  fromDomain: string | null,
  tenantContext: { trustedDomains?: string[]; primaryUserDomain?: string } | null
): 'internal' | 'external' | 'unknown' {
  if (!fromDomain) return 'unknown';
  const trusted = new Set((tenantContext?.trustedDomains || []).map((d) => d.toLowerCase()));
  if (trusted.size === 0 && tenantContext?.primaryUserDomain) {
    trusted.add(tenantContext.primaryUserDomain.toLowerCase());
  }
  if (trusted.size === 0) return 'unknown';
  if (trusted.has(fromDomain.toLowerCase())) return 'internal';
  if (!isBusinessDomain(fromDomain)) return 'unknown';
  return 'external';
}
