/**
 * Reminder skill — set, list, and cancel reminders via natural language.
 *
 * All date/time computation is server-side:
 * - Relative times: server adds minutes to Date.now()
 * - Absolute times: server converts local date+hour+minute → UTC using user timezone
 * - Display: server formats UTC → local with isToday/isTomorrow flags
 *
 * The LLM never builds ISO strings or does date math.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { supabase } from '../../lib/supabase.js';
import { basePrompt } from '../../agent/system-prompt.js';
import { localDateTimeToUTC, toLocalDisplay } from '../../../inngest/utils/timezone-helpers.js';
import type { SkillDefinition } from '../types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

async function getUserTimezone(userId: string): Promise<string> {
  const { data } = await supabase
    .from('profiles')
    .select('timezone')
    .eq('user_id', userId)
    .single();
  return data?.timezone || 'America/New_York';
}

// ── Tools ──────────────────────────────────────────────────────────────────

function createReminderTools(userId: string, organizationId: string | null) {

  const createReminder = new DynamicStructuredTool({
    name: 'create_reminder',
    description:
      'Create a reminder. Use minutesFromNow for relative times ("in 5 min", "in 2 hours"). Use date + hour + minute for absolute times ("tomorrow at 3pm", "Friday at 10am"). The server computes the exact timestamp — you never need to build ISO strings.',
    schema: z.object({
      text: z.string().describe('What to remind the user about'),
      minutesFromNow: z.number().optional().describe(
        'For RELATIVE times only. Minutes from now: "in 1 minute"=1, "in 30 minutes"=30, "in 2 hours"=120, "in 1 day"=1440',
      ),
      date: z.string().optional().describe(
        'For ABSOLUTE times only. YYYY-MM-DD format. Use the current date from context to compute.',
      ),
      hour: z.number().optional().describe(
        'For ABSOLUTE times only. Hour in 24h format: 0-23 (e.g., 15 for 3pm, 9 for 9am)',
      ),
      minute: z.number().optional().describe(
        'For ABSOLUTE times only. Minute: 0-59. Defaults to 0 if omitted.',
      ),
    }),
    func: async ({ text, minutesFromNow, date, hour, minute }) => {
      try {
        const tz = await getUserTimezone(userId);
        let triggerDate: Date;

        if (minutesFromNow !== undefined && minutesFromNow !== null) {
          if (minutesFromNow <= 0) {
            return JSON.stringify({ success: false, error: 'minutesFromNow must be positive.' });
          }
          triggerDate = new Date(Date.now() + minutesFromNow * 60 * 1000);
        } else if (date && hour !== undefined && hour !== null) {
          triggerDate = localDateTimeToUTC(date, hour, minute ?? 0, tz);
        } else {
          return JSON.stringify({
            success: false,
            error: 'Provide either minutesFromNow (for relative) or date + hour (for absolute).',
          });
        }

        if (triggerDate.getTime() < Date.now() - 60_000) {
          return JSON.stringify({ success: false, error: 'Cannot set a reminder in the past.' });
        }

        const { data: row, error } = await supabase
          .from('reminders')
          .insert({
            user_id: userId,
            organization_id: organizationId || '',
            reminder_text: text,
            trigger_at: triggerDate.toISOString(),
            status: 'pending',
            source: 'chat',
          })
          .select('id, trigger_at')
          .single();

        if (error) return JSON.stringify({ success: false, error: error.message });

        const when = toLocalDisplay(new Date(row.trigger_at), tz);
        return JSON.stringify({
          success: true,
          reminderId: row.id,
          when,
          message: `Reminder set for ${when}`,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ success: false, error: msg });
      }
    },
  });

  const listReminders = new DynamicStructuredTool({
    name: 'list_reminders',
    description:
      'List the user\'s active reminders. All dates and times are pre-computed in the user\'s local timezone with isToday/isTomorrow flags.',
    schema: z.object({}),
    func: async () => {
      try {
        const { data, error } = await supabase
          .from('reminders')
          .select('id, reminder_text, trigger_at, status, source, source_ref')
          .eq('user_id', userId)
          .in('status', ['pending', 'snoozed'])
          .order('trigger_at', { ascending: true })
          .limit(20);

        if (error) return JSON.stringify({ success: false, error: error.message });
        if (!data?.length) {
          return JSON.stringify({ success: true, reminders: [], message: 'No active reminders.' });
        }

        const tz = await getUserTimezone(userId);

        const reminders = data.map((r) => ({
          id: r.id,
          text: r.reminder_text,
          when: toLocalDisplay(new Date(r.trigger_at), tz),
          status: r.status,
          source: r.source,
          sourceRef: r.source_ref,
        }));

        return JSON.stringify({ success: true, reminders });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ success: false, error: msg });
      }
    },
  });

  const cancelReminder = new DynamicStructuredTool({
    name: 'cancel_reminder',
    description: 'Cancel a specific reminder by its ID. Use list_reminders first to find the ID.',
    schema: z.object({
      reminderId: z.string().describe('The UUID of the reminder to cancel'),
    }),
    func: async ({ reminderId }) => {
      const { error } = await supabase
        .from('reminders')
        .update({ status: 'cancelled' })
        .eq('id', reminderId)
        .eq('user_id', userId);

      if (error) return JSON.stringify({ success: false, error: error.message });
      return JSON.stringify({ success: true, message: 'Reminder cancelled.' });
    },
  });

  return [createReminder, listReminders, cancelReminder];
}

// ── Skill definition ───────────────────────────────────────────────────────

export const reminderSkill: SkillDefinition = {
  manifest: {
    name: 'reminder',
    description: 'Set, list, and cancel reminders',
    classificationHint:
      '"reminder": ANY request involving reminders — setting, listing, viewing, cancelling, or managing them. Also time-deferred follow-ups with a specific time. This agent has the tools to create, list, and cancel reminders in the database. Examples: "Remind me to follow up with Acme in 2 hours", "Show my reminders", "What reminders do I have?", "Cancel my reminder about Sarah", "Check back on this deal Friday", "Set a reminder for tomorrow at 3pm", "Do I have any reminders?", "List my reminders", "Delete that reminder". IMPORTANT: If the user mentions "reminder" or "reminders" in any form, route here — NOT to conversational.',
    triggers: [
      {
        type: 'intent',
        patterns: [],
      },
    ],
    compositionRules: [
      { when: /remind.*meeting/i, add: ['calendar'] },
      { when: /remind.*follow.?up.*(?:deal|contact|email)/i, add: ['sales'] },
    ],
    workflowKind: 'reminder_management',
    promptSections: ['dates'],
  },

  tools: (ctx) => createReminderTools(ctx.userId, ctx.organizationId),

  promptFragment: (ctx) => {
    return `${basePrompt(ctx.user, ctx.promptCtx, ctx.userPreferences, ['tools', 'dates'])}

You help users set, view, and manage reminders.

TIME RESOLUTION — the server handles all date math, you just fill in simple fields:

RELATIVE times → use minutesFromNow (the server adds minutes to the current time):
  "in 1 minute"   → minutesFromNow: 1
  "in 5 minutes"  → minutesFromNow: 5
  "in 30 minutes" → minutesFromNow: 30
  "in 1 hour"     → minutesFromNow: 60
  "in 2 hours"    → minutesFromNow: 120
  "in 1 day"      → minutesFromNow: 1440

ABSOLUTE times → use date + hour + minute (the server handles timezone conversion):
  "tomorrow at 3pm"  → date: "[tomorrow's YYYY-MM-DD]", hour: 15, minute: 0
  "Friday at 10am"   → date: "[Friday's YYYY-MM-DD]", hour: 10, minute: 0
  "April 10 at noon" → date: "2026-04-10", hour: 12, minute: 0
  Use the current date from context above to compute the target YYYY-MM-DD date.

NEVER ask the user what time it is. NEVER build ISO timestamp strings yourself.

When LISTING reminders:
- Each reminder has a "when" field with the date and time in the user's local timezone (e.g. "Sunday, April 5 at 11:47 PM").
- Use the current date from context to determine if a reminder is today, tomorrow, past, etc.`;
  },
};
