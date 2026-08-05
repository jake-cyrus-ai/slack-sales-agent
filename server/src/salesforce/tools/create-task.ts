/**
 * Salesforce Create Task Tool — create follow-up tasks linked to records.
 * Accepts record names and resolves IDs from Salesforce.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSalesforceConnection } from '../client.js';
import { resolveRecordId, sanitizeSoql, resolveSalesforceUserId, buildAttributionTag, isOwnerIdError } from '../utils.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'sfdc_create_task' });

export function createSfdcCreateTaskTool(organizationId: string, actorEmail?: string | null) {
  return new DynamicStructuredTool({
    name: 'sfdc_create_task',
    description:
      'Create a new task in Salesforce. Tasks can be linked to Accounts, Opportunities, or Contacts. Use when the user wants to create a follow-up, schedule a to-do, or assign an action item related to a deal.',
    schema: z.object({
      subject: z.string().describe('Task subject/title (e.g. "Follow up on proposal", "Send pricing deck")'),
      whatName: z.string().optional().describe('Related Account or Opportunity name (preferred — the tool resolves the ID)'),
      whatId: z.string().optional().describe('Related record ID — Account or Opportunity ID (if known from a previous tool call in this turn)'),
      whoName: z.string().optional().describe('Related Contact or Lead name (preferred — the tool resolves the ID)'),
      whoId: z.string().optional().describe('Related person ID — Contact or Lead ID (if known from a previous tool call in this turn)'),
      dueDate: z.string().optional().describe('Due date in YYYY-MM-DD format'),
      priority: z.enum(['High', 'Normal', 'Low']).optional().describe('Task priority (default: Normal)'),
      status: z.enum(['Not Started', 'In Progress', 'Completed', 'Waiting on someone else', 'Deferred']).optional()
        .describe('Task status (default: Not Started)'),
      description: z.string().optional().describe('Detailed description of the task'),
    }),
    func: async ({ subject, whatName, whatId, whoName, whoId, dueDate, priority = 'Normal', status = 'Not Started', description }) => {
      log.info({ subject, whatName, whatId, whoName, whoId, dueDate }, 'Creating task');

      try {
        const conn = await getSalesforceConnection(organizationId);

        const resolvedWhatId = await resolveRecordId(conn, 'what', whatId, whatName);
        if (resolvedWhatId?.error) {
          return JSON.stringify({ _meta: { tool: 'sfdc_create_task' }, error: resolvedWhatId.error });
        }

        const resolvedWhoId = await resolveRecordId(conn, 'who', whoId, whoName);
        if (resolvedWhoId?.error) {
          return JSON.stringify({ _meta: { tool: 'sfdc_create_task' }, error: resolvedWhoId.error });
        }

        const ownerId = await resolveSalesforceUserId(conn, organizationId, actorEmail);

        const taskData: Record<string, any> = {
          Subject: subject,
          Priority: priority,
          Status: status,
        };

        if (ownerId) taskData.OwnerId = ownerId;
        if (resolvedWhatId?.id) taskData.WhatId = resolvedWhatId.id;
        if (resolvedWhoId?.id) taskData.WhoId = resolvedWhoId.id;
        if (dueDate) taskData.ActivityDate = dueDate;
        if (description) taskData.Description = description;
        const tag = buildAttributionTag(actorEmail);
        if (tag) taskData.Description = (taskData.Description || '') + tag;

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
            _meta: { tool: 'sfdc_create_task' },
            error: `Failed to create task: ${errors}`,
          });
        }

        const verifyResult = await conn.query(`
          SELECT Id, Subject, Status, Priority, ActivityDate,
                 WhatId, What.Name, WhoId, Who.Name,
                 OwnerId, Owner.Name
          FROM Task
          WHERE Id = '${sanitizeSoql(createResult.id)}'
          LIMIT 1
        `);

        const verified = verifyResult.records?.[0] as Record<string, any> | undefined;

        if (!verified) {
          log.error({ taskId: createResult.id }, 'Created task but could not verify');
          return JSON.stringify({
            _meta: { tool: 'sfdc_create_task' },
            error: `Task creation was reported as successful (ID: ${createResult.id}) but could not be verified. Check Salesforce directly.`,
          });
        }

        log.info({ taskId: createResult.id }, 'Verified task');
        return JSON.stringify({
          _meta: { tool: 'sfdc_create_task' },
          message: `Successfully created task "${verified.Subject}".`,
          taskId: createResult.id,
          result: verified,
        });
      } catch (err: any) {
        log.error({ err }, 'Error creating task');
        return JSON.stringify({
          _meta: { tool: 'sfdc_create_task' },
          error: err.message,
        });
      }
    },
  });
}
