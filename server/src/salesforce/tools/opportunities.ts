/**
 * Salesforce Opportunities Tool — retrieve deal data for an account.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSalesforceConnection } from '../client.js';
import { sanitizeSoql } from '../utils.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'sfdc_opportunities' });

export function createSfdcOpportunitiesTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'sfdc_opportunities',
    description:
      'Retrieve deals/opportunities from Salesforce for a given Account ID or account name. Returns stage, amount, close date, probability, next steps, and recent activity. Use after sfdc_account_lookup to get deal details, or search by name directly.',
    schema: z.object({
      accountId: z.string().optional().describe('Salesforce Account ID (from sfdc_account_lookup results)'),
      accountName: z.string().optional().describe('Account name to search by if Account ID is not known'),
    }),
    func: async ({ accountId, accountName }) => {
      log.info({ accountId, accountName }, 'Searching opportunities');

      if (!accountId && !accountName) {
        return JSON.stringify({
          _meta: { tool: 'sfdc_opportunities' },
          error: 'Provide either accountId or accountName.',
          results: [],
        });
      }

      try {
        const conn = await getSalesforceConnection(organizationId);

        let whereClause: string;
        if (accountId) {
          whereClause = `AccountId = '${sanitizeSoql(accountId)}'`;
        } else {
          whereClause = `Account.Name LIKE '%${sanitizeSoql(accountName!)}%'`;
        }

        const result = await conn.query(`
          SELECT Id, Name, StageName, Amount, CloseDate, Probability,
                 Account.Name, Owner.Name, NextStep, Description,
                 LastModifiedDate, CreatedDate, ForecastCategory, Type,
                 LeadSource, IsClosed, IsWon
          FROM Opportunity
          WHERE ${whereClause}
          ORDER BY LastModifiedDate DESC
          LIMIT 10
        `);

        if (!result.records || result.records.length === 0) {
          return JSON.stringify({
            _meta: { tool: 'sfdc_opportunities', accountId, accountName },
            message: `No opportunities found in Salesforce for this account.`,
            results: [],
          });
        }

        log.info({ count: result.records.length }, 'Found opportunities');
        return JSON.stringify({
          _meta: { tool: 'sfdc_opportunities', accountId, accountName },
          results: result.records,
        });
      } catch (err: any) {
        log.error({ err }, 'Error searching opportunities');
        return JSON.stringify({
          _meta: { tool: 'sfdc_opportunities', accountId, accountName },
          error: err.message,
          results: [],
        });
      }
    },
  });
}
