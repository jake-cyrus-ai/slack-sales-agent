/**
 * Calendar Update Tool — modify existing calendar events via Google Calendar API.
 * Uses patch (partial update) so only the fields provided are changed.
 *
 * Includes automatic resolution of hallucinated/invalid event IDs via search.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getCalendarClient } from '../services/google-client.js';
import { resolveEventId } from './calendar-resolve.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'calendar_update' });

export function createCalendarUpdateTool(userId: string, userTimezone?: string) {
  return new DynamicStructuredTool({
    name: 'calendar_update',
    description:
      'Update an existing event on the user\'s Google Calendar. Use when the user asks to reschedule, move, rename, ' +
      'add/remove attendees, change location, or otherwise modify a calendar event. ' +
      'You can pass either a real event ID (from calendar_search) or the event name/summary and it will be resolved automatically. ' +
      'Only provide the fields that need to change; unchanged fields are left as-is.',
    schema: z.object({
      eventId: z.string().describe('The Google Calendar event ID, or the event name/summary to search for'),
      summary: z.string().optional().describe('New event title'),
      startDateTime: z.string().optional().describe('New start time in ISO 8601 format'),
      endDateTime: z.string().optional().describe('New end time in ISO 8601 format'),
      description: z.string().optional().describe('New event description'),
      attendees: z.array(z.string()).optional().describe('Full replacement list of attendee emails. To add/remove an attendee, include the complete desired list.'),
      location: z.string().optional().describe('New event location or meeting link'),
      addVideoConference: z.boolean().optional().describe('When true, adds a Google Meet link if one does not already exist'),
    }),
    func: async ({ eventId, summary, startDateTime, endDateTime, description, attendees, location, addVideoConference }) => {
      log.info({ eventId, fields: [summary && 'summary', startDateTime && 'start', endDateTime && 'end', description && 'desc', attendees && 'attendees', location && 'location', addVideoConference && 'meet'].filter(Boolean) }, 'Updating calendar event');

      // Resolve the event ID (handles hallucinated IDs by searching)
      const resolution = await resolveEventId(userId, eventId);
      if (!resolution.resolved) {
        const resolveError: string = (resolution as any).error;
        return JSON.stringify({
          _meta: { tool: 'calendar_update', eventId },
          success: false,
          error: resolveError,
        });
      }
      const realEventId = resolution.event.eventId;

      const calendar = await getCalendarClient(userId);
      if (!calendar) {
        return JSON.stringify({
          _meta: { tool: 'calendar_update', eventId: realEventId },
          success: false,
          error: 'Google Calendar not connected.',
        });
      }

      try {
        const tz = userTimezone || 'UTC';
        const patchBody: any = {};

        if (summary !== undefined) patchBody.summary = summary;
        if (description !== undefined) patchBody.description = description;
        if (location !== undefined) patchBody.location = location;

        if (startDateTime) {
          const start = new Date(startDateTime);
          if (isNaN(start.getTime())) {
            return JSON.stringify({
              _meta: { tool: 'calendar_update', eventId: realEventId },
              success: false,
              error: 'Invalid startDateTime — must be a valid ISO 8601 date string.',
            });
          }
          patchBody.start = { dateTime: start.toISOString(), timeZone: tz };
        }

        if (endDateTime) {
          const end = new Date(endDateTime);
          if (isNaN(end.getTime())) {
            return JSON.stringify({
              _meta: { tool: 'calendar_update', eventId: realEventId },
              success: false,
              error: 'Invalid endDateTime — must be a valid ISO 8601 date string.',
            });
          }
          patchBody.end = { dateTime: end.toISOString(), timeZone: tz };
        }

        if (attendees) {
          patchBody.attendees = attendees.map((email) => ({ email }));
        }

        if (addVideoConference) {
          patchBody.conferenceData = {
            createRequest: {
              requestId: `agent-${Date.now()}`,
              conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
          };
        }

        if (Object.keys(patchBody).length === 0) {
          return JSON.stringify({
            _meta: { tool: 'calendar_update', eventId: realEventId },
            success: false,
            error: 'No fields to update — provide at least one field to change.',
          });
        }

        const hasAttendeeChanges = !!attendees;
        const res = await calendar.events.patch({
          calendarId: 'primary',
          eventId: realEventId,
          requestBody: patchBody,
          sendUpdates: hasAttendeeChanges ? 'all' : 'none',
          ...(addVideoConference ? { conferenceDataVersion: 1 } : {}),
        });

        const event = res.data;
        log.info({ eventId: event.id }, 'Event updated');

        return JSON.stringify({
          _meta: { tool: 'calendar_update', eventId: realEventId },
          success: true,
          eventId: event.id,
          summary: event.summary,
          start: event.start?.dateTime || event.start?.date,
          end: event.end?.dateTime || event.end?.date,
          attendees: (event.attendees || []).map((a) => ({ email: a.email, status: a.responseStatus })),
          meetingLink: event.hangoutLink || event.conferenceData?.entryPoints?.[0]?.uri || null,
          htmlLink: event.htmlLink,
        });
      } catch (err: any) {
        log.error({ err }, 'Error updating calendar event');

        if (err.code === 403) {
          return JSON.stringify({
            _meta: { tool: 'calendar_update', eventId: realEventId },
            success: false,
            error: 'Calendar write access not authorized. The user needs to reconnect Google Calendar to grant write permissions.',
          });
        }

        if (err.code === 404 || err.message?.includes('Not Found')) {
          return JSON.stringify({
            _meta: { tool: 'calendar_update', eventId: realEventId },
            success: false,
            error: 'Event not found — it may have been deleted.',
          });
        }

        return JSON.stringify({
          _meta: { tool: 'calendar_update', eventId: realEventId },
          success: false,
          error: err.message,
        });
      }
    },
  });
}
