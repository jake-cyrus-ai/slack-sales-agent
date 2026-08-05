/**
 * Attio Tasks Tool — retrieve tasks via MCP search-records.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getAttioClient } from '../../services/attio-client.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'attio_tasks' });

export function createAttioTasksTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'attio_tasks',
    description:
      'Retrieve tasks from Attio CRM. Can filter by keyword or status. Use when asked about follow-ups, to-dos, or upcoming tasks related to deals or contacts.',
    schema: z.object({
      query: z.string().optional().describe('Search query for tasks'),
    }),
    func: async ({ query }) => {
      log.info({ query }, 'Querying tasks');

      const client = await getAttioClient(organizationId);
      if (!client) {
        return JSON.stringify({
          _meta: { tool: 'attio_tasks' },
          error: 'Attio not connected. Ask the user to connect Attio in their profile settings.',
          results: [],
        });
      }

      try {
        const args: Record<string, unknown> = { object: 'tasks' };
        if (query) args.query = query;

        const result = await client.callTool({
          name: 'search-records',
          arguments: args,
        });

        await client.close();
        log.info('Got results');
        return JSON.stringify({
          _meta: { tool: 'attio_tasks' },
          results: result.content,
        });
      } catch (err: any) {
        log.error({ err }, 'Failed to query tasks');
        await client.close().catch(() => {});
        return JSON.stringify({
          _meta: { tool: 'attio_tasks' },
          error: `Task search failed: ${err.message}. Note: The Attio MCP server may not support searching tasks via search-records. Tasks can be created/updated but listing them may not be available.`,
          results: [],
        });
      }
    },
  });
}
