/**
 * Granola Query Tool — natural language chat over meetings via MCP.
 * Wraps the MCP `query_granola_meetings` tool.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getGranolaClient, type GranolaClientScope } from '../services/granola-client.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'granola_query' });

export function createGranolaQueryTool(userId: string, scope?: GranolaClientScope) {
  return new DynamicStructuredTool({
    name: 'granola_query',
    description:
      'Ask natural language questions about the user\'s meeting history in Granola. WARNING: This tool is SLOW (~20-30s). Only use as a LAST RESORT when granola_search_meetings + granola_get_meeting did not provide enough information. Preserve cited meetings and timestamps where available.',
    schema: z.object({
      query: z.string().describe('Natural language question about meetings — be specific about the topic, person, or timeframe'),
    }),
    func: async ({ query }) => {
      log.info({ query }, 'Querying Granola meetings');

      const client = scope ? await scope.get(userId) : await getGranolaClient(userId);
      if (!client) {
        return JSON.stringify({
          _meta: { tool: 'granola_query', query },
          error: 'Granola not connected. Ask the user to connect Granola in their profile settings.',
        });
      }

      try {
        const result = await client.callTool({
          name: 'query_granola_meetings',
          arguments: { query },
        });

        if (!scope) await client.close();

        // Flatten MCP content blocks into plain text
        let queryText = '';
        if (Array.isArray(result.content)) {
          queryText = result.content
            .filter((block: any) => block.type === 'text' && block.text)
            .map((block: any) => block.text)
            .join('\n');
        } else if (typeof result.content === 'string') {
          queryText = result.content;
        }

        log.info({ chars: queryText.length }, 'Got query results');
        return JSON.stringify({
          _meta: { tool: 'granola_query', query },
          results: queryText || '(No results found)',
        });
      } catch (err: any) {
        log.error({ err }, 'Error querying Granola');
        if (!scope) await client.close().catch(() => {});
        return JSON.stringify({
          _meta: { tool: 'granola_query', query },
          error: err.message,
        });
      }
    },
  });
}
