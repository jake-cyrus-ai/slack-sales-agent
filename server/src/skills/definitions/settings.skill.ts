/**
 * Settings skill — manage guardrails, view activity summary.
 *
 * Provides conversational access to:
 * - Guardrails configuration (admin-only for updates)
 * - Activity summary ("What did you do today?")
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { supabase } from '../../lib/supabase.js';
import { basePrompt } from '../../agent/system-prompt.js';
import type { SkillDefinition } from '../types.js';
import type {
  ActivitySummary,
  AutoSentEmail,
  NudgedDeal,
  MeetingFollowup,
} from '../../../inngest/utils/activity-summary.js';

function createSettingsTools(userId: string, organizationId: string | null) {

  const getGuardrails = new DynamicStructuredTool({
    name: 'get_guardrails',
    description: 'Get the current guardrails configuration for autonomous actions.',
    schema: z.object({}),
    func: async () => {
      if (!organizationId) {
        return JSON.stringify({ success: false, error: 'No organization context' });
      }

      const { data: org } = await supabase
        .from('organizations')
        .select('feature_flags')
        .eq('id', organizationId)
        .single();

      const flags = (org?.feature_flags as Record<string, unknown>) || {};
      const guardrails = (flags.guardrails as Record<string, unknown>) || {};
      const autonomousMode = (flags.autonomous_mode as Record<string, unknown>) || {};

      return JSON.stringify({
        success: true,
        autonomousModeEnabled: autonomousMode.enabled === true,
        guardrails: {
          maxEmailsPerDay: guardrails.max_emails_per_day ?? 'unlimited',
          maxActionsPerDay: guardrails.max_actions_per_day ?? 'unlimited',
          coolDownHours: guardrails.cool_down_hours ?? 'none',
          dealValueApprovalThreshold: guardrails.deal_value_approval_threshold ?? 'none',
        },
      });
    },
  });

  const updateGuardrails = new DynamicStructuredTool({
    name: 'update_guardrails',
    description:
      'Update a guardrail setting. Only organization admins and owners can do this. Set to null to remove the limit.',
    schema: z.object({
      setting: z
        .enum(['max_emails_per_day', 'max_actions_per_day', 'cool_down_hours', 'deal_value_approval_threshold'])
        .describe('The guardrail setting to update'),
      value: z
        .union([z.number(), z.null()])
        .describe('The new value, or null to remove the limit'),
    }),
    func: async ({ setting, value }) => {
      if (!organizationId) {
        return JSON.stringify({ success: false, error: 'No organization context' });
      }

      // Check role
      const { data: membership } = await supabase
        .from('organization_users')
        .select('role')
        .eq('user_id', userId)
        .eq('organization_id', organizationId)
        .single();

      const role = membership?.role;
      if (role !== 'owner' && role !== 'admin') {
        return JSON.stringify({
          success: false,
          error: 'Only organization admins and owners can update guardrails. Ask your admin to make this change.',
        });
      }

      const { data: org } = await supabase
        .from('organizations')
        .select('feature_flags')
        .eq('id', organizationId)
        .single();

      const flags = (org?.feature_flags as Record<string, unknown>) || {};
      const guardrails = (flags.guardrails as Record<string, unknown>) || {};
      guardrails[setting] = value;

      const { error } = await supabase
        .from('organizations')
        .update({ feature_flags: { ...flags, guardrails } })
        .eq('id', organizationId);

      if (error) return JSON.stringify({ success: false, error: error.message });

      const label = setting.replace(/_/g, ' ');
      const displayValue = value === null ? 'removed (unlimited)' : value;
      return JSON.stringify({
        success: true,
        message: `Guardrail updated: ${label} set to ${displayValue}`,
      });
    },
  });

  const getActivitySummaryTool = new DynamicStructuredTool({
    name: 'get_activity_summary',
    description:
      'Get a summary of all autonomous actions Sales Agent took today (or on a specific date).',
    schema: z.object({
      date: z.string().optional().describe('Optional YYYY-MM-DD date. Defaults to today.'),
    }),
    func: async ({ date }) => {
      if (!organizationId) {
        return JSON.stringify({ success: false, error: 'No organization context' });
      }

      try {
        // Lazy import to avoid circular deps (inngest utils → src boundary)
        const { getActivitySummary } = await import('../../../inngest/utils/activity-summary.js');

        const { data: profile } = await supabase
          .from('profiles')
          .select('timezone')
          .eq('user_id', userId)
          .single();

        const tz = profile?.timezone || 'America/New_York';
        const summary: ActivitySummary = await getActivitySummary(
          organizationId, userId, tz, date || undefined,
        );

        return JSON.stringify({
          success: true,
          summary: {
            date: summary.date,
            totalActions: summary.totalActions,
            emailsAutoSent: summary.autoSentEmails.length,
            dealsNudged: summary.nudgedDeals.length,
            meetingsFollowedUp: summary.meetingFollowups.length,
            remindersFired: summary.firedReminders.length,
            emails: summary.autoSentEmails.map((e: AutoSentEmail) => ({
              subject: e.subject,
              to: e.recipientEmail,
              confidence: e.confidenceScore,
            })),
            deals: summary.nudgedDeals.map((d: NudgedDeal) => ({
              company: d.companyName,
              value: d.dealValue,
            })),
            meetings: summary.meetingFollowups.map((m: MeetingFollowup) => ({
              title: m.meetingTitle,
            })),
            guardrails: summary.guardrailsUsage,
          },
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ success: false, error: msg });
      }
    },
  });

  return [getGuardrails, updateGuardrails, getActivitySummaryTool];
}

export const settingsSkill: SkillDefinition = {
  manifest: {
    name: 'settings',
    description: 'Manage guardrails and view autonomous action history',
    classificationHint:
      '"settings": Questions about guardrails, autonomous action limits, activity history, or what Sales Agent did today. This agent has tools to view/update guardrail settings and retrieve activity summaries. Examples: "What are my guardrails?", "Set max emails to 5 per day", "What did you do today?", "Show today\'s activity", "How many emails did you send?", "Change cool-down to 48 hours", "Remove deal value threshold", "What actions did you take?", "Show my activity". IMPORTANT: "What did you do today?" and activity-related questions route here — NOT to conversational.',
    triggers: [
      {
        type: 'intent',
        patterns: [],
      },
    ],
    workflowKind: 'settings_management',
    promptSections: ['dates'],
  },

  tools: (ctx) => createSettingsTools(ctx.userId, ctx.organizationId),

  promptFragment: (ctx) => {
    return `${basePrompt(ctx.user, ctx.promptCtx, ctx.userPreferences, ['tools', 'dates'])}

You help users view and manage their autonomous action settings and activity history.

Guardrails:
- Use get_guardrails to show current settings
- Use update_guardrails to change settings (admin-only — if the user isn't an admin, explain who can make the change)
- Available settings: max_emails_per_day, max_actions_per_day, cool_down_hours, deal_value_approval_threshold
- Set to null to remove a limit

Activity:
- Use get_activity_summary to show what Sales Agent did today (or any date)
- Present the data in a clean, scannable format
- Highlight key numbers and notable actions`;
  },
};
