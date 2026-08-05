/**
 * Attio Notes Tool — retrieve notes via MCP search-notes-by-metadata + get-note-body.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getAttioClient } from '../../services/attio-client.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'attio_notes' });

export function createAttioNotesTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'attio_notes',
    description:
      'Retrieve notes from Attio CRM. Can search by keyword or get notes for a specific record. Use when the user asks about notes, comments, or context recorded about a company or contact.',
    schema: z.object({
      query: z.string().optional().describe('Search query for notes'),
      parentObject: z.enum(['companies', 'people', 'deals']).optional()
        .describe('Object type the notes are attached to'),
      parentRecordId: z.string().optional()
        .describe('Record ID to get notes for (from a previous tool call)'),
    }),
    func: async ({ query, parentObject, parentRecordId }) => {
      log.info({ query, parentObject, parentRecordId }, 'Querying notes');

      const client = await getAttioClient(organizationId);
      if (!client) {
        return JSON.stringify({
          _meta: { tool: 'attio_notes' },
          error: 'Attio not connected. Ask the user to connect Attio in their profile settings.',
          results: [],
        });
      }

      try {
        const args: Record<string, unknown> = {};
        if (query) args.query = query;
        if (parentObject) args.parent_object = parentObject;
        if (parentRecordId) args.parent_record_id = parentRecordId;

        const result = await client.callTool({
          name: 'search-notes-by-metadata',
          arguments: args,
        });

        await client.close();
        log.info('Got results');
        return JSON.stringify({
          _meta: { tool: 'attio_notes' },
          results: result.content,
        });
      } catch (err: any) {
        log.error({ err }, 'Failed to query notes');
        await client.close().catch(() => {});
        return JSON.stringify({
          _meta: { tool: 'attio_notes' },
          error: err.message,
          results: [],
        });
      }
    },
  });
}
