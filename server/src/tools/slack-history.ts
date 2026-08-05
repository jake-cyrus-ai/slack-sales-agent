/**
 * Slack History Search Tool — search messages in the user's workspace.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'slack_history_search' });

export function createSlackHistoryTool(botToken: string) {
  return new DynamicStructuredTool({
    name: 'slack_history_search',
    description:
      'Search Slack messages in the workspace. Use when asked about conversations, decisions, or information shared in Slack channels.',
    schema: z.object({
      query: z.string().describe('Search query for Slack messages'),
      channel: z.string().optional().describe('Optional channel ID to search within'),
    }),
    func: async ({ query, channel }) => {
      log.info({ query, channel: channel || 'all' }, 'Searching Slack history');

      try {
        const params: Record<string, string> = { query };
        if (channel) params.channel = channel;

        const urlParams = new URLSearchParams(params);
        const response = await fetch(`https://slack.com/api/search.messages?${urlParams}`, {
          headers: {
            Authorization: `Bearer ${botToken}`,
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          return JSON.stringify({ error: `Slack API failed: ${response.status}`, results: [] });
        }

        const data = await response.json();

        if (!data.ok) {
          // search:read scope may not be available
          return JSON.stringify({
            error: `Slack search failed: ${data.error}. The bot may need the search:read scope.`,
            results: [],
          });
        }

        const matches = (data.messages?.matches || []).slice(0, 10).map((m: any) => ({
          text: m.text?.substring(0, 300),
          channel: m.channel?.name,
          user: m.username,
          timestamp: m.ts,
          permalink: m.permalink,
        }));

        log.info({ count: matches.length }, 'Found messages');
        return JSON.stringify({ results: matches });
      } catch (err: any) {
        log.error({ err }, 'Error searching Slack history');
        return JSON.stringify({ error: err.message, results: [] });
      }
    },
  });
}
