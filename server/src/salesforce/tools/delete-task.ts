/**
 * Salesforce Delete Task Tool — permanently remove a task record.
 * Resolves by subject or ID, captures a snapshot, then deletes.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSalesforceConnection } from '../client.js';
import { sanitizeSoql } from '../utils.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'sfdc_delete_task' });

const TASK_QUERY_FIELDS = `
  Id, Subject, Status, Priority, ActivityDate,
  WhatId, What.Name, WhoId, Who.Name,
  OwnerId, Owner.Name, CreatedDate
`.trim();

async function resolveTaskRecord(
  conn: any,
  taskId?: string,
  taskSubject?: string,
): Promise<{ id: string; record: Record<string, any> } | { error: string }> {
  if (taskId) {
    const safeId = sanitizeSoql(taskId);
    const result = await conn.query(
      `SELECT ${TASK_QUERY_FIELDS} FROM Task WHERE Id = '${safeId}' LIMIT 1`
    );
    const record = result.records?.[0] as Record<string, any> | undefined;
    if (record) return { id: record.Id, record };
    log.warn({ taskId }, 'ID not found, falling back to subject search');
  }

  if (!taskSubject) {
    return { error: `Task ID "${taskId}" was not found in Salesforce and no task subject was provided to search by.` };
  }

  const safeSubject = sanitizeSoql(taskSubject);
  const result = await conn.query(
    `SELECT ${TASK_QUERY_FIELDS} FROM Task WHERE Subject LIKE '%${safeSubject}%' ORDER BY LastModifiedDate DESC LIMIT 5`
  );

  const records = result.records as Record<string, any>[] | undefined;
  if (!records || records.length === 0) {
    return { error: `No tasks found matching "${taskSubject}".` };
  }

  if (records.length > 1) {
    const options = records.map((r) =>
      `• ${r.Subject} (ID: ${r.Id}) — ${r.Status}, Due: ${r.ActivityDate || 'No date'}${r.What?.Name ? `, Related: ${r.What.Name}` : ''}`
    ).join('\n');
    return { error: `Multiple tasks match "${taskSubject}". Ask the user which one:\n${options}` };
  }

  return { id: records[0].Id, record: records[0] };
}

export function createSfdcDeleteTaskTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'sfdc_delete_task',
    description:
      'Permanently delete a Task from Salesforce. This action cannot be undone. Provide the task subject (preferred) or ID. Use only when the user explicitly asks to delete a task.',
    schema: z.object({
      taskSubject: z.string().optional().describe('Task subject to search for (preferred — the tool resolves the correct ID from Salesforce)'),
      taskId: z.string().optional().describe('Salesforce Task ID (if known from a previous tool call in this turn)'),
    }),
    func: async ({ taskSubject, taskId }) => {
      log.info({ taskSubject, taskId }, 'Deleting task');

      if (!taskId && !taskSubject) {
        return JSON.stringify({
          _meta: { tool: 'sfdc_delete_task' },
          error: 'Provide at least taskSubject or taskId to identify which task to delete.',
        });
      }

      try {
        const conn = await getSalesforceConnection(organizationId);

        const resolved = await resolveTaskRecord(conn, taskId, taskSubject);
        if ('error' in resolved) {
          return JSON.stringify({
            _meta: { tool: 'sfdc_delete_task', taskId, taskSubject },
            error: resolved.error,
          });
        }

        const { id: resolvedId, record: snapshot } = resolved;
        log.info({ taskId: resolvedId, taskSubject: snapshot.Subject }, 'Resolved task');

        const deleteResult = await conn.sobject('Task').destroy(resolvedId);

        if (!deleteResult.success) {
          const errors = (deleteResult as any).errors?.map((e: any) =>
            typeof e === 'string' ? e : e.message || JSON.stringify(e)
          ).join(', ') || 'Unknown error';
          log.error({ errors }, 'Delete failed');
          return JSON.stringify({
            _meta: { tool: 'sfdc_delete_task', taskId: resolvedId },
            error: `Failed to delete task "${snapshot.Subject}": ${errors}`,
          });
        }

        // Verify deletion
        const verifyResult = await conn.query(
          `SELECT Id FROM Task WHERE Id = '${sanitizeSoql(resolvedId)}' LIMIT 1`
        );

        if (verifyResult.records?.length > 0) {
          log.error({ taskId: resolvedId }, 'Record still exists after deletion');
          return JSON.stringify({
            _meta: { tool: 'sfdc_delete_task', taskId: resolvedId },
            error: `Deletion was reported as successful but the task still exists. It may be in the Salesforce recycle bin or protected by a deletion rule.`,
          });
        }

        log.info({ taskId: resolvedId }, 'Verified deletion');
        return JSON.stringify({
          _meta: { tool: 'sfdc_delete_task', taskId: resolvedId },
          message: `Successfully deleted task "${snapshot.Subject}".`,
          deletedRecord: snapshot,
        });
      } catch (err: any) {
        log.error({ err }, 'Error deleting task');
        return JSON.stringify({
          _meta: { tool: 'sfdc_delete_task', taskId, taskSubject },
          error: err.message,
        });
      }
    },
  });
}
