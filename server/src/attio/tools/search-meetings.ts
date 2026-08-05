/**
 * Attio Search Meetings Tool — search calendar meetings via MCP.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getAttioClient } from '../../services/attio-client.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'attio_search_meetings' });

export function createAttioSearchMeetingsTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'attio_search_meetings',
    description:
      'Search meetings stored in Attio CRM. Can find meetings by keyword, attendee, or company. Use when the user asks about meeting history or upcoming meetings tracked in Attio.',
    schema: z.object({
      query: z.string().describe('Search query for meetings — person name, company, topic, etc.'),
    }),
    func: async ({ query }) => {
      log.info({ query }, 'Searching meetings');

      const client = await getAttioClient(organizationId);
      if (!client) {
        return JSON.stringify({
          _meta: { tool: 'attio_search_meetings', query },
          error: 'Attio not connected. Ask the user to connect Attio in their profile settings.',
          results: [],
        });
      }

      try {
        const result = await client.callTool({
          name: 'search-meetings',
          arguments: { query },
        });

        await client.close();
        log.info('Got results');
        return JSON.stringify({
          _meta: { tool: 'attio_search_meetings', query },
          results: result.content,
        });
      } catch (err: any) {
        log.error({ err }, 'Failed to search meetings');
        await client.close().catch(() => {});
        return JSON.stringify({
          _meta: { tool: 'attio_search_meetings', query },
          error: err.message,
          results: [],
        });
      }
    },
  });
}
