/**
 * Shared helper to resolve a calendar event ID.
 *
 * LLMs frequently hallucinate event IDs (e.g. "test_block_event_id" or the
 * event summary). This helper detects non-Google-style IDs and falls back to
 * a calendar search to find the real event.
 *
 * Real Google Calendar event IDs are base32hex strings like
 * "4ob6qhsbeos0e3cg73bj4qv3kd" — 20+ lowercase chars from [a-v0-9].
 * Recurring instances append "_YYYYMMDDTHHMMSSZ".
 */

import { getGoogleTokens, googleApiFetch } from '../services/token-manager.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'calendar_resolve' });

/**
 * Returns true if the string looks like a real Google Calendar event ID.
 * Real IDs use base32hex: [a-v0-9]{20,}, optionally with _YYYYMMDDTHHMMSSZ
 * for recurring instances.
 */
function looksLikeRealEventId(id: string): boolean {
  // Base event: 20+ chars of [a-v0-9] only
  if (/^[a-v0-9]{20,}$/.test(id)) return true;
  // Recurring instance: base_YYYYMMDDTHHMMSSZ
  if (/^[a-v0-9]{20,}_\d{8}T\d{6}Z$/.test(id)) return true;
  return false;
}

export interface ResolvedEvent {
  eventId: string;
  summary: string;
  start: string;
  end: string;
}

/**
 * Resolve an eventId: if it looks like a real Google ID, return it directly.
 * Otherwise, search the user's calendar for a matching event and return the
 * first match.
 */
export async function resolveEventId(
  userId: string,
  eventIdOrQuery: string,
): Promise<{ resolved: true; event: ResolvedEvent } | { resolved: false; error: string }> {
  if (looksLikeRealEventId(eventIdOrQuery)) {
    return { resolved: true, event: { eventId: eventIdOrQuery, summary: '', start: '', end: '' } };
  }

  // The LLM passed a summary or made-up ID — search for the event
  log.info({ eventIdOrQuery }, 'Does not look like a real event ID, searching');

  const tokens = await getGoogleTokens(userId);
  if (!tokens) {
    return { resolved: false, error: 'Google Calendar not connected.' };
  }

  try {
    const now = new Date();
    const timeMin = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const timeMax = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();

    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&maxResults=5&singleEvents=true&orderBy=startTime&q=${encodeURIComponent(eventIdOrQuery)}`;

    const res = await googleApiFetch(url, tokens.accessToken);
    if (!res.ok) {
      return { resolved: false, error: `Calendar API search failed: ${res.status}` };
    }

    const data = await res.json();
    const items = data.items || [];

    if (items.length === 0) {
      return { resolved: false, error: `No events found matching "${eventIdOrQuery}".` };
    }

    const match = items[0];
    log.info({ eventIdOrQuery, resolvedId: match.id, summary: match.summary }, 'Resolved event ID');

    return {
      resolved: true,
      event: {
        eventId: match.id,
        summary: match.summary || '',
        start: match.start?.dateTime || match.start?.date || '',
        end: match.end?.dateTime || match.end?.date || '',
      },
    };
  } catch (err: any) {
    return { resolved: false, error: `Search failed: ${err.message}` };
  }
}
