import type { MemoryCategory } from '../services/memory/types.js';

export const PROACTIVE_MEMORY_CATEGORIES = [
  'preference',
  'relationship_fact',
  'correction',
] as const satisfies readonly MemoryCategory[];

export function isProactiveMemoryCategory(category: MemoryCategory): boolean {
  return (PROACTIVE_MEMORY_CATEGORIES as readonly MemoryCategory[]).includes(category);
}

export function isDateSensitiveCalendarQuery(text: string): boolean {
  return /\b(today|today's|this morning|this afternoon|this evening)\b/i.test(text);
}

export function calendarDayBounds(currentISO: string, timezone: string) {
  const date = currentISO.slice(0, 10);
  const probe = new Date(`${date}T12:00:00Z`);
  const part = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  }).formatToParts(probe).find((item) => item.type === 'timeZoneName')?.value;
  const offset = part?.match(/GMT([+-]\d{2}:\d{2})/)?.[1] || '+00:00';

  return {
    date,
    dateFrom: `${date}T00:00:00${offset}`,
    dateTo: `${date}T23:59:59${offset}`,
  };
}
