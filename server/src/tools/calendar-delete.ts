/**
 * Calendar Delete Tool — proposes event deletion via Slack confirmation buttons.
 *
 * This tool NEVER deletes events directly. It:
 * 1. Resolves the event (handles hallucinated IDs via search)
 * 2. Fetches event details
 * 3. Inserts a pending_actions record
 * 4. Posts a Slack message with Approve/Cancel buttons
 * 5. Returns to the LLM saying deletion is pending user approval
 *
 * Actual deletion happens in calendar-actions.ts when the user clicks Approve.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getCalendarClient } from '../services/google-client.js';
import { resolveEventId } from './calendar-resolve.js';
import { supabase } from '../lib/supabase.js';
import { sendSlackBlockMessage } from '../../workflows/utils/slack-helpers.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'calendar_delete' });

export function createCalendarDeleteTool(
  userId: string,
  slackContext?: { channelId: string; threadTs: string; botToken?: string } | null,
) {
  return new DynamicStructuredTool({
    name: 'calendar_delete',
    description:
      'Delete an event from the user\'s Google Calendar. ONLY use when the user explicitly asks to delete, cancel, or remove a calendar event. ' +
      'This tool sends the user a confirmation button in Slack — the event is NOT deleted until they click Approve. ' +
      'You can pass either a real event ID (from calendar_search) or the event name/summary and it will be resolved automatically.',
    schema: z.object({
      eventId: z.string().describe('The Google Calendar event ID, or the event name/summary to search for'),
    }),
    func: async ({ eventId }) => {
      log.info({ eventId }, 'Deleting calendar event');

      // Resolve the event ID (handles hallucinated IDs by searching)
      const resolution = await resolveEventId(userId, eventId);
      if (!resolution.resolved) {
        const resolveError: string = (resolution as any).error;
        return JSON.stringify({
          _meta: { tool: 'calendar_delete', eventId },
          success: false,
          error: resolveError,
        });
      }
      const realEventId = resolution.event.eventId;

      const calendar = await getCalendarClient(userId);
      if (!calendar) {
        return JSON.stringify({
          _meta: { tool: 'calendar_delete', eventId: realEventId },
          success: false,
          error: 'Google Calendar not connected.',
        });
      }

      // Fetch event details
      let event: any;
      try {
        const res = await calendar.events.get({
          calendarId: 'primary',
          eventId: realEventId,
        });
        event = res.data;
      } catch (err: any) {
        if (err.code === 403) {
          return JSON.stringify({
            _meta: { tool: 'calendar_delete', eventId: realEventId },
            success: false,
            error: 'Calendar write access not authorized. The user needs to reconnect Google Calendar to grant write permissions.',
          });
        }
        if (err.code === 404) {
          return JSON.stringify({
            _meta: { tool: 'calendar_delete', eventId: realEventId },
            success: false,
            error: 'Event not found — it may have already been deleted.',
          });
        }
        return JSON.stringify({
          _meta: { tool: 'calendar_delete', eventId: realEventId },
          success: false,
          error: err.message,
        });
      }

      // Insert pending action record
      const { data: pendingAction, error: insertError } = await supabase
        .from('pending_actions')
        .insert({
          user_id: userId,
          action_type: 'calendar_delete',
          payload: {
            eventId: realEventId,
            summary: event.summary,
            start: event.start?.dateTime || event.start?.date,
            end: event.end?.dateTime || event.end?.date,
            attendees: (event.attendees || []).map((a: any) => a.email),
            organizer: event.organizer?.email,
          },
          rationale: `User requested deletion of "${event.summary}"`,
          status: 'pending',
          slack_channel_id: slackContext?.channelId,
        })
        .select('id')
        .single();

      if (insertError || !pendingAction) {
        log.error({ err: insertError }, 'Failed to create pending action');
        return JSON.stringify({
          _meta: { tool: 'calendar_delete', eventId: realEventId },
          success: false,
          error: 'Failed to create confirmation request.',
        });
      }

      // Post Slack confirmation buttons (skip when no bot token — web/widget channel)
      if (slackContext && slackContext.botToken) {
        const startStr = event.start?.dateTime || event.start?.date || 'unknown';
        const attendeeList = (event.attendees || [])
          .map((a: any) => a.email)
          .filter((e: string) => e)
          .join(', ');

        const blocks = [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Delete this event?*\n\n*Event:* ${event.summary}\n*When:* ${startStr}${attendeeList ? `\n*Attendees:* ${attendeeList}` : ''}`,
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Delete Event' },
                style: 'danger',
                value: pendingAction.id,
                action_id: 'calendar_delete_confirm',
              },
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Cancel' },
                value: pendingAction.id,
                action_id: 'calendar_delete_cancel',
              },
            ],
          },
        ];

        await sendSlackBlockMessage(
          slackContext.botToken,
          slackContext.channelId,
          `Delete event: ${event.summary}?`,
          blocks,
          slackContext.threadTs,
        );
      }

      log.info({ pendingActionId: pendingAction.id, summary: event.summary }, 'Pending confirmation created');

      return JSON.stringify({
        _meta: { tool: 'calendar_delete', eventId: realEventId },
        success: true,
        pendingConfirmation: true,
        pendingActionId: pendingAction.id,
        message: `A confirmation button has been sent to the user. The event "${event.summary}" will only be deleted after they click "Delete Event".`,
        event: {
          id: realEventId,
          summary: event.summary,
          start: event.start?.dateTime || event.start?.date,
          end: event.end?.dateTime || event.end?.date,
        },
      });
    },
  });
}
