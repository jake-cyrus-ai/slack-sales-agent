/**
 * Calendar Search Tool — search calendar events via DB and Google Calendar API.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { getGoogleTokens, googleApiFetch } from '../services/token-manager.js';
import { ToolAuthorizationError, ToolAPIError, withToolErrorHandling } from '../lib/tool-errors.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'calendar_search' });

const INVESTOR_KEYWORDS = /\b(investor|investment|fundrais|term sheet|cap table|due diligence|board meeting|board sync|vc|venture capital)\b/i;
const HIRING_KEYWORDS = /\b(interview|candidate|recruiting|hiring|job application|resume review|culture fit)\b/i;
const INVESTOR_DOMAINS = new Set([
  'nea.com', 'bvp.com', 'sequoiacap.com', 'a16z.com', 'greylock.com',
  'bessemer.com', 'khoslaventures.com', 'indexventures.com', 'benchmark.com',
  'accel.com', 'generalcatalyst.com', 'lsvp.com', 'insightpartners.com',
]);

function isNonSalesEvent(event: any): boolean {
  const summary = (event.summary || '').toLowerCase();
  const description = (event.description || '').toLowerCase();
  const text = `${summary} ${description}`;

  if (INVESTOR_KEYWORDS.test(text) || HIRING_KEYWORDS.test(text)) return true;

  // Check if all external attendees are from investor domains
  const attendees = event.attendees || [];
  if (attendees.length > 0) {
    const externalAttendees = attendees.filter((a: any) => {
      const email = (a.email || a).toLowerCase();
      return !email.includes('@') ? false : true; // keep only emails
    });
    const allInvestor = externalAttendees.length > 0 && externalAttendees.every((a: any) => {
      const email = (typeof a === 'string' ? a : a.email || '').toLowerCase();
      const domain = email.split('@')[1];
      return domain && INVESTOR_DOMAINS.has(domain);
    });
    if (allInvestor) return true;
  }

  return false;
}

export function createCalendarSearchTool(userId: string) {
  return new DynamicStructuredTool({
    name: 'calendar_search',
    description:
      'Search calendar events by keyword, date range, or attendee. Returns eventId for each result — use this eventId with calendar_update or calendar_delete. Set salesOnly=true to exclude investor, hiring, and internal-only meetings.',
    schema: z.object({
      query: z.string().optional().describe('Text to search in event summaries/descriptions'),
      dateFrom: z.string().optional().describe('Start date in ISO 8601 with timezone offset (e.g. "2026-03-18T00:00:00-05:00"). Use the user\'s timezone, not UTC.'),
      dateTo: z.string().optional().describe('End date in ISO 8601 with timezone offset. Use the user\'s timezone, not UTC.'),
      salesOnly: z.boolean().optional().default(false).describe('When true, exclude investor/VC and hiring meetings from results.'),
      fresh: z.boolean().optional().default(false).describe('When true, bypass cached database rows and query Google Calendar directly. Required for date-sensitive questions such as today or tomorrow.'),
    }),
    func: withToolErrorHandling('calendar_search', async ({ query, dateFrom, dateTo, salesOnly, fresh }) => {
      log.info({ query, dateFrom, dateTo, salesOnly, fresh }, 'Searching calendar');

      // Try database first (calendar_events table)
      if (!fresh) try {
        let dbQuery = supabase
          .from('calendar_events')
          .select('google_event_id, summary, description, start_time, end_time, attendees, location, meeting_link')
          .eq('user_id', userId)
          .order('start_time', { ascending: true })
          .limit(10);

        if (dateFrom) dbQuery = dbQuery.gte('start_time', dateFrom);
        if (dateTo) dbQuery = dbQuery.lte('start_time', dateTo);

        const { data: dbEvents, error: dbError } = await dbQuery;

        if (!dbError && dbEvents && dbEvents.length > 0) {
          // Filter by query text if provided
          let results = dbEvents;
          if (query) {
            const q = query.toLowerCase();
            results = dbEvents.filter(
              (e: any) =>
                e.summary?.toLowerCase().includes(q) ||
                e.description?.toLowerCase().includes(q) ||
                JSON.stringify(e.attendees || []).toLowerCase().includes(q)
            );
          }

          if (salesOnly) {
            results = results.filter((e: any) => !isNonSalesEvent(e));
          }

          if (results.length > 0) {
            log.info({ count: results.length, salesOnly }, 'Found events in DB');
            return JSON.stringify({
              source: 'database',
              results: results.map((e: any) => ({
                eventId: e.google_event_id,
                summary: e.summary,
                start: e.start_time,
                end: e.end_time,
                attendees: e.attendees,
                location: e.location,
                meetingLink: e.meeting_link,
              })),
            });
          }
        }
      } catch (err) {
        log.info({ err }, 'DB query failed, trying live API');
      }

      // Fall back to live Google Calendar API
      const tokens = await getGoogleTokens(userId);
      if (!tokens) {
        throw new ToolAuthorizationError('calendar_search', 'Google Calendar not connected.');
      }

      const now = new Date();
      const timeMin = dateFrom || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const timeMax = dateTo || new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

      let url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&maxResults=10&singleEvents=true&orderBy=startTime`;
      if (query) url += `&q=${encodeURIComponent(query)}`;

      const res = await googleApiFetch(url, tokens.accessToken);
      if (!res.ok) {
        throw new ToolAPIError('calendar_search', `Calendar API failed: ${res.status}`, res.status);
      }

      const data = await res.json();
      let events = (data.items || []).map((e: any) => ({
        eventId: e.id,
        summary: e.summary,
        description: e.description,
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
        attendees: (e.attendees || []).map((a: any) => ({
          email: a.email,
          name: a.displayName,
          status: a.responseStatus,
        })),
        location: e.location,
        meetingLink: e.hangoutLink || e.conferenceData?.entryPoints?.[0]?.uri,
      }));

      // Filter out events that start outside the requested range
      // Google Calendar API can return events outside timeMin/timeMax with recurring events
      if (dateFrom || dateTo) {
        const minTime = dateFrom ? new Date(dateFrom).getTime() : 0;
        const maxTime = dateTo ? new Date(dateTo).getTime() : Infinity;
        const before = events.length;
        events = events.filter((e: any) => {
          const startTime = new Date(e.start).getTime();
          return startTime >= minTime && startTime <= maxTime;
        });
        if (events.length < before) {
          log.info({ filtered: before - events.length }, 'Filtered out-of-range events');
        }
      }

      if (salesOnly) {
        events = events.filter((e: any) => !isNonSalesEvent(e));
      }

      log.info({ count: events.length, salesOnly }, 'Found events via API');
      return JSON.stringify({ source: 'google_api', results: events });
    }),
  });
}
