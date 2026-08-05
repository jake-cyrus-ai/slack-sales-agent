/**
 * Attio Company Lookup Tool — find companies via MCP search-records.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getAttioClient } from '../../services/attio-client.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'attio_company_lookup' });

export function createAttioCompanyLookupTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'attio_company_lookup',
    description:
      'Look up a company in Attio CRM by name. Returns company details including domain, industry, and other attributes. Use when asked about a specific company or customer that may exist in Attio.',
    schema: z.object({
      companyName: z.string().describe('Company name to search for'),
    }),
    func: async ({ companyName }) => {
      log.info({ companyName }, 'Looking up company');

      const client = await getAttioClient(organizationId);
      if (!client) {
        return JSON.stringify({
          _meta: { tool: 'attio_company_lookup', query: companyName },
          error: 'Attio not connected. Ask the user to connect Attio in their profile settings.',
          results: [],
        });
      }

      try {
        const result = await client.callTool({
          name: 'search-records',
          arguments: { object: 'companies', query: companyName },
        });

        await client.close();
        log.info('Got results');
        return JSON.stringify({
          _meta: { tool: 'attio_company_lookup', query: companyName },
          results: result.content,
        });
      } catch (err: any) {
        log.error({ err }, 'Failed to look up company');
        await client.close().catch(() => {});
        return JSON.stringify({
          _meta: { tool: 'attio_company_lookup', query: companyName },
          error: err.message,
          results: [],
        });
      }
    },
  });
}
