/**
 * Salesforce Create Contact Tool — upsert person/contact records linked to accounts.
 * If a contact with the same name (and email or account) already exists, updates it
 * with any new field values instead of creating a duplicate.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSalesforceConnection } from '../client.js';
import { sanitizeSoql, resolveSalesforceUserId, buildAttributionTag, isOwnerIdError } from '../utils.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ tool: 'sfdc_create_contact' });

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

export function createSfdcCreateContactTool(organizationId: string, actorEmail?: string | null) {
  return new DynamicStructuredTool({
    name: 'sfdc_create_contact',
    description:
      'Create a new Contact (person) in Salesforce. Can optionally link to an Account. Use when the user wants to add a new person to the CRM, create a contact for a prospect or stakeholder, or record a person met at a meeting.',
    schema: z.object({
      firstName: z.string().describe('Contact first name'),
      lastName: z.string().describe('Contact last name'),
      email: z.string().optional().describe('Email address'),
      phone: z.string().optional().describe('Phone number'),
      mobilePhone: z.string().optional().describe('Mobile phone number'),
      title: z.string().optional().describe('Job title (e.g. "CEO", "VP Sales", "CTO")'),
      department: z.string().optional().describe('Department (e.g. "Engineering", "Sales", "Marketing")'),
      accountName: z.string().optional().describe('Account/company name to link (preferred — the tool resolves the ID)'),
      accountId: z.string().optional().describe('Account ID (if known from a previous tool call in this turn)'),
      mailingCity: z.string().optional().describe('Mailing city'),
      mailingState: z.string().optional().describe('Mailing state/province'),
      mailingCountry: z.string().optional().describe('Mailing country'),
      leadSource: z.string().optional().describe('Lead source (e.g. "Web", "Referral", "Partner", "Event")'),
      description: z.string().optional().describe('Notes or description about the contact'),
    }),
    func: async ({ firstName, lastName, email, phone, mobilePhone, title, department, accountName, accountId, mailingCity, mailingState, mailingCountry, leadSource, description }) => {
      log.info({ firstName, lastName, email, accountName, accountId }, 'Creating contact');

      try {
        const conn = await getSalesforceConnection(organizationId);

        const CONTACT_FIELDS = `
          Id, Name, FirstName, LastName, Title, Email, Phone, MobilePhone,
          Department, MailingCity, MailingState, MailingCountry,
          AccountId, Account.Name, OwnerId, Owner.Name,
          LeadSource, Description, CreatedDate
        `.trim();

        // Resolve account if provided
        const resolvedAccountRaw = await resolveAccountId(conn, accountId, accountName);
        if (resolvedAccountRaw && 'error' in resolvedAccountRaw) {
          return JSON.stringify({
            _meta: { tool: 'sfdc_create_contact' },
            error: resolvedAccountRaw.error,
          });
        }
        const resolvedAccount = resolvedAccountRaw as { id: string } | null | undefined;

        // --- Duplicate check: only run dedup when we have a disambiguator
        // beyond first+last name. Without email or account, "John Smith"
        // collides across customers, so the upsert branch could silently
        // overwrite an unrelated contact.
        const hasDisambiguator = !!email || !!resolvedAccount?.id;
        const safeFirst = sanitizeSoql(firstName);
        const safeLast = sanitizeSoql(lastName);
        const dupConditions = [`FirstName = '${safeFirst}'`, `LastName = '${safeLast}'`];
        if (email) dupConditions.push(`Email = '${sanitizeSoql(email)}'`);
        else if (resolvedAccount?.id) dupConditions.push(`AccountId = '${sanitizeSoql(resolvedAccount.id)}'`);

        const existingResult = hasDisambiguator
          ? await conn.query(
              `SELECT ${CONTACT_FIELDS} FROM Contact WHERE ${dupConditions.join(' AND ')} ORDER BY CreatedDate DESC LIMIT 1`
            )
          : { records: [] as Record<string, any>[] };

        if (existingResult.records?.length > 0) {
          const existing = existingResult.records[0] as Record<string, any>;
          log.info({ contactId: existing.Id }, 'Found existing contact');

          const updates: Record<string, any> = {};
          if (email && email !== existing.Email) updates.Email = email;
          if (phone && phone !== existing.Phone) updates.Phone = phone;
          if (mobilePhone && mobilePhone !== existing.MobilePhone) updates.MobilePhone = mobilePhone;
          if (title && title !== existing.Title) updates.Title = title;
          if (department && department !== existing.Department) updates.Department = department;
          if (mailingCity && mailingCity !== existing.MailingCity) updates.MailingCity = mailingCity;
          if (mailingState && mailingState !== existing.MailingState) updates.MailingState = mailingState;
          if (mailingCountry && mailingCountry !== existing.MailingCountry) updates.MailingCountry = mailingCountry;
          if (leadSource && leadSource !== existing.LeadSource) updates.LeadSource = leadSource;
          if (resolvedAccount?.id && resolvedAccount.id !== existing.AccountId) updates.AccountId = resolvedAccount.id;
          if (description && description !== existing.Description) {
            const tag = buildAttributionTag(actorEmail);
            updates.Description = description + (tag || '');
          }

          if (Object.keys(updates).length > 0) {
            await conn.sobject('Contact').update({ Id: existing.Id, ...updates });
            const updatedResult = await conn.query(
              `SELECT ${CONTACT_FIELDS} FROM Contact WHERE Id = '${sanitizeSoql(existing.Id)}' LIMIT 1`
            );
            const updated = updatedResult.records?.[0] as Record<string, any> | undefined;
            return JSON.stringify({
              _meta: { tool: 'sfdc_create_contact' },
              message: `Contact "${existing.Name}" already exists. Updated: ${Object.keys(updates).join(', ')}.`,
              contactId: existing.Id,
              result: updated || existing,
              alreadyExisted: true,
              updatedFields: Object.keys(updates),
            });
          }

          return JSON.stringify({
            _meta: { tool: 'sfdc_create_contact' },
            message: `Contact "${existing.Name}" already exists — no changes needed.`,
            contactId: existing.Id,
            result: existing,
            alreadyExisted: true,
          });
        }

        // --- Normal create flow ---
        const ownerId = await resolveSalesforceUserId(conn, organizationId, actorEmail);

        // Build contact data with only provided fields
        const contactData: Record<string, any> = {
          FirstName: firstName,
          LastName: lastName,
        };

        if (ownerId) contactData.OwnerId = ownerId;
        if (resolvedAccount?.id) contactData.AccountId = resolvedAccount.id;
        if (email) contactData.Email = email;
        if (phone) contactData.Phone = phone;
        if (mobilePhone) contactData.MobilePhone = mobilePhone;
        if (title) contactData.Title = title;
        if (department) contactData.Department = department;
        if (mailingCity) contactData.MailingCity = mailingCity;
        if (mailingState) contactData.MailingState = mailingState;
        if (mailingCountry) contactData.MailingCountry = mailingCountry;
        if (leadSource) contactData.LeadSource = leadSource;

        // Description + attribution tag
        if (description) contactData.Description = description;
        const tag = buildAttributionTag(actorEmail);
        if (tag) contactData.Description = (contactData.Description || '') + tag;

        let createResult = await conn.sobject('Contact').create(contactData);

        // If OwnerId was rejected (permission issue), retry without attribution
        if (!createResult.success && ownerId && isOwnerIdError((createResult as any).errors)) {
          log.warn('OwnerId rejected, retrying without attribution');
          delete contactData.OwnerId;
          createResult = await conn.sobject('Contact').create(contactData);
        }

        if (!createResult.success) {
          const errors = (createResult as any).errors?.map((e: any) =>
            typeof e === 'string' ? e : e.message || JSON.stringify(e)
          ).join(', ') || 'Unknown error';
          log.error({ errors }, 'Create failed');
          return JSON.stringify({
            _meta: { tool: 'sfdc_create_contact' },
            error: `Failed to create contact: ${errors}`,
          });
        }

        // Verify by re-querying the created record
        const verifyResult = await conn.query(
          `SELECT ${CONTACT_FIELDS} FROM Contact WHERE Id = '${sanitizeSoql(createResult.id)}' LIMIT 1`
        );

        const verified = verifyResult.records?.[0] as Record<string, any> | undefined;

        if (!verified) {
          log.error({ contactId: createResult.id }, 'Created contact but could not verify');
          return JSON.stringify({
            _meta: { tool: 'sfdc_create_contact' },
            error: `Contact creation was reported as successful (ID: ${createResult.id}) but could not be verified. Check Salesforce directly.`,
          });
        }

        log.info({ contactId: createResult.id }, 'Verified contact');
        return JSON.stringify({
          _meta: { tool: 'sfdc_create_contact' },
          message: `Successfully created contact "${verified.Name}".`,
          contactId: createResult.id,
          result: verified,
        });
      } catch (err: any) {
        log.error({ err }, 'Error creating contact');
        return JSON.stringify({
          _meta: { tool: 'sfdc_create_contact' },
          error: err.message,
        });
      }
    },
  });
}
