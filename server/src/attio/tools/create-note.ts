/**
 * Attio Create Note Tool — create notes via MCP create-note.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getAttioClient } from '../../services/attio-client.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'attio_create_note' });

export function createAttioCreateNoteTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'attio_create_note',
    description:
      'Create a new note in Attio CRM attached to a company, person, or deal. Use when the user wants to log notes, record meeting summaries, or add context/comments about a record. Set parentObjectType to "deals" when attaching to a deal.',
    schema: z.object({
      title: z.string().describe('Note title'),
      content: z.string().describe('Note content (plain text)'),
      parentObject: z.enum(['companies', 'people', 'deals']).optional()
        .describe('Object type to attach the note to'),
      parentRecordId: z.string().optional()
        .describe('Record ID to attach the note to (from a previous tool call like attio_deals or attio_company_lookup)'),
    }).refine(
      (data) => (!data.parentObject && !data.parentRecordId) || (data.parentObject && data.parentRecordId),
      { message: 'parentObject and parentRecordId must both be provided together, or both omitted' },
    ),
    func: async ({ title, content, parentObject, parentRecordId }) => {
      log.info({ title, parentObject, parentRecordId }, 'Creating note');


      const client = await getAttioClient(organizationId);
      if (!client) {
        return JSON.stringify({
          _meta: { tool: 'attio_create_note' },
          error: 'Attio not connected. Ask the user to connect Attio in their profile settings.',
        });
      }

      try {
        const args: Record<string, unknown> = { title, content };
        if (parentObject) args.parent_object = parentObject;
        if (parentRecordId) args.parent_record_id = parentRecordId;

        const result = await client.callTool({
          name: 'create-note',
          arguments: args,
        });

        await client.close();
        log.info({ isError: result.isError, content: result.content }, 'MCP response');

        if (result.isError) {
          return JSON.stringify({
            _meta: { tool: 'attio_create_note' },
            error: `Attio returned an error creating note "${title}".`,
            results: result.content,
          });
        }

        const resultText = Array.isArray(result.content)
          ? result.content.map((c: any) => c.text || JSON.stringify(c)).join('\n')
          : JSON.stringify(result.content);
        log.info({ resultText }, 'Created note');
        return JSON.stringify({
          _meta: { tool: 'attio_create_note' },
          message: `Successfully created note "${title}".`,
          results: result.content,
        });
      } catch (err: any) {
        log.error({ err }, 'Failed to create note');
        await client.close().catch(() => {});
        return JSON.stringify({
          _meta: { tool: 'attio_create_note' },
          error: err.message,
        });
      }
    },
  });
}
