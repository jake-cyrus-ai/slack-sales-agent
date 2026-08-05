/**
 * Attio Update Deal Tool — update deal attributes via MCP upsert-record.
 *
 * Uses upsert-record with matching_attribute=name so Attio finds the
 * existing deal and updates it in place.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getAttioClient } from '../../services/attio-client.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'attio_update_deal' });

export function createAttioUpdateDealTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'attio_update_deal',
    description:
      'Update an existing deal in Attio CRM. Can change stage, value, or other deal attributes. Provide the deal name (preferred) or ID. Use when the user wants to move a deal forward, update forecasts, or record deal changes.',
    schema: z.object({
      dealName: z.string().describe('Deal name to identify which deal to update'),
      stage: z.string().optional().describe('New stage name for the deal. Valid stages: Lead, Connected, Discovery, Demo, Negotiating/Procurement, Signature, Won, Keep Warm, Lost'),
      value: z.number().optional().describe('New deal value/amount'),
      closeDate: z.string().optional().describe('New expected close date (YYYY-MM-DD format)'),
    }),
    func: async ({ dealName, stage, value, closeDate }) => {
      log.info({ dealName, stage, value }, 'Updating deal');

      const updates: Record<string, unknown[]> = {};
      if (stage !== undefined) updates.stage = [{ status: stage }];
      if (value !== undefined) updates.value = [{ currency_value: value }];
      if (closeDate !== undefined) updates.close_date = [{ value: closeDate }];

      if (Object.keys(updates).length === 0) {
        return JSON.stringify({
          _meta: { tool: 'attio_update_deal', dealName },
          error: 'No fields to update. Provide at least one of: stage, value, closeDate.',
        });
      }

      const client = await getAttioClient(organizationId);
      if (!client) {
        return JSON.stringify({
          _meta: { tool: 'attio_update_deal', dealName },
          error: 'Attio not connected. Ask the user to connect Attio in their profile settings.',
        });
      }

      try {
        const result = await client.callTool({
          name: 'upsert-record',
          arguments: {
            object: 'deals',
            matching_attribute: 'name',
            values: {
              name: [{ value: dealName }],
              ...updates,
            },
          },
        });

        await client.close();
        log.info({ isError: result.isError, content: result.content }, 'MCP response');

        if (result.isError) {
          return JSON.stringify({
            _meta: { tool: 'attio_update_deal', dealName },
            error: `Attio returned an error updating deal "${dealName}".`,
            results: result.content,
          });
        }

        return JSON.stringify({
          _meta: { tool: 'attio_update_deal', dealName },
          message: `Successfully updated deal "${dealName}".`,
          results: result.content,
        });
      } catch (err: any) {
        log.error({ err }, 'Failed to update deal');
        await client.close().catch(() => {});
        return JSON.stringify({
          _meta: { tool: 'attio_update_deal', dealName },
          error: err.message,
        });
      }
    },
  });
}
