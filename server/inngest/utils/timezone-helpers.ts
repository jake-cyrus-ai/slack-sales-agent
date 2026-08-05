/**
 * Shared timezone helpers for cron scanners and scheduled functions.
 *
 * Extracted from morning-briefing.ts so they can be reused by:
 * - action-digest scanner (5 PM local)
 * - reminder scanner (trigger_at comparison)
 * - guardrail rate-limit queries (today's date in user's TZ)
 */

/** Returns the YYYY-MM-DD date string for an ISO timestamp in the given timezone. */
export function getLocalDate(isoTimestamp: string, tz: string): string {
  try {
    const d = new Date(isoTimestamp);
    const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: tz }); // en-CA gives YYYY-MM-DD
    return formatter.format(d);
  } catch {
    return new Date(isoTimestamp).toISOString().slice(0, 10);
  }
}

/** Returns a UTC Date representing midnight of today + dayOffset in the given timezone. */
export function getLocalMidnight(tz: string, dayOffset: number): Date {
  const localDate = getLocalDate(new Date().toISOString(), tz);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "shortOffset",
  }).formatToParts(new Date(`${localDate}T12:00:00Z`));
  const tzPart = parts.find((p) => p.type === "timeZoneName")?.value || "+0";
  const match = tzPart.match(/GMT([+-]?)(\d+)(?::(\d+))?/);
  let offsetMs = 0;
  if (match) {
    const sign = match[1] === "-" ? -1 : 1;
    const hours = parseInt(match[2], 10);
    const minutes = parseInt(match[3] || "0", 10);
    offsetMs = sign * (hours * 60 + minutes) * 60 * 1000;
  }
  const midnight = new Date(`${localDate}T00:00:00Z`);
  midnight.setTime(midnight.getTime() - offsetMs + dayOffset * 24 * 60 * 60 * 1000);
  return midnight;
}

/** Returns the current hour (0-23) in the given timezone. Returns -1 on error. */
export function getLocalHour(tz: string): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    });
    return parseInt(formatter.format(new Date()), 10);
  } catch {
    return -1;
  }
}

/** Returns 0 (Sun) through 6 (Sat) in the user's local timezone. Returns -1 on error. */
export function getLocalDayOfWeek(tz: string): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
    });
    const day = formatter.format(new Date());
    const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[day] ?? -1;
  } catch {
    return -1;
  }
}

/** Returns true if it's currently a weekday (Mon-Fri) in the given timezone. */
export function isWeekday(tz: string): boolean {
  const day = getLocalDayOfWeek(tz);
  return day >= 1 && day <= 5;
}

/**
 * Convert a local date + time (in a specific timezone) to a UTC Date.
 * Handles DST correctly by probing the offset for the target date.
 *
 * @param date - YYYY-MM-DD string
 * @param hour - 0-23
 * @param minute - 0-59
 * @param tz - IANA timezone (e.g., "America/New_York")
 */
export function localDateTimeToUTC(date: string, hour: number, minute: number, tz: string): Date {
  const hh = String(Math.max(0, Math.min(23, hour))).padStart(2, "0");
  const mm = String(Math.max(0, Math.min(59, minute))).padStart(2, "0");
  const localStr = `${date}T${hh}:${mm}:00`;

  // Find the UTC offset for this timezone on this date
  const probe = new Date(`${date}T12:00:00Z`); // noon UTC to avoid DST edge
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "shortOffset",
  }).formatToParts(probe);
  const tzPart = parts.find((p) => p.type === "timeZoneName")?.value || "+0";
  const match = tzPart.match(/GMT([+-]?)(\d+)(?::(\d+))?/);
  let offsetMs = 0;
  if (match) {
    const sign = match[1] === "-" ? -1 : 1;
    const hours = parseInt(match[2], 10);
    const minutes = parseInt(match[3] || "0", 10);
    offsetMs = sign * (hours * 60 + minutes) * 60 * 1000;
  }

  return new Date(new Date(localStr + "Z").getTime() - offsetMs);
}

/**
 * Format a UTC Date into a human-readable local datetime string.
 * e.g. "Sunday, April 5 at 11:47 PM"
 *
 * Returns a plain string — the LLM has today's date in its context
 * and can determine today/tomorrow/etc. on its own.
 */
export function toLocalDisplay(utcDate: Date, tz: string): string {
  try {
    return utcDate.toLocaleString("en-US", {
      timeZone: tz,
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return utcDate.toISOString();
  }
}
