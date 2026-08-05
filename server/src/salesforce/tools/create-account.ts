/**
 * Salesforce Create Account Tool — upsert company/account records.
 * If an account with the same name already exists, updates it with any new
 * field values instead of creating a duplicate.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSalesforceConnection } from '../client.js';
import { sanitizeSoql, resolveSalesforceUserId, buildAttributionTag, isOwnerIdError } from '../utils.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'sfdc_create_account' });

export function createSfdcCreateAccountTool(organizationId: string, actorEmail?: string | null) {
  return new DynamicStructuredTool({
    name: 'sfdc_create_account',
    description:
      'Create a new Account (company) in Salesforce. Use when the user wants to add a new company to the CRM, track a new prospect, or create a record for a company not yet in Salesforce.',
    schema: z.object({
      accountName: z.string().describe('Company/account name (e.g. "Acme Corp")'),
      industry: z.string().optional().describe('Industry (e.g. "Technology", "Healthcare", "Financial Services")'),
      type: z.string().optional().describe('Account type (e.g. "Prospect", "Customer", "Partner")'),
      website: z.string().optional().describe('Company website URL'),
      phone: z.string().optional().describe('Main phone number'),
      description: z.string().optional().describe('Account description or notes'),
      billingCity: z.string().optional().describe('Billing city'),
      billingState: z.string().optional().describe('Billing state/province'),
      billingCountry: z.string().optional().describe('Billing country'),
      annualRevenue: z.number().optional().describe('Annual revenue in dollars'),
      numberOfEmployees: z.number().optional().describe('Number of employees'),
    }),
    func: async ({ accountName, industry, type, website, phone, description, billingCity, billingState, billingCountry, annualRevenue, numberOfEmployees }) => {
      log.info({ accountName, industry, type }, 'Creating account');

      try {
        const conn = await getSalesforceConnection(organizationId);

        const ACCOUNT_FIELDS = `
          Id, Name, Industry, Type, Website, Phone, Description,
          BillingCity, BillingState, BillingCountry,
          AnnualRevenue, NumberOfEmployees,
          OwnerId, Owner.Name, CreatedDate
        `.trim();

        // --- Duplicate check: upsert if account with same name exists ---
        const safeName = sanitizeSoql(accountName);
        const existingResult = await conn.query(
          `SELECT ${ACCOUNT_FIELDS} FROM Account WHERE Name = '${safeName}' ORDER BY CreatedDate DESC LIMIT 1`
        );

        if (existingResult.records?.length > 0) {
          const existing = existingResult.records[0] as Record<string, any>;
          log.info({ accountId: existing.Id }, 'Found existing account');

          // Build update payload from fields that differ from existing
          const updates: Record<string, any> = {};
          if (industry && industry !== existing.Industry) updates.Industry = industry;
          if (type && type !== existing.Type) updates.Type = type;
          if (website && website !== existing.Website) updates.Website = website;
          if (phone && phone !== existing.Phone) updates.Phone = phone;
          if (billingCity && billingCity !== existing.BillingCity) updates.BillingCity = billingCity;
          if (billingState && billingState !== existing.BillingState) updates.BillingState = billingState;
          if (billingCountry && billingCountry !== existing.BillingCountry) updates.BillingCountry = billingCountry;
          if (annualRevenue !== undefined && annualRevenue !== existing.AnnualRevenue) updates.AnnualRevenue = annualRevenue;
          if (numberOfEmployees !== undefined && numberOfEmployees !== existing.NumberOfEmployees) updates.NumberOfEmployees = numberOfEmployees;
          if (description && description !== existing.Description) {
            const tag = buildAttributionTag(actorEmail);
            updates.Description = description + (tag || '');
          }

          if (Object.keys(updates).length > 0) {
            await conn.sobject('Account').update({ Id: existing.Id, ...updates });
            const updatedResult = await conn.query(
              `SELECT ${ACCOUNT_FIELDS} FROM Account WHERE Id = '${sanitizeSoql(existing.Id)}' LIMIT 1`
            );
            const updated = updatedResult.records?.[0] as Record<string, any> | undefined;
            return JSON.stringify({
              _meta: { tool: 'sfdc_create_account' },
              message: `Account "${existing.Name}" already exists. Updated: ${Object.keys(updates).join(', ')}.`,
              accountId: existing.Id,
              result: updated || existing,
              alreadyExisted: true,
              updatedFields: Object.keys(updates),
            });
          }

          return JSON.stringify({
            _meta: { tool: 'sfdc_create_account' },
            message: `Account "${existing.Name}" already exists — no changes needed.`,
            accountId: existing.Id,
            result: existing,
            alreadyExisted: true,
          });
        }

        // --- Normal create flow ---
        const ownerId = await resolveSalesforceUserId(conn, organizationId, actorEmail);

        // Build account data with only provided fields
        const accountData: Record<string, any> = {
          Name: accountName,
        };

        if (ownerId) accountData.OwnerId = ownerId;
        if (industry) accountData.Industry = industry;
        if (type) accountData.Type = type;
        if (website) accountData.Website = website;
        if (phone) accountData.Phone = phone;
        if (billingCity) accountData.BillingCity = billingCity;
        if (billingState) accountData.BillingState = billingState;
        if (billingCountry) accountData.BillingCountry = billingCountry;
        if (annualRevenue !== undefined) accountData.AnnualRevenue = annualRevenue;
        if (numberOfEmployees !== undefined) accountData.NumberOfEmployees = numberOfEmployees;

        // Description + attribution tag
        if (description) accountData.Description = description;
        const tag = buildAttributionTag(actorEmail);
        if (tag) accountData.Description = (accountData.Description || '') + tag;

        let createResult = await conn.sobject('Account').create(accountData);

        // If OwnerId was rejected (permission issue), retry without attribution
        if (!createResult.success && ownerId && isOwnerIdError((createResult as any).errors)) {
          log.warn('OwnerId rejected, retrying without attribution');
          delete accountData.OwnerId;
          createResult = await conn.sobject('Account').create(accountData);
        }

        if (!createResult.success) {
          const errors = (createResult as any).errors?.map((e: any) =>
            typeof e === 'string' ? e : e.message || JSON.stringify(e)
          ).join(', ') || 'Unknown error';
          log.error({ errors }, 'Create failed');
          return JSON.stringify({
            _meta: { tool: 'sfdc_create_account' },
            error: `Failed to create account: ${errors}`,
          });
        }

        // Verify by re-querying the created record
        const verifyResult = await conn.query(
          `SELECT ${ACCOUNT_FIELDS} FROM Account WHERE Id = '${sanitizeSoql(createResult.id)}' LIMIT 1`
        );

        const verified = verifyResult.records?.[0] as Record<string, any> | undefined;

        if (!verified) {
          log.error({ accountId: createResult.id }, 'Created account but could not verify');
          return JSON.stringify({
            _meta: { tool: 'sfdc_create_account' },
            error: `Account creation was reported as successful (ID: ${createResult.id}) but could not be verified. Check Salesforce directly.`,
          });
        }

        log.info({ accountId: createResult.id }, 'Verified account');
        return JSON.stringify({
          _meta: { tool: 'sfdc_create_account' },
          message: `Successfully created account "${verified.Name}".`,
          accountId: createResult.id,
          result: verified,
        });
      } catch (err: any) {
        log.error({ err }, 'Error creating account');
        return JSON.stringify({
          _meta: { tool: 'sfdc_create_account' },
          error: err.message,
        });
      }
    },
  });
}
