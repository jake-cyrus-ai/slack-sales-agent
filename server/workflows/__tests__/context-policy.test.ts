import { describe, expect, it } from 'vitest';
import {
  calendarDayBounds,
  isDateSensitiveCalendarQuery,
  isProactiveMemoryCategory,
} from '../../src/agent/context-policy';

describe('context policy', () => {
  it('never proactively injects historical artifacts', () => {
    expect(isProactiveMemoryCategory('preference')).toBe(true);
    expect(isProactiveMemoryCategory('relationship_fact')).toBe(true);
    expect(isProactiveMemoryCategory('correction')).toBe(true);
    expect(isProactiveMemoryCategory('historical_artifact')).toBe(false);
  });

  it('recognizes date-sensitive calendar questions', () => {
    expect(isDateSensitiveCalendarQuery('What meetings do I have today?')).toBe(true);
    expect(isDateSensitiveCalendarQuery('Who is Steve at Rox?')).toBe(false);
  });

  it('builds Chicago-local boundaries instead of UTC boundaries', () => {
    expect(calendarDayBounds('2026-08-07T09:43:00-05:00', 'America/Chicago')).toEqual({
      date: '2026-08-07',
      dateFrom: '2026-08-07T00:00:00-05:00',
      dateTo: '2026-08-07T23:59:59-05:00',
    });
  });
});
