/**
 * Salesforce Delete Contact Tool — permanently remove a contact record.
 * Resolves by name or ID, captures a snapshot, then deletes.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSalesforceConnection } from '../client.js';
import { sanitizeSoql } from '../utils.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'sfdc_delete_contact' });

const CONTACT_QUERY_FIELDS = `
  Id, Name, FirstName, LastName, Title, Email,
  AccountId, Account.Name, OwnerId, Owner.Name, CreatedDate
`.trim();

async function resolveContactRecord(
  conn: any,
  contactId?: string,
  contactName?: string,
): Promise<{ id: string; record: Record<string, any> } | { error: string }> {
  if (contactId) {
    const safeId = sanitizeSoql(contactId);
    const result = await conn.query(
      `SELECT ${CONTACT_QUERY_FIELDS} FROM Contact WHERE Id = '${safeId}' LIMIT 1`
    );
    const record = result.records?.[0] as Record<string, any> | undefined;
    if (record) return { id: record.Id, record };
    log.warn({ contactId }, 'ID not found, falling back to name search');
  }

  if (!contactName) {
    return { error: `Contact ID "${contactId}" was not found in Salesforce and no contact name was provided to search by.` };
  }

  const safeName = sanitizeSoql(contactName);
  const result = await conn.query(
    `SELECT ${CONTACT_QUERY_FIELDS} FROM Contact WHERE Name LIKE '%${safeName}%' ORDER BY LastModifiedDate DESC LIMIT 5`
  );

  const records = result.records as Record<string, any>[] | undefined;
  if (!records || records.length === 0) {
    return { error: `No contacts found matching "${contactName}".` };
  }

  if (records.length > 1) {
    const options = records.map((r) =>
      `• ${r.Name} (ID: ${r.Id}) — ${r.Title || 'No title'}, ${r.Email || 'No email'}${r.Account?.Name ? `, ${r.Account.Name}` : ''}`
    ).join('\n');
    return { error: `Multiple contacts match "${contactName}". Ask the user which one:\n${options}` };
  }

  return { id: records[0].Id, record: records[0] };
}

export function createSfdcDeleteContactTool(organizationId: string) {
  return new DynamicStructuredTool({
    name: 'sfdc_delete_contact',
    description:
      'Permanently delete a Contact (person) from Salesforce. This action cannot be undone. Provide the contact name (preferred) or ID. Use only when the user explicitly asks to delete a contact.',
    schema: z.object({
      contactName: z.string().optional().describe('Contact name to search for (preferred — the tool resolves the correct ID from Salesforce)'),
      contactId: z.string().optional().describe('Salesforce Contact ID (if known from a previous tool call in this turn)'),
    }),
    func: async ({ contactName, contactId }) => {
      log.info({ contactName, contactId }, 'Deleting contact');

      if (!contactId && !contactName) {
        return JSON.stringify({
          _meta: { tool: 'sfdc_delete_contact' },
          error: 'Provide at least contactName or contactId to identify which contact to delete.',
        });
      }

      try {
        const conn = await getSalesforceConnection(organizationId);

        const resolved = await resolveContactRecord(conn, contactId, contactName);
        if ('error' in resolved) {
          return JSON.stringify({
            _meta: { tool: 'sfdc_delete_contact', contactId, contactName },
            error: resolved.error,
          });
        }

        const { id: resolvedId, record: snapshot } = resolved;
        log.info({ contactId: resolvedId, contactName: snapshot.Name }, 'Resolved contact');

        const deleteResult = await conn.sobject('Contact').destroy(resolvedId);

        if (!deleteResult.success) {
          const errors = (deleteResult as any).errors?.map((e: any) =>
            typeof e === 'string' ? e : e.message || JSON.stringify(e)
          ).join(', ') || 'Unknown error';
          log.error({ errors }, 'Delete failed');
          return JSON.stringify({
            _meta: { tool: 'sfdc_delete_contact', contactId: resolvedId },
            error: `Failed to delete contact "${snapshot.Name}": ${errors}`,
          });
        }

        // Verify deletion
        const verifyResult = await conn.query(
          `SELECT Id FROM Contact WHERE Id = '${sanitizeSoql(resolvedId)}' LIMIT 1`
        );

        if (verifyResult.records?.length > 0) {
          log.error({ contactId: resolvedId }, 'Record still exists after deletion');
          return JSON.stringify({
            _meta: { tool: 'sfdc_delete_contact', contactId: resolvedId },
            error: `Deletion was reported as successful but the contact still exists. It may be in the Salesforce recycle bin or protected by a deletion rule.`,
          });
        }

        log.info({ contactId: resolvedId }, 'Verified deletion');
        return JSON.stringify({
          _meta: { tool: 'sfdc_delete_contact', contactId: resolvedId },
          message: `Successfully deleted contact "${snapshot.Name}".`,
          deletedRecord: snapshot,
        });
      } catch (err: any) {
        log.error({ err }, 'Error deleting contact');
        return JSON.stringify({
          _meta: { tool: 'sfdc_delete_contact', contactId, contactName },
          error: err.message,
        });
      }
    },
  });
}
