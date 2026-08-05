/**
 * Attio Search Emails Tool — search email threads via MCP.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getAttioClient } from '../../services/attio-client.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'attio_search_emails' });

export function createAttioSearchEmailsTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'attio_search_emails',
    description:
      'Search email threads stored in Attio CRM. Can find emails by keyword, person, or company. Use when the user asks about email history or correspondence with a contact.',
    schema: z.object({
      query: z.string().describe('Search query for emails — person name, company, topic, etc.'),
    }),
    func: async ({ query }) => {
      log.info({ query }, 'Searching emails');

      const client = await getAttioClient(organizationId);
      if (!client) {
        return JSON.stringify({
          _meta: { tool: 'attio_search_emails', query },
          error: 'Attio not connected. Ask the user to connect Attio in their profile settings.',
          results: [],
        });
      }

      try {
        const result = await client.callTool({
          name: 'search-emails-by-metadata',
          arguments: { query },
        });

        await client.close();
        log.info('Got results');
        return JSON.stringify({
          _meta: { tool: 'attio_search_emails', query },
          results: result.content,
        });
      } catch (err: any) {
        log.error({ err }, 'Failed to search emails');
        await client.close().catch(() => {});
        return JSON.stringify({
          _meta: { tool: 'attio_search_emails', query },
          error: err.message,
          results: [],
        });
      }
    },
  });
}
