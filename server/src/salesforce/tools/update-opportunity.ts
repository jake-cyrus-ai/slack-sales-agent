/**
 * Salesforce Update Opportunity Tool — update deal stage, amount, close date, etc.
 * Accepts either an Opportunity ID or name; resolves names to IDs via SOQL.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSalesforceConnection } from '../client.js';
import { sanitizeSoql, buildAttributionTag } from '../utils.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'sfdc_update_opportunity' });

async function resolveOpportunityId(
  conn: any,
  opportunityId?: string,
  opportunityName?: string,
): Promise<{ id: string; record: Record<string, any> } | { error: string }> {
  if (opportunityId) {
    const safeId = sanitizeSoql(opportunityId);
    const result = await conn.query(`
      SELECT Id, Name, StageName, Amount, CloseDate, Probability,
             NextStep, Owner.Name, LastModifiedDate
      FROM Opportunity WHERE Id = '${safeId}' LIMIT 1
    `);
    const record = result.records?.[0] as Record<string, any> | undefined;
    if (record) return { id: record.Id, record };
    log.warn({ opportunityId }, 'ID not found, falling back to name search');
  }

  if (!opportunityName) {
    return { error: `Opportunity ID "${opportunityId}" was not found in Salesforce and no opportunity name was provided to search by.` };
  }

  const safeName = sanitizeSoql(opportunityName);
  const result = await conn.query(`
    SELECT Id, Name, StageName, Amount, CloseDate, Probability,
           NextStep, Owner.Name, LastModifiedDate
    FROM Opportunity
    WHERE Name LIKE '%${safeName}%' AND IsClosed = false
    ORDER BY LastModifiedDate DESC LIMIT 5
  `);

  const records = result.records as Record<string, any>[] | undefined;
  if (!records || records.length === 0) {
    return { error: `No open opportunities found matching "${opportunityName}".` };
  }

  if (records.length > 1) {
    const options = records.map((r) =>
      `• ${r.Name} (ID: ${r.Id}) — Stage: ${r.StageName}, Amount: ${r.Amount}, Close: ${r.CloseDate}`
    ).join('\n');
    return { error: `Multiple opportunities match "${opportunityName}". Ask the user which one:\n${options}` };
  }

  return { id: records[0].Id, record: records[0] };
}

export function createSfdcUpdateOpportunityTool(organizationId: string, actorEmail?: string | null) {
  return new DynamicStructuredTool({
    name: 'sfdc_update_opportunity',
    description:
      'Update an existing Salesforce Opportunity. Can change stage, amount, close date, next step, description, or probability. Can also clear/remove fields. Provide the opportunity name (preferred) or ID. Use when the user wants to move a deal forward, update forecasts, or record deal changes.',
    schema: z.object({
      opportunityName: z.string().optional().describe('Opportunity name to search for (preferred — the tool resolves the correct ID from Salesforce)'),
      opportunityId: z.string().optional().describe('Salesforce Opportunity ID (if known from a previous tool call in this turn)'),
      stageName: z.string().optional().describe('New stage name (e.g. "Qualification", "Proposal", "Negotiation", "Closed Won")'),
      amount: z.number().optional().describe('New deal amount in dollars'),
      closeDate: z.string().optional().describe('New expected close date (YYYY-MM-DD format)'),
      nextStep: z.string().optional().describe('Next step description'),
      description: z.string().optional().describe('Updated opportunity description'),
      probability: z.number().optional().describe('Win probability percentage (0-100)'),
      clearFields: z.array(z.enum(['amount', 'probability', 'nextStep', 'description'])).optional()
        .describe('List of fields to clear/remove (set to blank). Use when the user wants to erase a field value.'),
    }),
    func: async ({ opportunityName, opportunityId, stageName, amount, closeDate, nextStep, description, probability, clearFields }) => {
      log.info({ opportunityName, opportunityId, stageName, amount, closeDate }, 'Updating opportunity');

      if (!opportunityId && !opportunityName) {
        return JSON.stringify({
          _meta: { tool: 'sfdc_update_opportunity' },
          error: 'Provide at least opportunityName or opportunityId to identify which deal to update.',
        });
      }

      const updates: Record<string, any> = {};
      if (stageName !== undefined) updates.StageName = stageName;
      if (amount !== undefined) updates.Amount = amount;
      if (closeDate !== undefined) updates.CloseDate = closeDate;
      if (nextStep !== undefined) updates.NextStep = nextStep;
      if (description !== undefined) updates.Description = description;
      if (probability !== undefined) updates.Probability = probability;

      // Handle clearFields — set to null (clearFields wins over set values)
      const clearFieldMap: Record<string, string> = {
        amount: 'Amount', probability: 'Probability', nextStep: 'NextStep', description: 'Description',
      };
      if (clearFields) {
        for (const field of clearFields) {
          const apiField = clearFieldMap[field];
          if (apiField) updates[apiField] = null;
        }
      }

      if (Object.keys(updates).length === 0) {
        return JSON.stringify({
          _meta: { tool: 'sfdc_update_opportunity', opportunityId, opportunityName },
          error: 'No fields to update. Provide at least one field to change or use clearFields to remove a field value.',
        });
      }

      try {
        const conn = await getSalesforceConnection(organizationId);

        const resolved = await resolveOpportunityId(conn, opportunityId, opportunityName);
        if ('error' in resolved) {
          return JSON.stringify({
            _meta: { tool: 'sfdc_update_opportunity', opportunityId, opportunityName },
            error: resolved.error,
          });
        }

        const { id: resolvedId, record: beforeUpdate } = resolved;
        log.info({ opportunityId: resolvedId, opportunityName: beforeUpdate.Name }, 'Resolved opportunity');

        const tag = buildAttributionTag(actorEmail);
        if (tag && updates.Description !== undefined && updates.Description !== null) {
          updates.Description = updates.Description + tag;
        }

        const updateResult = await conn.sobject('Opportunity').update({ Id: resolvedId, ...updates });

        if (!updateResult.success) {
          const errors = (updateResult as any).errors?.map((e: any) =>
            typeof e === 'string' ? e : e.message || JSON.stringify(e)
          ).join(', ') || 'Unknown error';
          log.error({ errors }, 'Update failed');
          return JSON.stringify({
            _meta: { tool: 'sfdc_update_opportunity', opportunityId: resolvedId },
            error: `Failed to update opportunity "${beforeUpdate.Name}": ${errors}`,
          });
        }

        const verifyResult = await conn.query(`
          SELECT Id, Name, StageName, Amount, CloseDate, Probability,
                 NextStep, Owner.Name, LastModifiedDate
          FROM Opportunity WHERE Id = '${resolvedId}' LIMIT 1
        `);

        const afterUpdate = verifyResult.records?.[0] as Record<string, any> | undefined;

        if (!afterUpdate) {
          return JSON.stringify({
            _meta: { tool: 'sfdc_update_opportunity', opportunityId: resolvedId },
            error: `Update was reported as successful but the opportunity could not be re-fetched. Verify manually in Salesforce.`,
          });
        }

        const NUMERIC_FIELDS = new Set(['Amount', 'Probability']);
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
            _meta: { tool: 'sfdc_update_opportunity', opportunityId: resolvedId },
            error: `Update may not have persisted. Verification mismatches: ${mismatches.join('; ')}. Check Salesforce directly.`,
            result: afterUpdate,
          });
        }

        log.info({ opportunityName: afterUpdate.Name }, 'Verified update');
        return JSON.stringify({
          _meta: { tool: 'sfdc_update_opportunity', opportunityId: resolvedId },
          message: `Successfully updated opportunity "${afterUpdate.Name}".`,
          updatedFields: Object.keys(updates),
          before: Object.fromEntries(Object.keys(updates).map((f) => [f, beforeUpdate[f]])),
          result: afterUpdate,
        });
      } catch (err: any) {
        log.error({ err }, 'Error updating opportunity');
        return JSON.stringify({
          _meta: { tool: 'sfdc_update_opportunity', opportunityId, opportunityName },
          error: err.message,
        });
      }
    },
  });
}
