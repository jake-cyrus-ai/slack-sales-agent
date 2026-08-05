/**
 * Granola Get Meeting Tool — fetch full meeting content via MCP.
 * Wraps the MCP `get_meetings` tool.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getGranolaClient, type GranolaClientScope } from '../services/granola-client.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'granola_get_meeting' });

export function createGranolaGetMeetingTool(userId: string, scope?: GranolaClientScope) {
  return new DynamicStructuredTool({
    name: 'granola_get_meeting',
    description:
      'Get the full content of a specific Granola meeting, including AI-generated notes, enhanced notes, and summary. Use after searching meetings to pull details for a specific meeting by ID. Preserve attendee and timestamp details for evidence validation.',
    schema: z.object({
      meetingId: z.string().describe('The meeting ID returned from granola_search_meetings'),
    }),
    func: async ({ meetingId }) => {
      log.info({ meetingId }, 'Getting meeting content');

      const client = scope ? await scope.get(userId) : await getGranolaClient(userId);
      if (!client) {
        return JSON.stringify({
          _meta: { tool: 'granola_get_meeting', meetingId },
          error: 'Granola not connected. Ask the user to connect Granola in their profile settings.',
        });
      }

      try {
        const result = await client.callTool({
          name: 'get_meetings',
          arguments: { meeting_ids: [meetingId] },
        });

        // Flatten MCP content blocks into plain text for cleaner LLM consumption
        let meetingText = '';
        if (Array.isArray(result.content)) {
          meetingText = result.content
            .filter((block: any) => block.type === 'text' && block.text)
            .map((block: any) => block.text)
            .join('\n');
        } else if (typeof result.content === 'string') {
          meetingText = result.content;
        }

        log.info({ chars: meetingText.length, preview: meetingText.slice(0, 300) }, 'Got meeting content');

        // If notes are thin (<150 chars), auto-fetch the raw transcript as fallback
        const THIN_CONTENT_THRESHOLD = 150;
        if (meetingText.length < THIN_CONTENT_THRESHOLD) {
          log.info({ chars: meetingText.length }, 'Thin content, fetching transcript fallback');
          try {
            const transcriptResult = await client.callTool({
              name: 'get_meeting_transcript',
              arguments: { meeting_id: meetingId },
            });

            let transcriptText = '';
            if (Array.isArray(transcriptResult.content)) {
              transcriptText = transcriptResult.content
                .filter((block: any) => block.type === 'text' && block.text)
                .map((block: any) => block.text)
                .join('\n');
            } else if (typeof transcriptResult.content === 'string') {
              transcriptText = transcriptResult.content;
            }

            if (transcriptText.length > meetingText.length) {
              log.info({ chars: transcriptText.length }, 'Transcript fallback returned');
              meetingText = meetingText
                ? `${meetingText}\n\n--- TRANSCRIPT ---\n${transcriptText}`
                : transcriptText;
            }
          } catch (transcriptErr: any) {
            log.warn({ err: transcriptErr }, 'Transcript fallback failed');
          }
        }

        if (!scope) await client.close();

        return JSON.stringify({
          _meta: { tool: 'granola_get_meeting', meetingId },
          notes: meetingText || '(No meeting content found)',
        });
      } catch (err: any) {
        log.error({ err }, 'Error getting meeting content');
        if (!scope) await client.close().catch(() => {});
        return JSON.stringify({
          _meta: { tool: 'granola_get_meeting', meetingId },
          error: err.message,
        });
      }
    },
  });
}
