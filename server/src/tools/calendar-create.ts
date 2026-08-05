/**
 * Calendar Create Tool — create calendar events via Google Calendar API.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getCalendarClient } from '../services/google-client.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'calendar_create' });

export function createCalendarCreateTool(userId: string, userTimezone?: string) {
  return new DynamicStructuredTool({
    name: 'calendar_create',
    description:
      'Create a new event on the user\'s Google Calendar. Use when the user asks to schedule a meeting, block time, create a calendar event, or add something to their calendar. Requires a summary (title) and start time at minimum.',
    schema: z.object({
      summary: z.string().describe('Event title (e.g. "Call with Jane at Ramp")'),
      startDateTime: z.string().describe('Start time in ISO 8601 format (e.g. "2025-03-15T14:00:00-07:00")'),
      endDateTime: z.string().optional().describe('End time in ISO 8601 format. Defaults to 30 minutes after start if not provided.'),
      description: z.string().optional().describe('Event description or notes'),
      attendees: z.array(z.string()).optional().describe('List of attendee email addresses (e.g. ["jane@ramp.com", "bob@acme.com"])'),
      location: z.string().optional().describe('Event location or meeting link'),
      addVideoConference: z.boolean().optional().default(false).describe('When true, adds a Google Meet link to the event'),
    }),
    func: async ({ summary, startDateTime, endDateTime, description, attendees, location, addVideoConference }) => {
      log.info({ summary, startDateTime, attendeeCount: attendees?.length || 0 }, 'Creating calendar event');

      const calendar = await getCalendarClient(userId);
      if (!calendar) {
        return JSON.stringify({
          _meta: { tool: 'calendar_create', summary },
          success: false,
          error: 'Google Calendar not connected.',
        });
      }

      try {
        // Default to 30 min meeting if no end time
        const start = new Date(startDateTime);
        if (isNaN(start.getTime())) {
          return JSON.stringify({
            _meta: { tool: 'calendar_create', summary },
            success: false,
            error: 'Invalid startDateTime — must be a valid ISO 8601 date string.',
          });
        }
        const end = endDateTime
          ? new Date(endDateTime)
          : new Date(start.getTime() + 30 * 60 * 1000);
        if (isNaN(end.getTime())) {
          return JSON.stringify({
            _meta: { tool: 'calendar_create', summary },
            success: false,
            error: 'Invalid endDateTime — must be a valid ISO 8601 date string.',
          });
        }

        const tz = userTimezone || 'UTC';
        const eventBody: any = {
          summary,
          start: { dateTime: start.toISOString(), timeZone: tz },
          end: { dateTime: end.toISOString(), timeZone: tz },
        };

        if (description) eventBody.description = description;
        if (location) eventBody.location = location;

        if (attendees && attendees.length > 0) {
          eventBody.attendees = attendees.map((email) => ({ email }));
        }

        if (addVideoConference) {
          eventBody.conferenceData = {
            createRequest: {
              requestId: `agent-${Date.now()}`,
              conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
          };
        }

        const res = await calendar.events.insert({
          calendarId: 'primary',
          requestBody: eventBody,
          sendUpdates: attendees && attendees.length > 0 ? 'all' : 'none',
          ...(addVideoConference ? { conferenceDataVersion: 1 } : {}),
        });

        const event = res.data;
        log.info({ eventId: event.id }, 'Event created');

        return JSON.stringify({
          _meta: { tool: 'calendar_create', summary },
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
        log.error({ err }, 'Error creating calendar event');

        if (err.code === 403) {
          return JSON.stringify({
            _meta: { tool: 'calendar_create', summary },
            success: false,
            error: 'Calendar write access not authorized. The user needs to reconnect Google Calendar to grant write permissions.',
          });
        }

        return JSON.stringify({
          _meta: { tool: 'calendar_create', summary },
          success: false,
          error: err.message,
        });
      }
    },
  });
}
