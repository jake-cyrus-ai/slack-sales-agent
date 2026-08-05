/**
 * Salesforce Update Account Tool — update existing account/company records.
 * Supports setting fields, clearing fields (set to null), and renaming.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSalesforceConnection } from '../client.js';
import { sanitizeSoql, buildAttributionTag } from '../utils.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'sfdc_update_account' });

const CLEARABLE_FIELDS = [
  'industry', 'type', 'website', 'phone', 'description',
  'billingCity', 'billingState', 'billingCountry',
  'annualRevenue', 'numberOfEmployees',
] as const;

/** Map camelCase param names → Salesforce API field names. */
const FIELD_MAP: Record<string, string> = {
  newAccountName: 'Name',
  industry: 'Industry',
  type: 'Type',
  website: 'Website',
  phone: 'Phone',
  description: 'Description',
  billingCity: 'BillingCity',
  billingState: 'BillingState',
  billingCountry: 'BillingCountry',
  annualRevenue: 'AnnualRevenue',
  numberOfEmployees: 'NumberOfEmployees',
};

const NUMERIC_FIELDS = new Set(['AnnualRevenue', 'NumberOfEmployees']);

const ACCOUNT_QUERY_FIELDS = `
  Id, Name, Industry, Type, Website, Phone, Description,
  BillingCity, BillingState, BillingCountry,
  AnnualRevenue, NumberOfEmployees,
  OwnerId, Owner.Name, LastModifiedDate
`.trim();

async function resolveAccountRecord(
  conn: any,
  accountId?: string,
  accountName?: string,
): Promise<{ id: string; record: Record<string, any> } | { error: string }> {
  if (accountId) {
    const safeId = sanitizeSoql(accountId);
    const result = await conn.query(`
      SELECT ${ACCOUNT_QUERY_FIELDS}
      FROM Account WHERE Id = '${safeId}' LIMIT 1
    `);
    const record = result.records?.[0] as Record<string, any> | undefined;
    if (record) return { id: record.Id, record };
    log.warn({ accountId }, 'ID not found, falling back to name search');
  }

  if (!accountName) {
    return { error: `Account ID "${accountId}" was not found in Salesforce and no account name was provided to search by.` };
  }

  const safeName = sanitizeSoql(accountName);
  const result = await conn.query(`
    SELECT ${ACCOUNT_QUERY_FIELDS}
    FROM Account
    WHERE Name LIKE '%${safeName}%'
    ORDER BY LastModifiedDate DESC LIMIT 5
  `);

  const records = result.records as Record<string, any>[] | undefined;
  if (!records || records.length === 0) {
    return { error: `No accounts found matching "${accountName}".` };
  }

  if (records.length > 1) {
    const options = records.map((r) =>
      `• ${r.Name} (ID: ${r.Id}) — ${r.Industry || 'No industry'}, ${r.Type || 'No type'}`
    ).join('\n');
    return { error: `Multiple accounts match "${accountName}". Ask the user which one:\n${options}` };
  }

  return { id: records[0].Id, record: records[0] };
}

export function createSfdcUpdateAccountTool(organizationId: string, actorEmail?: string | null) {
  return new DynamicStructuredTool({
    name: 'sfdc_update_account',
    description:
      'Update an existing Account (company) in Salesforce. Can change name, industry, type, website, phone, billing address, revenue, employee count, or description. Can also clear/remove fields. Provide the account name (preferred) or ID.',
    schema: z.object({
      accountName: z.string().optional().describe('Account name to search for (preferred — the tool resolves the correct ID from Salesforce)'),
      accountId: z.string().optional().describe('Salesforce Account ID (if known from a previous tool call in this turn)'),
      newAccountName: z.string().optional().describe('New account name (use only when renaming the account)'),
      industry: z.string().optional().describe('New industry'),
      type: z.string().optional().describe('New account type (e.g. "Prospect", "Customer", "Partner")'),
      website: z.string().optional().describe('New website URL'),
      phone: z.string().optional().describe('New phone number'),
      description: z.string().optional().describe('New description/notes'),
      billingCity: z.string().optional().describe('New billing city'),
      billingState: z.string().optional().describe('New billing state/province'),
      billingCountry: z.string().optional().describe('New billing country'),
      annualRevenue: z.number().optional().describe('New annual revenue in dollars'),
      numberOfEmployees: z.number().optional().describe('New number of employees'),
      clearFields: z.array(z.enum(CLEARABLE_FIELDS)).optional()
        .describe('List of fields to clear/remove (set to blank). Use when the user wants to erase a field value.'),
    }),
    func: async (params) => {
      const {
        accountName, accountId, clearFields,
        newAccountName, industry, type, website, phone, description,
        billingCity, billingState, billingCountry, annualRevenue, numberOfEmployees,
      } = params;

      log.info({ accountName, accountId, clearFields }, 'Updating account');

      if (!accountId && !accountName) {
        return JSON.stringify({
          _meta: { tool: 'sfdc_update_account' },
          error: 'Provide at least accountName or accountId to identify which account to update.',
        });
      }

      // Build updates from provided fields
      const updates: Record<string, any> = {};
      const fieldValues: Record<string, any> = {
        newAccountName, industry, type, website, phone, description,
        billingCity, billingState, billingCountry, annualRevenue, numberOfEmployees,
      };
      for (const [param, value] of Object.entries(fieldValues)) {
        if (value !== undefined && FIELD_MAP[param]) {
          updates[FIELD_MAP[param]] = value;
        }
      }

      // Handle clearFields — set to null (clearFields wins over set values)
      if (clearFields) {
        for (const field of clearFields) {
          const apiField = FIELD_MAP[field];
          if (apiField) updates[apiField] = null;
        }
      }

      if (Object.keys(updates).length === 0) {
        return JSON.stringify({
          _meta: { tool: 'sfdc_update_account', accountId, accountName },
          error: 'No fields to update. Provide at least one field to change or use clearFields to remove a field value.',
        });
      }

      try {
        const conn = await getSalesforceConnection(organizationId);

        const resolved = await resolveAccountRecord(conn, accountId, accountName);
        if ('error' in resolved) {
          return JSON.stringify({
            _meta: { tool: 'sfdc_update_account', accountId, accountName },
            error: resolved.error,
          });
        }

        const { id: resolvedId, record: beforeUpdate } = resolved;
        log.info({ accountId: resolvedId, accountName: beforeUpdate.Name }, 'Resolved account');

        // Attribution tag on description (only if description is being set, not cleared)
        const tag = buildAttributionTag(actorEmail);
        if (tag && updates.Description !== undefined && updates.Description !== null) {
          updates.Description = updates.Description + tag;
        }

        const updateResult = await conn.sobject('Account').update({ Id: resolvedId, ...updates });

        if (!updateResult.success) {
          const errors = (updateResult as any).errors?.map((e: any) =>
            typeof e === 'string' ? e : e.message || JSON.stringify(e)
          ).join(', ') || 'Unknown error';
          log.error({ errors }, 'Update failed');
          return JSON.stringify({
            _meta: { tool: 'sfdc_update_account', accountId: resolvedId },
            error: `Failed to update account "${beforeUpdate.Name}": ${errors}`,
          });
        }

        // Verify by re-querying
        const verifyResult = await conn.query(`
          SELECT ${ACCOUNT_QUERY_FIELDS}
          FROM Account WHERE Id = '${resolvedId}' LIMIT 1
        `);

        const afterUpdate = verifyResult.records?.[0] as Record<string, any> | undefined;

        if (!afterUpdate) {
          return JSON.stringify({
            _meta: { tool: 'sfdc_update_account', accountId: resolvedId },
            error: 'Update was reported as successful but the account could not be re-fetched. Verify manually in Salesforce.',
          });
        }

        // Verify changes
        const mismatches: string[] = [];
        for (const [apiField, value] of Object.entries(updates)) {
          const actual = afterUpdate[apiField];
          if (value === null) {
            if (actual != null && actual !== '') mismatches.push(`${apiField}: expected cleared, got "${actual}"`);
          } else if (NUMERIC_FIELDS.has(apiField)) {
            if (Number(actual) !== Number(value)) mismatches.push(`${apiField}: expected ${value}, got ${actual}`);
          } else {
            const matches = (actual == null ? '' : String(actual)) === String(value);
            if (!matches) mismatches.push(`${apiField}: expected "${value}", got "${actual}"`);
          }
        }

        if (mismatches.length > 0) {
          log.error({ mismatches }, 'Verification failed');
          return JSON.stringify({
            _meta: { tool: 'sfdc_update_account', accountId: resolvedId },
            error: `Update may not have persisted. Verification mismatches: ${mismatches.join('; ')}. Check Salesforce directly.`,
            result: afterUpdate,
          });
        }

        log.info({ accountName: afterUpdate.Name }, 'Verified update');
        return JSON.stringify({
          _meta: { tool: 'sfdc_update_account', accountId: resolvedId },
          message: `Successfully updated account "${afterUpdate.Name}".`,
          updatedFields: Object.keys(updates),
          before: Object.fromEntries(Object.keys(updates).map((f) => [f, beforeUpdate[f]])),
          result: afterUpdate,
        });
      } catch (err: any) {
        log.error({ err }, 'Error updating account');
        return JSON.stringify({
          _meta: { tool: 'sfdc_update_account', accountId, accountName },
          error: err.message,
        });
      }
    },
  });
}
