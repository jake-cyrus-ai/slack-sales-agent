/**
 * Attio List Companies Tool — browse companies via MCP search-records.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getAttioClient } from '../../services/attio-client.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'attio_list_companies' });

export function createAttioListCompaniesTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'attio_list_companies',
    description:
      'List or browse companies in Attio CRM. Use when no specific company name is given, or to get an overview of companies.',
    schema: z.object({
      query: z.string().optional().describe('Optional search query to filter companies'),
    }),
    func: async ({ query }) => {
      log.info({ query }, 'Listing companies');

      const client = await getAttioClient(organizationId);
      if (!client) {
        return JSON.stringify({
          _meta: { tool: 'attio_list_companies' },
          error: 'Attio not connected. Ask the user to connect Attio in their profile settings.',
          results: [],
        });
      }

      try {
        const args: Record<string, unknown> = { object: 'companies' };
        if (query) args.query = query;

        const result = await client.callTool({
          name: 'search-records',
          arguments: args,
        });

        await client.close();
        log.info('Got results');
        return JSON.stringify({
          _meta: { tool: 'attio_list_companies' },
          results: result.content,
        });
      } catch (err: any) {
        log.error({ err }, 'Failed to list companies');
        await client.close().catch(() => {});
        return JSON.stringify({
          _meta: { tool: 'attio_list_companies' },
          error: err.message,
          results: [],
        });
      }
    },
  });
}
