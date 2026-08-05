/**
 * Attio Lists Tool — query list entries via MCP search-records.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getAttioClient } from '../../services/attio-client.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'attio_lists' });

export function createAttioListsTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'attio_lists',
    description:
      'Search for entries in an Attio list (pipeline, lead list, or other organized collection). Requires a list name to search. Use to view pipeline stages, track records through workflows, or browse organized data.',
    schema: z.object({
      query: z.string().optional().describe('Search query to filter list entries'),
      listName: z.string().describe('Name of the Attio list to search in (e.g. "Sales Pipeline", "Leads")'),
    }),
    func: async ({ query, listName }) => {
      log.info({ query, listName }, 'Searching list');

      const client = await getAttioClient(organizationId);
      if (!client) {
        return JSON.stringify({
          _meta: { tool: 'attio_lists' },
          error: 'Attio not connected. Ask the user to connect Attio in their profile settings.',
          results: [],
        });
      }

      try {
        // Attio MCP search-records requires `object` — use listName as the object
        // since Attio lists are queried as custom objects by name
        const args: Record<string, unknown> = { object: listName };
        if (query) args.query = query;

        const result = await client.callTool({
          name: 'search-records',
          arguments: args,
        });

        await client.close();
        log.info('Got results');
        return JSON.stringify({
          _meta: { tool: 'attio_lists' },
          results: result.content,
        });
      } catch (err: any) {
        log.error({ err }, 'Failed to search list');
        await client.close().catch(() => {});
        return JSON.stringify({
          _meta: { tool: 'attio_lists', listName },
          error: `Failed to search list "${listName}": ${err.message}. The list name may not exist in this Attio workspace — try asking the user for the exact list name.`,
          results: [],
        });
      }
    },
  });
}
