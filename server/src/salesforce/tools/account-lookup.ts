/**
 * Salesforce Account Lookup Tool — find customer accounts by name.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSalesforceConnection } from '../client.js';
import { sanitizeSoql } from '../utils.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'sfdc_account_lookup' });

export function createSfdcAccountLookupTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'sfdc_account_lookup',
    description:
      'Look up a customer or company account in Salesforce (SFDC) by name. Returns Account ID, industry, website, owner, and key fields. Use when asked about a specific customer, company, or deal that may exist in Salesforce.',
    schema: z.object({
      accountName: z.string().describe('Customer or company name to search for'),
    }),
    func: async ({ accountName }) => {
      log.info({ accountName }, 'Looking up account');

      try {
        const conn = await getSalesforceConnection(organizationId);
        const safeName = sanitizeSoql(accountName);

        const result = await conn.query(`
          SELECT Id, Name, Industry, Website, Type, Description, Phone,
                 BillingCity, BillingState, BillingCountry,
                 AnnualRevenue, NumberOfEmployees,
                 OwnerId, Owner.Name,
                 CreatedDate, LastModifiedDate
          FROM Account
          WHERE Name LIKE '%${safeName}%'
          ORDER BY LastModifiedDate DESC
          LIMIT 5
        `);

        if (!result.records || result.records.length === 0) {
          return JSON.stringify({
            _meta: { tool: 'sfdc_account_lookup', query: accountName },
            message: `No Salesforce accounts found matching "${accountName}".`,
            results: [],
          });
        }

        log.info({ count: result.records.length }, 'Found accounts');
        return JSON.stringify({
          _meta: { tool: 'sfdc_account_lookup', query: accountName },
          results: result.records,
        });
      } catch (err: any) {
        log.error({ err }, 'Error looking up account');
        return JSON.stringify({
          _meta: { tool: 'sfdc_account_lookup', query: accountName },
          error: err.message,
          results: [],
        });
      }
    },
  });
}
