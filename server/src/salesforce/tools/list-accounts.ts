/**
 * Salesforce List Accounts Tool — browse/filter accounts without requiring a name.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSalesforceConnection } from '../client.js';
import { sanitizeSoql } from '../utils.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'sfdc_list_accounts' });

const ORDER_BY_MAP: Record<string, string> = {
  name: 'Name ASC',
  lastModified: 'LastModifiedDate DESC',
  created: 'CreatedDate DESC',
  revenue: 'AnnualRevenue DESC NULLS LAST',
};

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

export function createSfdcListAccountsTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'sfdc_list_accounts',
    description:
      'List or browse Salesforce accounts with optional filters. Use when asked "what accounts do we have?", "show me all customers", "list accounts in healthcare", or any request to see accounts without a specific name to search for. All parameters are optional — calling with no parameters returns the most recently modified accounts.',
    schema: z.object({
      industry: z.string().optional().describe('Filter by industry (e.g. "Technology", "Healthcare", "Finance")'),
      type: z.string().optional().describe('Filter by account type (e.g. "Customer", "Prospect", "Partner")'),
      owner: z.string().optional().describe('Filter by account owner name'),
      limit: z.number().optional().describe(`Max results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
      orderBy: z
        .enum(['name', 'lastModified', 'created', 'revenue'])
        .optional()
        .describe('Sort order: "name", "lastModified" (default), "created", or "revenue"'),
    }),
    func: async ({ industry, type, owner, limit, orderBy }) => {
      const effectiveLimit = Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
      const effectiveOrder = ORDER_BY_MAP[orderBy ?? 'lastModified'];

      log.info({ industry, type, owner, limit: effectiveLimit, orderBy }, 'Listing accounts');

      try {
        const conn = await getSalesforceConnection(organizationId);
        const conditions: string[] = [];

        if (industry) conditions.push(`Industry LIKE '%${sanitizeSoql(industry)}%'`);
        if (type) conditions.push(`Type LIKE '%${sanitizeSoql(type)}%'`);
        if (owner) conditions.push(`Owner.Name LIKE '%${sanitizeSoql(owner)}%'`);

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const result = await conn.query(`
          SELECT Id, Name, Industry, Website, Type, Description, Phone,
                 BillingCity, BillingState, BillingCountry,
                 AnnualRevenue, NumberOfEmployees,
                 OwnerId, Owner.Name,
                 CreatedDate, LastModifiedDate
          FROM Account
          ${whereClause}
          ORDER BY ${effectiveOrder}
          LIMIT ${effectiveLimit}
        `);

        if (!result.records || result.records.length === 0) {
          return JSON.stringify({
            _meta: { tool: 'sfdc_list_accounts', industry, type, owner },
            message: 'No accounts found matching the specified filters.',
            results: [],
          });
        }

        log.info({ count: result.records.length, totalSize: result.totalSize }, 'Found accounts');
        return JSON.stringify({
          _meta: {
            tool: 'sfdc_list_accounts',
            industry,
            type,
            owner,
            returned: result.records.length,
            totalSize: result.totalSize,
          },
          results: result.records,
        });
      } catch (err: any) {
        log.error({ err }, 'Error listing accounts');
        return JSON.stringify({
          _meta: { tool: 'sfdc_list_accounts', industry, type, owner },
          error: err.message,
          results: [],
        });
      }
    },
  });
}
