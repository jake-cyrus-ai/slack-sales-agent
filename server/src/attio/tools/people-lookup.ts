/**
 * Attio People Lookup Tool — find people/contacts via MCP search-records.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getAttioClient } from '../../services/attio-client.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'attio_people_lookup' });

export function createAttioPeopleLookupTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'attio_people_lookup',
    description:
      'Search for people (contacts) in Attio CRM by name or email address. Returns contact details including email, phone, company association, and other attributes. Use when looking up a person or finding stakeholders.',
    schema: z.object({
      query: z.string().describe('Person name or email to search for'),
    }),
    func: async ({ query }) => {
      log.info({ query }, 'Looking up people');

      const client = await getAttioClient(organizationId);
      if (!client) {
        return JSON.stringify({
          _meta: { tool: 'attio_people_lookup', query },
          error: 'Attio not connected. Ask the user to connect Attio in their profile settings.',
          results: [],
        });
      }

      try {
        const result = await client.callTool({
          name: 'search-records',
          arguments: { object: 'people', query },
        });

        await client.close();
        log.info('Got results');
        return JSON.stringify({
          _meta: { tool: 'attio_people_lookup', query },
          results: result.content,
        });
      } catch (err: any) {
        log.error({ err }, 'Failed to look up people');
        await client.close().catch(() => {});
        return JSON.stringify({
          _meta: { tool: 'attio_people_lookup', query },
          error: err.message,
          results: [],
        });
      }
    },
  });
}
