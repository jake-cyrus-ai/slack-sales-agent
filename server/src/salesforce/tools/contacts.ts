/**
 * Salesforce Contacts Tool — lookup people at accounts by name, email, or account.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSalesforceConnection } from '../client.js';
import { sanitizeSoql } from '../utils.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'sfdc_contacts' });

export function createSfdcContactsTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'sfdc_contacts',
    description:
      'Search for contacts (people) in Salesforce by name, email, title, or associated account. Returns contact details including role, phone, email, and account relationship. Use when looking up a person at a company or finding key stakeholders.',
    schema: z.object({
      contactName: z.string().optional().describe('Contact name to search for'),
      email: z.string().optional().describe('Email address to search for'),
      accountId: z.string().optional().describe('Salesforce Account ID to find contacts for'),
      accountName: z.string().optional().describe('Account name to find contacts for (fuzzy match)'),
      title: z.string().optional().describe('Job title to filter by (e.g. "VP", "CTO")'),
    }),
    func: async ({ contactName, email, accountId, accountName, title }) => {
      log.info({ contactName, email, accountId, accountName, title }, 'Searching contacts');

      if (!contactName && !email && !accountId && !accountName && !title) {
        return JSON.stringify({
          _meta: { tool: 'sfdc_contacts' },
          error: 'Provide at least one search parameter: contactName, email, accountId, accountName, or title.',
          results: [],
        });
      }

      try {
        const conn = await getSalesforceConnection(organizationId);
        const conditions: string[] = [];

        if (contactName) conditions.push(`Name LIKE '%${sanitizeSoql(contactName)}%'`);
        if (email) conditions.push(`Email LIKE '%${sanitizeSoql(email)}%'`);
        if (accountId) conditions.push(`AccountId = '${sanitizeSoql(accountId)}'`);
        if (accountName) conditions.push(`Account.Name LIKE '%${sanitizeSoql(accountName)}%'`);
        if (title) conditions.push(`Title LIKE '%${sanitizeSoql(title)}%'`);

        const whereClause = conditions.join(' AND ');

        const result = await conn.query(`
          SELECT Id, Name, FirstName, LastName, Title, Email, Phone, MobilePhone,
                 Department, MailingCity, MailingState, MailingCountry,
                 AccountId, Account.Name,
                 OwnerId, Owner.Name,
                 LeadSource, Description,
                 CreatedDate, LastModifiedDate, LastActivityDate
          FROM Contact
          WHERE ${whereClause}
          ORDER BY LastModifiedDate DESC
          LIMIT 20
        `);

        if (!result.records || result.records.length === 0) {
          return JSON.stringify({
            _meta: { tool: 'sfdc_contacts', contactName, email, accountId, accountName },
            message: 'No contacts found matching the search criteria.',
            results: [],
          });
        }

        log.info({ count: result.records.length }, 'Found contacts');
        return JSON.stringify({
          _meta: { tool: 'sfdc_contacts', contactName, email, accountId, accountName },
          results: result.records,
        });
      } catch (err: any) {
        log.error({ err }, 'Error searching contacts');
        return JSON.stringify({
          _meta: { tool: 'sfdc_contacts' },
          error: err.message,
          results: [],
        });
      }
    },
  });
}
