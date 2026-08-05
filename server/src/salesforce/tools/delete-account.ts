/**
 * Salesforce Delete Account Tool — permanently remove an account record.
 * Resolves by name or ID, captures a snapshot, then deletes.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSalesforceConnection } from '../client.js';
import { sanitizeSoql } from '../utils.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'sfdc_delete_account' });

const ACCOUNT_QUERY_FIELDS = `
  Id, Name, Industry, Type, Website, Phone,
  OwnerId, Owner.Name, CreatedDate
`.trim();

async function resolveAccountRecord(
  conn: any,
  accountId?: string,
  accountName?: string,
): Promise<{ id: string; record: Record<string, any> } | { error: string }> {
  if (accountId) {
    const safeId = sanitizeSoql(accountId);
    const result = await conn.query(
      `SELECT ${ACCOUNT_QUERY_FIELDS} FROM Account WHERE Id = '${safeId}' LIMIT 1`
    );
    const record = result.records?.[0] as Record<string, any> | undefined;
    if (record) return { id: record.Id, record };
    log.warn({ accountId }, 'ID not found, falling back to name search');
  }

  if (!accountName) {
    return { error: `Account ID "${accountId}" was not found in Salesforce and no account name was provided to search by.` };
  }

  const safeName = sanitizeSoql(accountName);
  const result = await conn.query(
    `SELECT ${ACCOUNT_QUERY_FIELDS} FROM Account WHERE Name LIKE '%${safeName}%' ORDER BY LastModifiedDate DESC LIMIT 5`
  );

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

export function createSfdcDeleteAccountTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'sfdc_delete_account',
    description:
      'Permanently delete an Account (company) from Salesforce. This action cannot be undone. Provide the account name (preferred) or ID. Use only when the user explicitly asks to delete an account.',
    schema: z.object({
      accountName: z.string().optional().describe('Account name to search for (preferred — the tool resolves the correct ID from Salesforce)'),
      accountId: z.string().optional().describe('Salesforce Account ID (if known from a previous tool call in this turn)'),
    }),
    func: async ({ accountName, accountId }) => {
      log.info({ accountName, accountId }, 'Deleting account');

      if (!accountId && !accountName) {
        return JSON.stringify({
          _meta: { tool: 'sfdc_delete_account' },
          error: 'Provide at least accountName or accountId to identify which account to delete.',
        });
      }

      try {
        const conn = await getSalesforceConnection(organizationId);

        const resolved = await resolveAccountRecord(conn, accountId, accountName);
        if ('error' in resolved) {
          return JSON.stringify({
            _meta: { tool: 'sfdc_delete_account', accountId, accountName },
            error: resolved.error,
          });
        }

        const { id: resolvedId, record: snapshot } = resolved;
        log.info({ accountId: resolvedId, accountName: snapshot.Name }, 'Resolved account');

        const deleteResult = await conn.sobject('Account').destroy(resolvedId);

        if (!deleteResult.success) {
          const errors = (deleteResult as any).errors?.map((e: any) =>
            typeof e === 'string' ? e : e.message || JSON.stringify(e)
          ).join(', ') || 'Unknown error';
          log.error({ errors }, 'Delete failed');
          return JSON.stringify({
            _meta: { tool: 'sfdc_delete_account', accountId: resolvedId },
            error: `Failed to delete account "${snapshot.Name}": ${errors}`,
          });
        }

        // Verify deletion
        const verifyResult = await conn.query(
          `SELECT Id FROM Account WHERE Id = '${sanitizeSoql(resolvedId)}' LIMIT 1`
        );

        if (verifyResult.records?.length > 0) {
          log.error({ accountId: resolvedId }, 'Record still exists after deletion');
          return JSON.stringify({
            _meta: { tool: 'sfdc_delete_account', accountId: resolvedId },
            error: `Deletion was reported as successful but the account still exists. It may be in the Salesforce recycle bin or protected by a deletion rule.`,
          });
        }

        log.info({ accountId: resolvedId }, 'Verified deletion');
        return JSON.stringify({
          _meta: { tool: 'sfdc_delete_account', accountId: resolvedId },
          message: `Successfully deleted account "${snapshot.Name}".`,
          deletedRecord: snapshot,
        });
      } catch (err: any) {
        log.error({ err }, 'Error deleting account');
        return JSON.stringify({
          _meta: { tool: 'sfdc_delete_account', accountId, accountName },
          error: err.message,
        });
      }
    },
  });
}
