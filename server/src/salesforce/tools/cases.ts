/**
 * Salesforce Cases Tool — lookup support cases linked to accounts.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSalesforceConnection } from '../client.js';
import { sanitizeSoql } from '../utils.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'sfdc_cases' });

export function createSfdcCasesTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'sfdc_cases',
    description:
      'Search for support cases in Salesforce by account, contact, status, or case number. Returns case details including status, priority, subject, and owner. Use when looking for customer support issues or escalations.',
    schema: z.object({
      accountId: z.string().optional().describe('Salesforce Account ID to find cases for'),
      accountName: z.string().optional().describe('Account name to find cases for (fuzzy match)'),
      contactId: z.string().optional().describe('Contact ID to find cases for'),
      status: z.string().optional().describe('Case status filter (e.g. "New", "Open", "Escalated", "Closed")'),
      caseNumber: z.string().optional().describe('Specific case number to look up'),
    }),
    func: async ({ accountId, accountName, contactId, status, caseNumber }) => {
      log.info({ accountId, accountName, contactId, status, caseNumber }, 'Searching cases');

      if (!accountId && !accountName && !contactId && !status && !caseNumber) {
        return JSON.stringify({
          _meta: { tool: 'sfdc_cases' },
          error: 'Provide at least one search parameter: accountId, accountName, contactId, status, or caseNumber.',
          results: [],
        });
      }

      try {
        const conn = await getSalesforceConnection(organizationId);
        const conditions: string[] = [];

        if (accountId) conditions.push(`AccountId = '${sanitizeSoql(accountId)}'`);
        if (accountName) conditions.push(`Account.Name LIKE '%${sanitizeSoql(accountName)}%'`);
        if (contactId) conditions.push(`ContactId = '${sanitizeSoql(contactId)}'`);
        if (status) conditions.push(`Status = '${sanitizeSoql(status)}'`);
        if (caseNumber) conditions.push(`CaseNumber = '${sanitizeSoql(caseNumber)}'`);

        const whereClause = conditions.join(' AND ');

        const result = await conn.query(`
          SELECT Id, CaseNumber, Subject, Description, Status, Priority, Type,
                 Origin, Reason, IsClosed, IsEscalated,
                 AccountId, Account.Name,
                 ContactId, Contact.Name, Contact.Email,
                 OwnerId, Owner.Name,
                 CreatedDate, ClosedDate, LastModifiedDate
          FROM Case
          WHERE ${whereClause}
          ORDER BY LastModifiedDate DESC
          LIMIT 20
        `);

        if (!result.records || result.records.length === 0) {
          return JSON.stringify({
            _meta: { tool: 'sfdc_cases', accountId, accountName, contactId, status, caseNumber },
            message: 'No cases found matching the search criteria.',
            results: [],
          });
        }

        log.info({ count: result.records.length }, 'Found cases');
        return JSON.stringify({
          _meta: { tool: 'sfdc_cases', accountId, accountName, contactId, status, caseNumber },
          results: result.records,
        });
      } catch (err: any) {
        log.error({ err }, 'Error searching cases');
        return JSON.stringify({
          _meta: { tool: 'sfdc_cases' },
          error: err.message,
          results: [],
        });
      }
    },
  });
}
