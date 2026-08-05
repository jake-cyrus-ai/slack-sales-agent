/**
 * Attio Create Task Tool — create tasks via MCP create-task.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getAttioClient } from '../../services/attio-client.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'attio_create_task' });

export function createAttioCreateTaskTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'attio_create_task',
    description:
      'Create a new task in Attio CRM. Tasks can be linked to companies, people, or deals. Use when the user wants to create a follow-up, schedule a to-do, or assign an action item.',
    schema: z.object({
      content: z.string().describe('Task description (e.g. "Follow up on proposal", "Send pricing deck")'),
      deadline: z.string().optional().describe('Due date in YYYY-MM-DD format'),
      linkedRecordName: z.string().optional().describe('Name of the record to link this task to'),
    }),
    func: async ({ content, deadline, linkedRecordName }) => {
      log.info({ content, deadline, linkedRecordName }, 'Creating task');

      const client = await getAttioClient(organizationId);
      if (!client) {
        return JSON.stringify({
          _meta: { tool: 'attio_create_task' },
          error: 'Attio not connected. Ask the user to connect Attio in their profile settings.',
        });
      }

      try {
        const args: Record<string, unknown> = { content };
        if (deadline) args.deadline = deadline;
        if (linkedRecordName) args.linked_record = linkedRecordName;

        const result = await client.callTool({
          name: 'create-task',
          arguments: args,
        });

        await client.close();
        log.info('Created task');
        return JSON.stringify({
          _meta: { tool: 'attio_create_task' },
          message: `Successfully created task: "${content}".`,
          results: result.content,
        });
      } catch (err: any) {
        log.error({ err }, 'Failed to create task');
        await client.close().catch(() => {});
        return JSON.stringify({
          _meta: { tool: 'attio_create_task' },
          error: err.message,
        });
      }
    },
  });
}
