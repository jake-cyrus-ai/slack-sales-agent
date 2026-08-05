/**
 * Salesforce Update Task Tool — update existing task records.
 * Supports setting fields, clearing fields (set to null), and re-linking records.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSalesforceConnection } from '../client.js';
import { sanitizeSoql, resolveRecordId, buildAttributionTag } from '../utils.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'sfdc_update_task' });

const CLEARABLE_FIELDS = [
  'dueDate', 'description', 'whatId', 'whoId',
] as const;

/** Map camelCase param names → Salesforce API field names. */
const FIELD_MAP: Record<string, string> = {
  subject: 'Subject',
  status: 'Status',
  priority: 'Priority',
  dueDate: 'ActivityDate',
  description: 'Description',
};

const TASK_QUERY_FIELDS = `
  Id, Subject, Status, Priority, ActivityDate, Description,
  WhatId, What.Name, WhoId, Who.Name,
  OwnerId, Owner.Name, IsClosed, LastModifiedDate
`.trim();

async function resolveTaskRecord(
  conn: any,
  taskId?: string,
  taskSubject?: string,
): Promise<{ id: string; record: Record<string, any> } | { error: string }> {
  if (taskId) {
    const safeId = sanitizeSoql(taskId);
    const result = await conn.query(`
      SELECT ${TASK_QUERY_FIELDS}
      FROM Task WHERE Id = '${safeId}' LIMIT 1
    `);
    const record = result.records?.[0] as Record<string, any> | undefined;
    if (record) return { id: record.Id, record };
    log.warn({ taskId }, 'ID not found, falling back to subject search');
  }

  if (!taskSubject) {
    return { error: `Task ID "${taskId}" was not found in Salesforce and no task subject was provided to search by.` };
  }

  const safeSubject = sanitizeSoql(taskSubject);
  const result = await conn.query(`
    SELECT ${TASK_QUERY_FIELDS}
    FROM Task
    WHERE Subject LIKE '%${safeSubject}%' AND IsClosed = false
    ORDER BY LastModifiedDate DESC LIMIT 5
  `);

  const records = result.records as Record<string, any>[] | undefined;
  if (!records || records.length === 0) {
    return { error: `No open tasks found matching "${taskSubject}".` };
  }

  if (records.length > 1) {
    const options = records.map((r) =>
      `• ${r.Subject} (ID: ${r.Id}) — ${r.Status}, Due: ${r.ActivityDate || 'No date'}${r.What?.Name ? `, Related: ${r.What.Name}` : ''}`
    ).join('\n');
    return { error: `Multiple tasks match "${taskSubject}". Ask the user which one:\n${options}` };
  }

  return { id: records[0].Id, record: records[0] };
}

export function createSfdcUpdateTaskTool(organizationId: string, actorEmail?: string | null) {
  return new DynamicStructuredTool({
    name: 'sfdc_update_task',
    description:
      'Update an existing Task in Salesforce. Can change subject, status, priority, due date, description, or linked records (account/opportunity/contact). Can also clear/remove fields. Provide the task subject (preferred) or ID.',
    schema: z.object({
      taskSubject: z.string().optional().describe('Task subject to search for (preferred — the tool resolves the correct ID from Salesforce)'),
      taskId: z.string().optional().describe('Salesforce Task ID (if known from a previous tool call in this turn)'),
      subject: z.string().optional().describe('New task subject/title'),
      status: z.enum(['Not Started', 'In Progress', 'Completed', 'Waiting on someone else', 'Deferred']).optional()
        .describe('New task status'),
      priority: z.enum(['High', 'Normal', 'Low']).optional().describe('New priority'),
      dueDate: z.string().optional().describe('New due date in YYYY-MM-DD format'),
      description: z.string().optional().describe('New description'),
      whatName: z.string().optional().describe('New related Account or Opportunity name (the tool resolves the ID)'),
      whatId: z.string().optional().describe('New related record ID — Account or Opportunity (if known)'),
      whoName: z.string().optional().describe('New related Contact or Lead name (the tool resolves the ID)'),
      whoId: z.string().optional().describe('New related person ID — Contact or Lead (if known)'),
      clearFields: z.array(z.enum(CLEARABLE_FIELDS)).optional()
        .describe('List of fields to clear/remove (set to blank). Use when the user wants to erase a field value.'),
    }),
    func: async (params) => {
      const {
        taskSubject, taskId, clearFields,
        subject, status, priority, dueDate, description,
        whatName, whatId, whoName, whoId,
      } = params;

      log.info({ taskSubject, taskId, clearFields }, 'Updating task');

      if (!taskId && !taskSubject) {
        return JSON.stringify({
          _meta: { tool: 'sfdc_update_task' },
          error: 'Provide at least taskSubject or taskId to identify which task to update.',
        });
      }

      try {
        const conn = await getSalesforceConnection(organizationId);

        // Build updates from provided fields
        const updates: Record<string, any> = {};
        const fieldValues: Record<string, any> = { subject, status, priority, dueDate, description };
        for (const [param, value] of Object.entries(fieldValues)) {
          if (value !== undefined && FIELD_MAP[param]) {
            updates[FIELD_MAP[param]] = value;
          }
        }

        // Resolve WhatId (Account/Opportunity) if provided and not being cleared
        if ((whatId || whatName) && !clearFields?.includes('whatId')) {
          const resolvedWhat = await resolveRecordId(conn, 'what', whatId, whatName);
          if (resolvedWhat?.error) {
            return JSON.stringify({ _meta: { tool: 'sfdc_update_task' }, error: resolvedWhat.error });
          }
          if (resolvedWhat?.id) updates.WhatId = resolvedWhat.id;
        }

        // Resolve WhoId (Contact/Lead) if provided and not being cleared
        if ((whoId || whoName) && !clearFields?.includes('whoId')) {
          const resolvedWho = await resolveRecordId(conn, 'who', whoId, whoName);
          if (resolvedWho?.error) {
            return JSON.stringify({ _meta: { tool: 'sfdc_update_task' }, error: resolvedWho.error });
          }
          if (resolvedWho?.id) updates.WhoId = resolvedWho.id;
        }

        // Handle clearFields — set to null (clearFields wins over set values)
        if (clearFields) {
          for (const field of clearFields) {
            if (field === 'whatId') updates.WhatId = null;
            else if (field === 'whoId') updates.WhoId = null;
            else {
              const apiField = FIELD_MAP[field];
              if (apiField) updates[apiField] = null;
            }
          }
        }

        if (Object.keys(updates).length === 0) {
          return JSON.stringify({
            _meta: { tool: 'sfdc_update_task', taskId, taskSubject },
            error: 'No fields to update. Provide at least one field to change or use clearFields to remove a field value.',
          });
        }

        const resolved = await resolveTaskRecord(conn, taskId, taskSubject);
        if ('error' in resolved) {
          return JSON.stringify({
            _meta: { tool: 'sfdc_update_task', taskId, taskSubject },
            error: resolved.error,
          });
        }

        const { id: resolvedId, record: beforeUpdate } = resolved;
        log.info({ taskId: resolvedId, taskSubject: beforeUpdate.Subject }, 'Resolved task');

        // Attribution tag on description (only if description is being set, not cleared)
        const tag = buildAttributionTag(actorEmail);
        if (tag && updates.Description !== undefined && updates.Description !== null) {
          updates.Description = updates.Description + tag;
        }

        const updateResult = await conn.sobject('Task').update({ Id: resolvedId, ...updates });

        if (!updateResult.success) {
          const errors = (updateResult as any).errors?.map((e: any) =>
            typeof e === 'string' ? e : e.message || JSON.stringify(e)
          ).join(', ') || 'Unknown error';
          log.error({ errors }, 'Update failed');
          return JSON.stringify({
            _meta: { tool: 'sfdc_update_task', taskId: resolvedId },
            error: `Failed to update task "${beforeUpdate.Subject}": ${errors}`,
          });
        }

        // Verify by re-querying
        const verifyResult = await conn.query(`
          SELECT ${TASK_QUERY_FIELDS}
          FROM Task WHERE Id = '${resolvedId}' LIMIT 1
        `);

        const afterUpdate = verifyResult.records?.[0] as Record<string, any> | undefined;

        if (!afterUpdate) {
          return JSON.stringify({
            _meta: { tool: 'sfdc_update_task', taskId: resolvedId },
            error: 'Update was reported as successful but the task could not be re-fetched. Verify manually in Salesforce.',
          });
        }

        // Verify changes
        const mismatches: string[] = [];
        for (const [apiField, value] of Object.entries(updates)) {
          const actual = afterUpdate[apiField];
          if (value === null) {
            if (actual != null && actual !== '') mismatches.push(`${apiField}: expected cleared, got "${actual}"`);
          } else {
            const matches = (actual == null ? '' : String(actual)) === String(value);
            if (!matches) mismatches.push(`${apiField}: expected "${value}", got "${actual}"`);
          }
        }

        if (mismatches.length > 0) {
          log.error({ mismatches }, 'Verification failed');
          return JSON.stringify({
            _meta: { tool: 'sfdc_update_task', taskId: resolvedId },
            error: `Update may not have persisted. Verification mismatches: ${mismatches.join('; ')}. Check Salesforce directly.`,
            result: afterUpdate,
          });
        }

        log.info({ taskSubject: afterUpdate.Subject }, 'Verified update');
        return JSON.stringify({
          _meta: { tool: 'sfdc_update_task', taskId: resolvedId },
          message: `Successfully updated task "${afterUpdate.Subject}".`,
          updatedFields: Object.keys(updates),
          before: Object.fromEntries(Object.keys(updates).map((f) => [f, beforeUpdate[f]])),
          result: afterUpdate,
        });
      } catch (err: any) {
        log.error({ err }, 'Error updating task');
        return JSON.stringify({
          _meta: { tool: 'sfdc_update_task', taskId, taskSubject },
          error: err.message,
        });
      }
    },
  });
}
