/**
 * Salesforce Create Opportunity Tool — upsert deals linked to accounts.
 * If an open opportunity with the same name (and account) already exists,
 * updates it with any new field values instead of creating a duplicate.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSalesforceConnection } from '../client.js';
import { sanitizeSoql, resolveSalesforceUserId, buildAttributionTag, isOwnerIdError } from '../utils.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'sfdc_create_opportunity' });

async function resolveAccountId(
  conn: any,
  accountId?: string,
  accountName?: string,
): Promise<{ id: string } | { error: string } | null> {
  if (accountId) {
    const safeId = sanitizeSoql(accountId);
    const result = await conn.query(`
      SELECT Id, Name FROM Account WHERE Id = '${safeId}' LIMIT 1
    `);
    if (result.records?.[0]) return { id: result.records[0].Id };
    log.warn({ accountId }, 'Account ID not found, falling back to name search');
  }

  if (!accountName) {
    if (accountId) {
      return { error: `Account ID "${accountId}" was not found in Salesforce and no account name was provided.` };
    }
    return null; // No account specified — that's OK, it's optional
  }

  const safeName = sanitizeSoql(accountName);
  const result = await conn.query(`
    SELECT Id, Name FROM Account
    WHERE Name LIKE '%${safeName}%'
    ORDER BY LastModifiedDate DESC LIMIT 5
  `);

  const records = result.records as Record<string, any>[] | undefined;
  if (!records || records.length === 0) {
    return { error: `No accounts found matching "${accountName}".` };
  }

  if (records.length > 1) {
    const options = records.map((r: any) => `• ${r.Name} (ID: ${r.Id})`).join('\n');
    return { error: `Multiple accounts match "${accountName}". Ask the user which one:\n${options}` };
  }

  return { id: records[0].Id };
}

export function createSfdcCreateOpportunityTool(organizationId: string, actorEmail?: string | null) {
  return new DynamicStructuredTool({
    name: 'sfdc_create_opportunity',
    description:
      'Create a new Opportunity (deal) in Salesforce. Can optionally link to an Account. Use when the user wants to create a new deal, add a new opportunity to the pipeline, or start tracking a potential sale.',
    schema: z.object({
      opportunityName: z.string().describe('Name for the opportunity/deal (e.g. "Acme Corp - Enterprise License")'),
      stageName: z.string().describe('Initial stage (e.g. "Qualification", "Prospecting", "Proposal", "Negotiation")'),
      closeDate: z.string().describe('Expected close date in YYYY-MM-DD format'),
      accountName: z.string().optional().describe('Account/company name to link (preferred — the tool resolves the ID)'),
      accountId: z.string().optional().describe('Account ID (if known from a previous tool call in this turn)'),
      amount: z.number().optional().describe('Deal amount in dollars'),
      probability: z.number().optional().describe('Win probability percentage (0-100)'),
      nextStep: z.string().optional().describe('Next step description'),
      description: z.string().optional().describe('Detailed opportunity description'),
      type: z.string().optional().describe('Opportunity type (e.g. "New Customer", "Existing Business")'),
      leadSource: z.string().optional().describe('Lead source (e.g. "Web", "Referral", "Partner")'),
    }),
    func: async ({ opportunityName, stageName, closeDate, accountName, accountId, amount, probability, nextStep, description, type, leadSource }) => {
      log.info({ opportunityName, stageName, closeDate, accountName, accountId }, 'Creating opportunity');

      try {
        const conn = await getSalesforceConnection(organizationId);

        const OPP_FIELDS = `
          Id, Name, AccountId, Account.Name, StageName, Amount,
          CloseDate, Probability, NextStep, Description, Type,
          LeadSource, OwnerId, Owner.Name, CreatedDate
        `.trim();

        // Resolve account if provided
        const resolvedAccount = await resolveAccountId(conn, accountId, accountName);
        if (resolvedAccount && 'error' in resolvedAccount) {
          return JSON.stringify({
            _meta: { tool: 'sfdc_create_opportunity' },
            error: resolvedAccount.error,
          });
        }

        // --- Duplicate check: only run dedup when scoped to an account.
        // Without an account, opp names like "Q4 Renewal" collide across customers,
        // so the upsert branch could silently overwrite an unrelated deal.
        const resolvedAccountId = resolvedAccount && 'id' in resolvedAccount ? resolvedAccount.id : null;
        const safeOppName = sanitizeSoql(opportunityName);
        const existingResult = resolvedAccountId
          ? await conn.query(
              `SELECT ${OPP_FIELDS} FROM Opportunity WHERE Name = '${safeOppName}' AND AccountId = '${sanitizeSoql(resolvedAccountId)}' AND IsClosed = false ORDER BY CreatedDate DESC LIMIT 1`
            )
          : { records: [] as Record<string, any>[] };

        if (existingResult.records?.length > 0) {
          const existing = existingResult.records[0] as Record<string, any>;
          log.info({ opportunityId: existing.Id }, 'Found existing opportunity');

          const updates: Record<string, any> = {};
          if (stageName && stageName !== existing.StageName) updates.StageName = stageName;
          if (closeDate && closeDate !== existing.CloseDate) updates.CloseDate = closeDate;
          if (amount !== undefined && amount !== existing.Amount) updates.Amount = amount;
          if (probability !== undefined && probability !== existing.Probability) updates.Probability = probability;
          if (nextStep && nextStep !== existing.NextStep) updates.NextStep = nextStep;
          if (type && type !== existing.Type) updates.Type = type;
          if (leadSource && leadSource !== existing.LeadSource) updates.LeadSource = leadSource;
          if (description && description !== existing.Description) {
            const tag = buildAttributionTag(actorEmail);
            updates.Description = description + (tag || '');
          }

          if (Object.keys(updates).length > 0) {
            await conn.sobject('Opportunity').update({ Id: existing.Id, ...updates });
            const updatedResult = await conn.query(
              `SELECT ${OPP_FIELDS} FROM Opportunity WHERE Id = '${sanitizeSoql(existing.Id)}' LIMIT 1`
            );
            const updated = updatedResult.records?.[0] as Record<string, any> | undefined;
            return JSON.stringify({
              _meta: { tool: 'sfdc_create_opportunity' },
              message: `Opportunity "${existing.Name}" already exists. Updated: ${Object.keys(updates).join(', ')}.`,
              opportunityId: existing.Id,
              result: updated || existing,
              alreadyExisted: true,
              updatedFields: Object.keys(updates),
            });
          }

          return JSON.stringify({
            _meta: { tool: 'sfdc_create_opportunity' },
            message: `Opportunity "${existing.Name}" already exists — no changes needed.`,
            opportunityId: existing.Id,
            result: existing,
            alreadyExisted: true,
          });
        }

        // --- Normal create flow ---
        const ownerId = await resolveSalesforceUserId(conn, organizationId, actorEmail);

        // Build the opportunity data
        const oppData: Record<string, any> = {
          Name: opportunityName,
          StageName: stageName,
          CloseDate: closeDate,
        };

        if (ownerId) oppData.OwnerId = ownerId;
        if (resolvedAccountId) oppData.AccountId = resolvedAccountId;
        if (amount !== undefined) oppData.Amount = amount;
        if (probability !== undefined) oppData.Probability = probability;
        if (nextStep) oppData.NextStep = nextStep;
        if (description) oppData.Description = description;
        if (type) oppData.Type = type;
        if (leadSource) oppData.LeadSource = leadSource;
        const tag = buildAttributionTag(actorEmail);
        if (tag) oppData.Description = (oppData.Description || '') + tag;

        let createResult = await conn.sobject('Opportunity').create(oppData);

        // If OwnerId was rejected (permission issue), retry without attribution
        if (!createResult.success && ownerId && isOwnerIdError((createResult as any).errors)) {
          log.warn('OwnerId rejected, retrying without attribution');
          delete oppData.OwnerId;
          createResult = await conn.sobject('Opportunity').create(oppData);
        }

        if (!createResult.success) {
          const errors = (createResult as any).errors?.map((e: any) =>
            typeof e === 'string' ? e : e.message || JSON.stringify(e)
          ).join(', ') || 'Unknown error';
          log.error({ errors }, 'Create failed');
          return JSON.stringify({
            _meta: { tool: 'sfdc_create_opportunity' },
            error: `Failed to create opportunity: ${errors}`,
          });
        }

        // Verify by re-querying the created record
        const verifyResult = await conn.query(
          `SELECT ${OPP_FIELDS} FROM Opportunity WHERE Id = '${sanitizeSoql(createResult.id)}' LIMIT 1`
        );

        const verified = verifyResult.records?.[0] as Record<string, any> | undefined;

        if (!verified) {
          log.error({ opportunityId: createResult.id }, 'Created opportunity but could not verify');
          return JSON.stringify({
            _meta: { tool: 'sfdc_create_opportunity' },
            error: `Opportunity creation was reported as successful (ID: ${createResult.id}) but could not be verified. Check Salesforce directly.`,
          });
        }

        log.info({ opportunityId: createResult.id }, 'Verified opportunity');
        return JSON.stringify({
          _meta: { tool: 'sfdc_create_opportunity' },
          message: `Successfully created opportunity "${verified.Name}".`,
          opportunityId: createResult.id,
          result: verified,
        });
      } catch (err: any) {
        log.error({ err }, 'Error creating opportunity');
        return JSON.stringify({
          _meta: { tool: 'sfdc_create_opportunity' },
          error: err.message,
        });
      }
    },
  });
}
