/**
 * Granola Transcript Tool — fetch raw meeting transcript via MCP.
 * Wraps the MCP `get_meeting_transcript` tool.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getGranolaClient, type GranolaClientScope } from '../services/granola-client.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'granola_transcript' });

export function createGranolaTranscriptTool(userId: string, scope?: GranolaClientScope) {
  return new DynamicStructuredTool({
    name: 'granola_transcript',
    description:
      'Get the raw transcript for a specific Granola meeting. Use when the user needs exact quotes, detailed conversation review, or word-for-word account of what was said. Requires a paid Granola tier.',
    schema: z.object({
      meetingId: z.string().describe('The meeting ID returned from granola_search_meetings'),
    }),
    func: async ({ meetingId }) => {
      log.info({ meetingId }, 'Getting meeting transcript');

      const client = scope ? await scope.get(userId) : await getGranolaClient(userId);
      if (!client) {
        return JSON.stringify({ error: 'Granola not connected. Ask the user to connect Granola in their profile settings.' });
      }

      try {
        const result = await client.callTool({
          name: 'get_meeting_transcript',
          arguments: { meeting_id: meetingId },
        });

        if (!scope) await client.close();

        // Flatten MCP content blocks into plain text
        let transcript = '';
        if (Array.isArray(result.content)) {
          transcript = result.content
            .filter((block: any) => block.type === 'text' && block.text)
            .map((block: any) => block.text)
            .join('\n');
        } else if (typeof result.content === 'string') {
          transcript = result.content;
        }

        log.info({ chars: transcript.length }, 'Got transcript');
        return JSON.stringify({
          _meta: { tool: 'granola_transcript', meetingId },
          transcript: transcript || '(No transcript found)',
        });
      } catch (err: any) {
        log.error({ err }, 'Error getting transcript');
        if (!scope) await client.close().catch(() => {});
        return JSON.stringify({ error: err.message });
      }
    },
  });
}
