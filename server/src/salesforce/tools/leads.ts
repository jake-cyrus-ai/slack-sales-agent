/**
 * Salesforce Leads Tool — search and view lead records.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSalesforceConnection } from '../client.js';
import { sanitizeSoql } from '../utils.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'sfdc_leads' });

export function createSfdcLeadsTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'sfdc_leads',
    description:
      'Search for leads in Salesforce by name, company, email, or status. Returns lead details including status, source, rating, and owner. Use when looking for prospective customers that have not yet been converted to accounts/contacts.',
    schema: z.object({
      leadName: z.string().optional().describe('Lead name to search for'),
      company: z.string().optional().describe('Company name to search for'),
      email: z.string().optional().describe('Email address to search for'),
      status: z.string().optional().describe('Lead status to filter by (e.g. "Open", "Qualified", "Converted")'),
    }),
    func: async ({ leadName, company, email, status }) => {
      log.info({ leadName, company, email, status }, 'Searching leads');

      if (!leadName && !company && !email && !status) {
        return JSON.stringify({
          _meta: { tool: 'sfdc_leads' },
          error: 'Provide at least one search parameter: leadName, company, email, or status.',
          results: [],
        });
      }

      try {
        const conn = await getSalesforceConnection(organizationId);
        const conditions: string[] = [];

        if (leadName) conditions.push(`Name LIKE '%${sanitizeSoql(leadName)}%'`);
        if (company) conditions.push(`Company LIKE '%${sanitizeSoql(company)}%'`);
        if (email) conditions.push(`Email LIKE '%${sanitizeSoql(email)}%'`);
        if (status) conditions.push(`Status = '${sanitizeSoql(status)}'`);

        const whereClause = conditions.join(' AND ');

        const result = await conn.query(`
          SELECT Id, Name, FirstName, LastName, Title, Company, Email, Phone,
                 Status, LeadSource, Rating, Industry,
                 Street, City, State, Country,
                 OwnerId, Owner.Name,
                 Description, NumberOfEmployees, AnnualRevenue,
                 IsConverted, ConvertedAccountId, ConvertedContactId, ConvertedOpportunityId,
                 CreatedDate, LastModifiedDate, LastActivityDate
          FROM Lead
          WHERE ${whereClause}
          ORDER BY LastModifiedDate DESC
          LIMIT 20
        `);

        if (!result.records || result.records.length === 0) {
          return JSON.stringify({
            _meta: { tool: 'sfdc_leads', leadName, company, email, status },
            message: 'No leads found matching the search criteria.',
            results: [],
          });
        }

        log.info({ count: result.records.length }, 'Found leads');
        return JSON.stringify({
          _meta: { tool: 'sfdc_leads', leadName, company, email, status },
          results: result.records,
        });
      } catch (err: any) {
        log.error({ err }, 'Error searching leads');
        return JSON.stringify({
          _meta: { tool: 'sfdc_leads' },
          error: err.message,
          results: [],
        });
      }
    },
  });
}
