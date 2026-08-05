/**
 * Attio Create Deal Tool — create deals via MCP create-record.
 *
 * Attio's MCP create-record expects:
 *   - object: "deals"
 *   - values: { name: [{ value: "..." }], stage: [{ status: "..." }], ... }
 * Each attribute value is wrapped in an array of typed objects.
 *
 * Required fields in Attio deals: name, stage, owner (actor-reference).
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getAttioClient } from '../../services/attio-client.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'attio_create_deal' });

export function createAttioCreateDealTool(organizationId: string, defaultOwnerEmail?: string | null) {
  return new DynamicStructuredTool({
    name: 'attio_create_deal',
    description:
      'Create a new deal in Attio CRM. Requires: deal name and stage. The deal owner defaults to the current Slack user. Use when the user wants to create a new opportunity, log a new deal, or start tracking a potential sale.',
    schema: z.object({
      name: z.string().describe('Deal name (e.g. "Acme Corp - Enterprise Plan")'),
      ownerEmail: z.string().optional().describe('Email address of the deal owner (workspace member). Only provide if the user specifies a different owner.'),
      stage: z.string().optional().describe('Initial stage for the deal. Valid stages: Lead, Connected, Discovery, Demo, Negotiating/Procurement, Signature, Won, Keep Warm, Lost'),
      value: z.number().optional().describe('Deal value/amount in USD'),
      closeDate: z.string().optional().describe('Expected close date (YYYY-MM-DD format)'),
      companyName: z.string().optional().describe('Company name to associate the deal with'),
    }),
    func: async ({ name, ownerEmail, stage, value, closeDate, companyName }) => {
      const resolvedOwner = ownerEmail || defaultOwnerEmail;
      log.info({ name, owner: resolvedOwner, stage, value, companyName }, 'Creating deal');

      if (!resolvedOwner) {
        return JSON.stringify({
          _meta: { tool: 'attio_create_deal' },
          error: 'Deal owner email is required. Ask the user for their email or who should own this deal.',
        });
      }

      const client = await getAttioClient(organizationId);
      if (!client) {
        return JSON.stringify({
          _meta: { tool: 'attio_create_deal' },
          error: 'Attio not connected. Ask the user to connect Attio in their profile settings.',
        });
      }

      try {
        // Build values in Attio's nested array format
        const values: Record<string, unknown[]> = {
          name: [{ value: name }],
          owner: [{ workspace_member_email_address: resolvedOwner }],
        };
        if (stage) values.stage = [{ status: stage }];
        if (value !== undefined) values.value = [{ currency_value: value }];
        if (closeDate) values.close_date = [{ value: closeDate }];

        // If company name provided, search for it to get record ID
        if (companyName) {
          try {
            const searchResult = await client.callTool({
              name: 'search-records',
              arguments: { object: 'companies', query: companyName },
            });

            const content = searchResult.content as any[];
            const textContent = content?.find((c: any) => c.type === 'text');
            if (textContent?.text) {
              // Extract record ID from the text — Attio MCP returns formatted text
              // Look for patterns like "record_id: <uuid>" or similar
              const idMatch = textContent.text.match(/record_id:\s*([a-f0-9-]{36})/i)
                || textContent.text.match(/id:\s*([a-f0-9-]{36})/i);
              if (idMatch) {
                values.associated_company = [{
                  target_object: 'companies',
                  target_record_id: idMatch[1],
                }];
                log.info({ companyName, recordId: idMatch[1] }, 'Found company');
              } else {
                log.warn({ searchResponse: textContent.text.slice(0, 500) }, 'Company search returned text but no record ID found');
              }
            }
          } catch (err) {
            log.warn({ err }, 'Company search failed');
          }
        }

        log.info({ values }, 'Creating deal with values');

        const result = await client.callTool({
          name: 'create-record',
          arguments: { object: 'deals', values },
        });

        await client.close();

        const resultContent = result.content as any[];
        const textResult = resultContent?.find((c: any) => c.type === 'text');
        const resultText = textResult?.text || '';

        log.info({ resultText: resultText.slice(0, 1000) }, 'MCP response');

        // Check the MCP result's isError flag instead of fragile text matching
        if (result.isError) {
          return JSON.stringify({
            _meta: { tool: 'attio_create_deal' },
            error: resultText,
          });
        }

        return JSON.stringify({
          _meta: { tool: 'attio_create_deal' },
          message: `Successfully created deal "${name}".`,
          results: resultContent,
        });
      } catch (err: any) {
        log.error({ err }, 'Failed to create deal');
        await client.close().catch(() => {});
        return JSON.stringify({
          _meta: { tool: 'attio_create_deal' },
          error: err.message,
        });
      }
    },
  });
}
