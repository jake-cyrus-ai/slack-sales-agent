/**
 * Attio Deals Tool — retrieve deal/opportunity data via MCP.
 *
 * Uses `list-records` for listing all deals (with pagination),
 * and `search-records` for name-based searches.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getAttioClient } from '../../services/attio-client.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'attio_deals' });

export function createAttioDealsTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'attio_deals',
    description:
      'Retrieve deals/opportunities from Attio CRM. Can search by deal name or list all deals. Returns stage, value, associated company, and other deal attributes.',
    schema: z.object({
      dealName: z.string().optional().describe('Deal name to search for. Omit to list all deals.'),
    }),
    func: async ({ dealName }) => {
      // Normalize: treat undefined, "undefined", "*", empty string as "list all"
      const normalizedName = (dealName && dealName !== 'undefined' && dealName !== '*' && dealName.trim())
        ? dealName.trim()
        : undefined;
      log.info({ dealName, normalizedName: normalizedName || '(all)' }, 'Querying deals');

      const client = await getAttioClient(organizationId);
      if (!client) {
        return JSON.stringify({
          _meta: { tool: 'attio_deals', dealName: normalizedName },
          error: 'Attio not connected. Ask the user to connect Attio in their profile settings.',
          results: [],
        });
      }

      try {
        let allContent: any[] = [];

        if (normalizedName) {
          // Search by name — use search-records (max 10 results per Attio's limit)
          const result = await client.callTool({
            name: 'search-records',
            arguments: { object: 'deals', query: normalizedName, limit: 10 },
          });
          allContent = result.content as any[];
        } else {
          // List all deals — use list-records with pagination
          const MAX_PAGES = 5;
          const PAGE_SIZE = 10;
          for (let page = 0; page < MAX_PAGES; page++) {
            const result = await client.callTool({
              name: 'list-records',
              arguments: { object: 'deals', limit: PAGE_SIZE, offset: page * PAGE_SIZE },
            });
            const content = result.content as any[];
            allContent.push(...content);

            // Check if we got fewer results than requested (last page)
            const textContent = content?.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
            // If no records found or response indicates end of results, stop paginating
            if (!content?.length || textContent.includes('No records found') || textContent.length < 50) {
              break;
            }
          }
        }

        await client.close();
        const textContent = allContent?.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
        log.info({ contentBlocks: allContent?.length || 0, textLength: textContent.length }, 'Got results');

        return JSON.stringify({
          _meta: { tool: 'attio_deals', dealName: normalizedName },
          results: allContent,
        });
      } catch (err: any) {
        log.error({ err }, 'Failed to query deals');
        await client.close().catch(() => {});
        return JSON.stringify({
          _meta: { tool: 'attio_deals', dealName: normalizedName },
          error: err.message,
          results: [],
        });
      }
    },
  });
}
