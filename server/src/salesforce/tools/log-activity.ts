/**
 * Salesforce Log Activity Tool — log calls, emails, and meetings as completed tasks.
 * Accepts record names and resolves IDs from Salesforce.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSalesforceConnection } from '../client.js';
import { resolveRecordId, sanitizeSoql, resolveSalesforceUserId, buildAttributionTag, isOwnerIdError } from '../utils.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'sfdc_log_activity' });

export function createSfdcLogActivityTool(organizationId: string, actorEmail?: string | null) {
  return new DynamicStructuredTool({
    name: 'sfdc_log_activity',
    description:
      'Log a completed activity (call, email, meeting) in Salesforce. Creates a completed Task record linked to the relevant Account, Opportunity, or Contact. Use when the user wants to record that a call was made, an email was sent, or a meeting took place.',
    schema: z.object({
      activityType: z.enum(['Call', 'Email', 'Meeting', 'Other']).describe('Type of activity to log'),
      subject: z.string().describe('Activity subject (e.g. "Discovery call with VP of Engineering", "Sent proposal follow-up")'),
      whatName: z.string().optional().describe('Related Account or Opportunity name (preferred — the tool resolves the ID)'),
      whatId: z.string().optional().describe('Related record ID — Account or Opportunity ID (if known from a previous tool call in this turn)'),
      whoName: z.string().optional().describe('Related Contact or Lead name (preferred — the tool resolves the ID)'),
      whoId: z.string().optional().describe('Related person ID — Contact or Lead ID (if known from a previous tool call in this turn)'),
      description: z.string().optional().describe('Detailed notes about the activity — what was discussed, outcomes, next steps'),
      activityDate: z.string().optional().describe('Date the activity occurred (YYYY-MM-DD format, defaults to today)'),
    }),
    func: async ({ activityType, subject, whatName, whatId, whoName, whoId, description, activityDate }) => {
      log.info({ activityType, subject, whatName, whatId, whoName, whoId }, 'Logging activity');

      try {
        const conn = await getSalesforceConnection(organizationId);

        const resolvedWhatId = await resolveRecordId(conn, 'what', whatId, whatName);
        if (resolvedWhatId?.error) {
          return JSON.stringify({ _meta: { tool: 'sfdc_log_activity' }, error: resolvedWhatId.error });
        }

        const resolvedWhoId = await resolveRecordId(conn, 'who', whoId, whoName);
        if (resolvedWhoId?.error) {
          return JSON.stringify({ _meta: { tool: 'sfdc_log_activity' }, error: resolvedWhoId.error });
        }

        const ownerId = await resolveSalesforceUserId(conn, organizationId, actorEmail);

        const taskData: Record<string, any> = {
          Subject: subject,
          Status: 'Completed',
          Priority: 'Normal',
          TaskSubtype: activityType === 'Call' ? 'Call' : activityType === 'Email' ? 'Email' : 'Task',
          ActivityDate: activityDate || new Date().toISOString().split('T')[0],
        };

        if (ownerId) taskData.OwnerId = ownerId;
        if (resolvedWhatId?.id) taskData.WhatId = resolvedWhatId.id;
        if (resolvedWhoId?.id) taskData.WhoId = resolvedWhoId.id;
        if (description) taskData.Description = description;
        const tag = buildAttributionTag(actorEmail);
        if (tag) taskData.Description = (taskData.Description || '') + tag;

        if (activityType === 'Call') {
          taskData.CallType = 'Outbound';
        }

        let createResult = await conn.sobject('Task').create(taskData);

        // If OwnerId was rejected (permission issue), retry without attribution
        if (!createResult.success && ownerId && isOwnerIdError((createResult as any).errors)) {
          log.warn('OwnerId rejected, retrying without attribution');
          delete taskData.OwnerId;
          createResult = await conn.sobject('Task').create(taskData);
        }

        if (!createResult.success) {
          const errors = (createResult as any).errors?.map((e: any) =>
            typeof e === 'string' ? e : e.message || JSON.stringify(e)
          ).join(', ') || 'Unknown error';
          log.error({ errors }, 'Create failed');
          return JSON.stringify({
            _meta: { tool: 'sfdc_log_activity' },
            error: `Failed to log activity: ${errors}`,
          });
        }

        const verifyResult = await conn.query(`
          SELECT Id, Subject, Status, TaskSubtype, ActivityDate,
                 WhatId, What.Name, WhoId, Who.Name,
                 OwnerId, Owner.Name
          FROM Task
          WHERE Id = '${sanitizeSoql(createResult.id)}'
          LIMIT 1
        `);

        const verified = verifyResult.records?.[0] as Record<string, any> | undefined;

        if (!verified) {
          log.error({ activityId: createResult.id }, 'Created activity but could not verify');
          return JSON.stringify({
            _meta: { tool: 'sfdc_log_activity' },
            error: `Activity logging was reported as successful (ID: ${createResult.id}) but could not be verified. Check Salesforce directly.`,
          });
        }

        log.info({ activityId: createResult.id }, 'Verified activity');
        return JSON.stringify({
          _meta: { tool: 'sfdc_log_activity' },
          message: `Successfully logged ${activityType.toLowerCase()}: "${verified.Subject}".`,
          taskId: createResult.id,
          result: verified,
        });
      } catch (err: any) {
        log.error({ err }, 'Error logging activity');
        return JSON.stringify({
          _meta: { tool: 'sfdc_log_activity' },
          error: err.message,
        });
      }
    },
  });
}
