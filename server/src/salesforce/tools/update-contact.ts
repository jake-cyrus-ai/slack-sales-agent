/**
 * Salesforce Update Contact Tool — update existing contact records.
 * Supports setting fields, clearing fields (set to null), and re-linking accounts.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSalesforceConnection } from '../client.js';
import { sanitizeSoql, buildAttributionTag } from '../utils.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'sfdc_update_contact' });

const CLEARABLE_FIELDS = [
  'email', 'phone', 'mobilePhone', 'title', 'department',
  'accountId', 'mailingCity', 'mailingState', 'mailingCountry',
  'leadSource', 'description',
] as const;

/** Map camelCase param names → Salesforce API field names. */
const FIELD_MAP: Record<string, string> = {
  firstName: 'FirstName',
  lastName: 'LastName',
  email: 'Email',
  phone: 'Phone',
  mobilePhone: 'MobilePhone',
  title: 'Title',
  department: 'Department',
  mailingCity: 'MailingCity',
  mailingState: 'MailingState',
  mailingCountry: 'MailingCountry',
  leadSource: 'LeadSource',
  description: 'Description',
};

const CONTACT_QUERY_FIELDS = `
  Id, Name, FirstName, LastName, Title, Email, Phone, MobilePhone,
  Department, MailingCity, MailingState, MailingCountry,
  AccountId, Account.Name, OwnerId, Owner.Name,
  LeadSource, Description, LastModifiedDate
`.trim();

async function resolveContactId(
  conn: any,
  contactId?: string,
  contactName?: string,
): Promise<{ id: string; record: Record<string, any> } | { error: string }> {
  if (contactId) {
    const safeId = sanitizeSoql(contactId);
    const result = await conn.query(`
      SELECT ${CONTACT_QUERY_FIELDS}
      FROM Contact WHERE Id = '${safeId}' LIMIT 1
    `);
    const record = result.records?.[0] as Record<string, any> | undefined;
    if (record) return { id: record.Id, record };
    log.warn({ contactId }, 'ID not found, falling back to name search');
  }

  if (!contactName) {
    return { error: `Contact ID "${contactId}" was not found in Salesforce and no contact name was provided to search by.` };
  }

  const safeName = sanitizeSoql(contactName);
  const result = await conn.query(`
    SELECT ${CONTACT_QUERY_FIELDS}
    FROM Contact
    WHERE Name LIKE '%${safeName}%'
    ORDER BY LastModifiedDate DESC LIMIT 5
  `);

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
    return null;
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

export function createSfdcUpdateContactTool(organizationId: string, actorEmail?: string | null) {
  return new DynamicStructuredTool({
    name: 'sfdc_update_contact',
    description:
      'Update an existing Contact in Salesforce. Can change name, email, phone, title, department, account link, mailing address, or description. Can also clear/remove fields. Provide the contact name (preferred) or ID.',
    schema: z.object({
      contactName: z.string().optional().describe('Contact name to search for (preferred — the tool resolves the correct ID from Salesforce)'),
      contactId: z.string().optional().describe('Salesforce Contact ID (if known from a previous tool call in this turn)'),
      firstName: z.string().optional().describe('New first name'),
      lastName: z.string().optional().describe('New last name'),
      email: z.string().optional().describe('New email address'),
      phone: z.string().optional().describe('New phone number'),
      mobilePhone: z.string().optional().describe('New mobile phone number'),
      title: z.string().optional().describe('New job title'),
      department: z.string().optional().describe('New department'),
      accountName: z.string().optional().describe('New account/company name to link (the tool resolves the ID)'),
      accountId: z.string().optional().describe('New Account ID to link (if known)'),
      mailingCity: z.string().optional().describe('New mailing city'),
      mailingState: z.string().optional().describe('New mailing state/province'),
      mailingCountry: z.string().optional().describe('New mailing country'),
      leadSource: z.string().optional().describe('New lead source'),
      description: z.string().optional().describe('New description/notes'),
      clearFields: z.array(z.enum(CLEARABLE_FIELDS)).optional()
        .describe('List of fields to clear/remove (set to blank). Use when the user wants to erase a field value.'),
    }),
    func: async (params) => {
      const {
        contactName, contactId,
        accountName, accountId: newAccountId,
        clearFields,
        firstName, lastName, email, phone, mobilePhone, title, department,
        mailingCity, mailingState, mailingCountry, leadSource, description,
      } = params;

      log.info({ contactName, contactId, clearFields }, 'Updating contact');

      if (!contactId && !contactName) {
        return JSON.stringify({
          _meta: { tool: 'sfdc_update_contact' },
          error: 'Provide at least contactName or contactId to identify which contact to update.',
        });
      }

      try {
        const conn = await getSalesforceConnection(organizationId);

        // Build updates from provided fields
        const updates: Record<string, any> = {};
        const fieldValues: Record<string, any> = {
          firstName, lastName, email, phone, mobilePhone, title, department,
          mailingCity, mailingState, mailingCountry, leadSource, description,
        };
        for (const [param, value] of Object.entries(fieldValues)) {
          if (value !== undefined && FIELD_MAP[param]) {
            updates[FIELD_MAP[param]] = value;
          }
        }

        // Handle clearFields — set to null (clearFields wins over set values)
        if (clearFields) {
          for (const field of clearFields) {
            const apiField = FIELD_MAP[field] || (field === 'accountId' ? 'AccountId' : undefined);
            if (apiField) updates[apiField] = null;
          }
        }

        // Resolve account if a new account link is provided (and not being cleared)
        if ((newAccountId || accountName) && !clearFields?.includes('accountId')) {
          const resolvedAccount = await resolveAccountId(conn, newAccountId, accountName);
          if (resolvedAccount) {
            if ('error' in resolvedAccount) {
              return JSON.stringify({ _meta: { tool: 'sfdc_update_contact' }, error: resolvedAccount.error });
            }
            updates.AccountId = resolvedAccount.id;
          }
        }

        if (Object.keys(updates).length === 0) {
          return JSON.stringify({
            _meta: { tool: 'sfdc_update_contact', contactId, contactName },
            error: 'No fields to update. Provide at least one field to change or use clearFields to remove a field value.',
          });
        }

        const resolved = await resolveContactId(conn, contactId, contactName);
        if ('error' in resolved) {
          return JSON.stringify({
            _meta: { tool: 'sfdc_update_contact', contactId, contactName },
            error: resolved.error,
          });
        }

        const { id: resolvedId, record: beforeUpdate } = resolved;
        log.info({ contactId: resolvedId, contactName: beforeUpdate.Name }, 'Resolved contact');

        // Attribution tag on description (only if description is being set, not cleared)
        const tag = buildAttributionTag(actorEmail);
        if (tag && updates.Description !== undefined && updates.Description !== null) {
          updates.Description = updates.Description + tag;
        }

        const updateResult = await conn.sobject('Contact').update({ Id: resolvedId, ...updates });

        if (!updateResult.success) {
          const errors = (updateResult as any).errors?.map((e: any) =>
            typeof e === 'string' ? e : e.message || JSON.stringify(e)
          ).join(', ') || 'Unknown error';
          log.error({ errors }, 'Update failed');
          return JSON.stringify({
            _meta: { tool: 'sfdc_update_contact', contactId: resolvedId },
            error: `Failed to update contact "${beforeUpdate.Name}": ${errors}`,
          });
        }

        // Verify by re-querying
        const verifyResult = await conn.query(`
          SELECT ${CONTACT_QUERY_FIELDS}
          FROM Contact WHERE Id = '${resolvedId}' LIMIT 1
        `);

        const afterUpdate = verifyResult.records?.[0] as Record<string, any> | undefined;

        if (!afterUpdate) {
          return JSON.stringify({
            _meta: { tool: 'sfdc_update_contact', contactId: resolvedId },
            error: 'Update was reported as successful but the contact could not be re-fetched. Verify manually in Salesforce.',
          });
        }

        // Verify changes
        const mismatches: string[] = [];
        for (const [apiField, value] of Object.entries(updates)) {
          const actual = afterUpdate[apiField];
          if (value === null) {
            if (actual != null && actual !== '') mismatches.push(`${apiField}: expected cleared, got "${actual}"`);
          } else {
            const matches = (actual == null ? '' : String(actual)) === String(value);
            if (!matches) mismatches.push(`${apiField}: expected "${value}", got "${actual}"`);
          }
        }

        if (mismatches.length > 0) {
          log.error({ mismatches }, 'Verification failed');
          return JSON.stringify({
            _meta: { tool: 'sfdc_update_contact', contactId: resolvedId },
            error: `Update may not have persisted. Verification mismatches: ${mismatches.join('; ')}. Check Salesforce directly.`,
            result: afterUpdate,
          });
        }

        log.info({ contactName: afterUpdate.Name }, 'Verified update');
        return JSON.stringify({
          _meta: { tool: 'sfdc_update_contact', contactId: resolvedId },
          message: `Successfully updated contact "${afterUpdate.Name}".`,
          updatedFields: Object.keys(updates),
          before: Object.fromEntries(Object.keys(updates).map((f) => [f, beforeUpdate[f]])),
          result: afterUpdate,
        });
      } catch (err: any) {
        log.error({ err }, 'Error updating contact');
        return JSON.stringify({
          _meta: { tool: 'sfdc_update_contact', contactId, contactName },
          error: err.message,
        });
      }
    },
  });
}
