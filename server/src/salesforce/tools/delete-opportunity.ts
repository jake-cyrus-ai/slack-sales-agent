/**
 * Salesforce Delete Opportunity Tool — permanently remove an opportunity record.
 * Resolves by name or ID, captures a snapshot, then deletes.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSalesforceConnection } from '../client.js';
import { sanitizeSoql } from '../utils.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'sfdc_delete_opportunity' });

const OPP_QUERY_FIELDS = `
  Id, Name, StageName, Amount, CloseDate,
  AccountId, Account.Name, OwnerId, Owner.Name, CreatedDate
`.trim();

async function resolveOpportunityRecord(
  conn: any,
  opportunityId?: string,
  opportunityName?: string,
): Promise<{ id: string; record: Record<string, any> } | { error: string }> {
  if (opportunityId) {
    const safeId = sanitizeSoql(opportunityId);
    const result = await conn.query(
      `SELECT ${OPP_QUERY_FIELDS} FROM Opportunity WHERE Id = '${safeId}' LIMIT 1`
    );
    const record = result.records?.[0] as Record<string, any> | undefined;
    if (record) return { id: record.Id, record };
    log.warn({ opportunityId }, 'ID not found, falling back to name search');
  }

  if (!opportunityName) {
    return { error: `Opportunity ID "${opportunityId}" was not found in Salesforce and no opportunity name was provided to search by.` };
  }

  const safeName = sanitizeSoql(opportunityName);
  const result = await conn.query(
    `SELECT ${OPP_QUERY_FIELDS} FROM Opportunity WHERE Name LIKE '%${safeName}%' ORDER BY LastModifiedDate DESC LIMIT 5`
  );

  const records = result.records as Record<string, any>[] | undefined;
  if (!records || records.length === 0) {
    return { error: `No opportunities found matching "${opportunityName}".` };
  }

  if (records.length > 1) {
    const options = records.map((r) =>
      `• ${r.Name} (ID: ${r.Id}) — Stage: ${r.StageName}, Amount: ${r.Amount}, Close: ${r.CloseDate}`
    ).join('\n');
    return { error: `Multiple opportunities match "${opportunityName}". Ask the user which one:\n${options}` };
  }

  return { id: records[0].Id, record: records[0] };
}

export function createSfdcDeleteOpportunityTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'sfdc_delete_opportunity',
    description:
      'Permanently delete an Opportunity (deal) from Salesforce. This action cannot be undone. Provide the opportunity name (preferred) or ID. Use only when the user explicitly asks to delete an opportunity.',
    schema: z.object({
      opportunityName: z.string().optional().describe('Opportunity name to search for (preferred — the tool resolves the correct ID from Salesforce)'),
      opportunityId: z.string().optional().describe('Salesforce Opportunity ID (if known from a previous tool call in this turn)'),
    }),
    func: async ({ opportunityName, opportunityId }) => {
      log.info({ opportunityName, opportunityId }, 'Deleting opportunity');

      if (!opportunityId && !opportunityName) {
        return JSON.stringify({
          _meta: { tool: 'sfdc_delete_opportunity' },
          error: 'Provide at least opportunityName or opportunityId to identify which opportunity to delete.',
        });
      }

      try {
        const conn = await getSalesforceConnection(organizationId);

        const resolved = await resolveOpportunityRecord(conn, opportunityId, opportunityName);
        if ('error' in resolved) {
          return JSON.stringify({
            _meta: { tool: 'sfdc_delete_opportunity', opportunityId, opportunityName },
            error: resolved.error,
          });
        }

        const { id: resolvedId, record: snapshot } = resolved;
        log.info({ opportunityId: resolvedId, opportunityName: snapshot.Name }, 'Resolved opportunity');

        const deleteResult = await conn.sobject('Opportunity').destroy(resolvedId);

        if (!deleteResult.success) {
          const errors = (deleteResult as any).errors?.map((e: any) =>
            typeof e === 'string' ? e : e.message || JSON.stringify(e)
          ).join(', ') || 'Unknown error';
          log.error({ errors }, 'Delete failed');
          return JSON.stringify({
            _meta: { tool: 'sfdc_delete_opportunity', opportunityId: resolvedId },
            error: `Failed to delete opportunity "${snapshot.Name}": ${errors}`,
          });
        }

        // Verify deletion
        const verifyResult = await conn.query(
          `SELECT Id FROM Opportunity WHERE Id = '${sanitizeSoql(resolvedId)}' LIMIT 1`
        );

        if (verifyResult.records?.length > 0) {
          log.error({ opportunityId: resolvedId }, 'Record still exists after deletion');
          return JSON.stringify({
            _meta: { tool: 'sfdc_delete_opportunity', opportunityId: resolvedId },
            error: `Deletion was reported as successful but the opportunity still exists. It may be in the Salesforce recycle bin or protected by a deletion rule.`,
          });
        }

        log.info({ opportunityId: resolvedId }, 'Verified deletion');
        return JSON.stringify({
          _meta: { tool: 'sfdc_delete_opportunity', opportunityId: resolvedId },
          message: `Successfully deleted opportunity "${snapshot.Name}".`,
          deletedRecord: snapshot,
        });
      } catch (err: any) {
        log.error({ err }, 'Error deleting opportunity');
        return JSON.stringify({
          _meta: { tool: 'sfdc_delete_opportunity', opportunityId, opportunityName },
          error: err.message,
        });
      }
    },
  });
}
