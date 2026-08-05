/**
 * Granola Search Meetings Tool — search meeting metadata via MCP.
 * Wraps the MCP `list_meetings` tool.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getGranolaClient, type GranolaClientScope } from '../services/granola-client.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'granola_search_meetings' });

export function createGranolaSearchMeetingsTool(userId: string, scope?: GranolaClientScope) {
  return new DynamicStructuredTool({
    name: 'granola_search_meetings',
    description:
      'Search Granola meeting notes by keyword, person name, company, or topic. Returns meeting titles, dates, and attendees. Use when the user asks about past meetings, who they met with, or meeting history. Preserve meeting IDs, attendee metadata, and timestamps for evidence verification.',
    schema: z.object({
      query: z.string().describe('Search query — person name, company, topic, date reference, etc.'),
      limit: z.number().optional().default(10).describe('Maximum number of results to return'),
    }),
    func: async ({ query, limit }) => {
      log.info({ query, limit }, 'Searching Granola meetings');

      const client = scope ? await scope.get(userId) : await getGranolaClient(userId);
      if (!client) {
        return JSON.stringify({
          _meta: { tool: 'granola_search_meetings', query, limit },
          error: 'Granola not connected. Ask the user to connect Granola in their profile settings.',
          results: [],
        });
      }

      try {
        const result = await client.callTool({
          name: 'list_meetings',
          arguments: { query, limit },
        });

        if (!scope) await client.close();

        // Flatten MCP content blocks into plain text
        let searchText = '';
        if (Array.isArray(result.content)) {
          searchText = result.content
            .filter((block: any) => block.type === 'text' && block.text)
            .map((block: any) => block.text)
            .join('\n');
        } else if (typeof result.content === 'string') {
          searchText = result.content;
        }

        log.info({ chars: searchText.length }, 'Got search results');
        return JSON.stringify({
          _meta: { tool: 'granola_search_meetings', query, limit },
          results: searchText || '(No meetings found)',
        });
      } catch (err: any) {
        log.error({ err }, 'Error searching Granola meetings');
        if (!scope) await client.close().catch(() => {});
        return JSON.stringify({
          _meta: { tool: 'granola_search_meetings', query, limit },
          error: err.message,
          results: [],
        });
      }
    },
  });
}
