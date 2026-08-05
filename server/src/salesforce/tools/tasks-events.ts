/**
 * Salesforce Tasks & Events Tool — lookup activities, follow-ups, and logged calls.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSalesforceConnection } from '../client.js';
import { sanitizeSoql } from '../utils.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'sfdc_tasks_events' });

export function createSfdcTasksEventsTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'sfdc_tasks_events',
    description:
      'Search for tasks (to-dos, follow-ups, logged calls) and events (meetings, appointments) in Salesforce. Filter by related account/opportunity/contact, status, or date range. Use when looking for upcoming follow-ups, past activities, or scheduled meetings related to a deal.',
    schema: z.object({
      whatId: z.string().optional().describe('Related record ID (Account or Opportunity ID) to find tasks/events for'),
      whoId: z.string().optional().describe('Related person ID (Contact or Lead ID) to find tasks/events for'),
      accountName: z.string().optional().describe('Account name to find tasks/events for (fuzzy match on related account)'),
      status: z.string().optional().describe('Task status filter (e.g. "Not Started", "In Progress", "Completed")'),
      type: z.enum(['tasks', 'events', 'both']).optional().describe('Whether to search tasks, events, or both (default: both)'),
      includeCompleted: z.boolean().optional().describe('Include completed/closed tasks (default: false, shows only open)'),
    }),
    func: async ({ whatId, whoId, accountName, status, type = 'both', includeCompleted = false }) => {
      log.info({ whatId, whoId, accountName, status, type }, 'Searching tasks and events');

      if (!whatId && !whoId && !accountName) {
        return JSON.stringify({
          _meta: { tool: 'sfdc_tasks_events' },
          error: 'Provide at least one: whatId, whoId, or accountName.',
          results: { tasks: [], events: [] },
        });
      }

      try {
        const conn = await getSalesforceConnection(organizationId);
        const results: { tasks: any[]; events: any[] } = { tasks: [], events: [] };

        if (type === 'tasks' || type === 'both') {
          const taskConditions: string[] = [];
          if (whatId) taskConditions.push(`WhatId = '${sanitizeSoql(whatId)}'`);
          if (whoId) taskConditions.push(`WhoId = '${sanitizeSoql(whoId)}'`);
          if (accountName) taskConditions.push(`Account.Name LIKE '%${sanitizeSoql(accountName)}%'`);
          if (status) taskConditions.push(`Status = '${sanitizeSoql(status)}'`);
          if (!includeCompleted && !status) taskConditions.push(`IsClosed = false`);

          const taskResult = await conn.query(`
            SELECT Id, Subject, Status, Priority, ActivityDate, Description,
                   WhatId, What.Name, WhoId, Who.Name,
                   OwnerId, Owner.Name,
                   TaskSubtype, IsClosed, IsHighPriority,
                   CreatedDate, LastModifiedDate
            FROM Task
            WHERE ${taskConditions.join(' AND ')}
            ORDER BY ActivityDate ASC NULLS LAST
            LIMIT 20
          `);
          results.tasks = taskResult.records || [];
        }

        if (type === 'events' || type === 'both') {
          const eventConditions: string[] = [];
          if (whatId) eventConditions.push(`WhatId = '${sanitizeSoql(whatId)}'`);
          if (whoId) eventConditions.push(`WhoId = '${sanitizeSoql(whoId)}'`);
          if (accountName) eventConditions.push(`Account.Name LIKE '%${sanitizeSoql(accountName)}%'`);

          const eventResult = await conn.query(`
            SELECT Id, Subject, StartDateTime, EndDateTime, Location, Description,
                   WhatId, What.Name, WhoId, Who.Name,
                   OwnerId, Owner.Name,
                   IsAllDayEvent,
                   CreatedDate, LastModifiedDate
            FROM Event
            WHERE ${eventConditions.join(' AND ')}
            ORDER BY StartDateTime ASC
            LIMIT 20
          `);
          results.events = eventResult.records || [];
        }

        const totalCount = results.tasks.length + results.events.length;
        if (totalCount === 0) {
          return JSON.stringify({
            _meta: { tool: 'sfdc_tasks_events', whatId, whoId, accountName },
            message: 'No tasks or events found matching the search criteria.',
            results,
          });
        }

        log.info({ taskCount: results.tasks.length, eventCount: results.events.length }, 'Found tasks and events');
        return JSON.stringify({
          _meta: { tool: 'sfdc_tasks_events', whatId, whoId, accountName },
          results,
        });
      } catch (err: any) {
        log.error({ err }, 'Error searching tasks and events');
        return JSON.stringify({
          _meta: { tool: 'sfdc_tasks_events' },
          error: err.message,
          results: { tasks: [], events: [] },
        });
      }
    },
  });
}
