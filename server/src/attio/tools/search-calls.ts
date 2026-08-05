/**
 * Attio Search Calls Tool — search call recordings via MCP.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getAttioClient } from '../../services/attio-client.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'attio_search_calls' });

export function createAttioSearchCallsTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'attio_search_calls',
    description:
      'Search call recordings stored in Attio CRM. Can find calls by keyword, participant, or company. Use when the user asks about past calls or phone conversations.',
    schema: z.object({
      query: z.string().describe('Search query for calls — person name, company, topic, etc.'),
    }),
    func: async ({ query }) => {
      log.info({ query }, 'Searching calls');

      const client = await getAttioClient(organizationId);
      if (!client) {
        return JSON.stringify({
          _meta: { tool: 'attio_search_calls', query },
          error: 'Attio not connected. Ask the user to connect Attio in their profile settings.',
          results: [],
        });
      }

      try {
        const result = await client.callTool({
          name: 'search-call-recordings-by-metadata',
          arguments: { query },
        });

        await client.close();
        log.info('Got results');
        return JSON.stringify({
          _meta: { tool: 'attio_search_calls', query },
          results: result.content,
        });
      } catch (err: any) {
        log.error({ err }, 'Failed to search calls');
        await client.close().catch(() => {});
        return JSON.stringify({
          _meta: { tool: 'attio_search_calls', query },
          error: err.message,
          results: [],
        });
      }
    },
  });
}
