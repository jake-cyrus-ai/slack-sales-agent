/**
 * Shared utilities for Salesforce SOQL query construction and record resolution.
 */

import { logger } from '../../lib/logger.js';

const log = logger.child({ util: 'salesforce-utils' });

/**
 * Sanitize user input for safe interpolation into SOQL strings.
 * Strips single quotes, backslashes, and null bytes to prevent injection.
 * Does NOT strip % and _ — they are wildcards only in LIKE clauses, and
 * LIKE call sites already bracket values with their own % wildcards.
 * Stripping them here would break equality lookups on emails with
 * underscores (common in enterprise: first_last@company.com).
 */
export function sanitizeSoql(input: string): string {
  return input.replace(/['\\\x00]/g, ''); // eslint-disable-line no-control-regex
}

/**
 * Resolve a Salesforce record ID from either a provided ID or a name search.
 * Used by write tools so the LLM can pass human-readable names instead of
 * memorized (and often hallucinated) IDs.
 *
 * @param type - "what" searches Opportunities then Accounts; "who" searches Contacts then Leads
 * @returns null if neither id nor name provided, { id } on success, { error } on failure
 */
export async function resolveRecordId(
  conn: any,
  type: 'what' | 'who',
  id?: string,
  name?: string,
): Promise<{ id: string; error?: never } | { error: string; id?: never } | null> {
  if (!id && !name) return null;

  if (id) {
    const safeId = sanitizeSoql(id);
    try {
      if (type === 'what') {
        const result = await conn.query(`SELECT Id FROM Opportunity WHERE Id = '${safeId}' LIMIT 1`);
        if (result.records?.length) return { id: result.records[0].Id };
        const accResult = await conn.query(`SELECT Id FROM Account WHERE Id = '${safeId}' LIMIT 1`);
        if (accResult.records?.length) return { id: accResult.records[0].Id };
      } else {
        const result = await conn.query(`SELECT Id FROM Contact WHERE Id = '${safeId}' LIMIT 1`);
        if (result.records?.length) return { id: result.records[0].Id };
        const leadResult = await conn.query(`SELECT Id FROM Lead WHERE Id = '${safeId}' LIMIT 1`);
        if (leadResult.records?.length) return { id: leadResult.records[0].Id };
      }
    } catch {
      // ID was malformed or not found — fall through to name search
    }
    if (!name) {
      return { error: `Record ID "${id}" was not found in Salesforce. Provide the record name instead.` };
    }
    log.warn({ id, name }, 'ID not found, falling back to name search');
  }

  const safeName = sanitizeSoql(name!);

  if (type === 'what') {
    const oppResult = await conn.query(
      `SELECT Id, Name FROM Opportunity WHERE Name LIKE '%${safeName}%' ORDER BY LastModifiedDate DESC LIMIT 5`
    );
    if (oppResult.records?.length === 1) return { id: oppResult.records[0].Id };
    if (oppResult.records?.length > 1) {
      const options = oppResult.records.map((r: any) => `• ${r.Name} (${r.Id})`).join('\n');
      return { error: `Multiple opportunities match "${name}". Ask the user which one:\n${options}` };
    }

    const accResult = await conn.query(
      `SELECT Id, Name FROM Account WHERE Name LIKE '%${safeName}%' ORDER BY LastModifiedDate DESC LIMIT 5`
    );
    if (accResult.records?.length === 1) return { id: accResult.records[0].Id };
    if (accResult.records?.length > 1) {
      const options = accResult.records.map((r: any) => `• ${r.Name} (${r.Id})`).join('\n');
      return { error: `Multiple accounts match "${name}". Ask the user which one:\n${options}` };
    }

    return { error: `No Opportunity or Account found matching "${name}".` };
  }

  // type === 'who'
  const contactResult = await conn.query(
    `SELECT Id, Name FROM Contact WHERE Name LIKE '%${safeName}%' ORDER BY LastModifiedDate DESC LIMIT 5`
  );
  if (contactResult.records?.length === 1) return { id: contactResult.records[0].Id };
  if (contactResult.records?.length > 1) {
    const options = contactResult.records.map((r: any) => `• ${r.Name} (${r.Id})`).join('\n');
    return { error: `Multiple contacts match "${name}". Ask the user which one:\n${options}` };
  }

  const leadResult = await conn.query(
    `SELECT Id, Name FROM Lead WHERE Name LIKE '%${safeName}%' ORDER BY LastModifiedDate DESC LIMIT 5`
  );
  if (leadResult.records?.length === 1) return { id: leadResult.records[0].Id };
  if (leadResult.records?.length > 1) {
    const options = leadResult.records.map((r: any) => `• ${r.Name} (${r.Id})`).join('\n');
    return { error: `Multiple leads match "${name}". Ask the user which one:\n${options}` };
  }

  return { error: `No Contact or Lead found matching "${name}".` };
}

/**
 * Check whether a Salesforce create/update error array indicates an OwnerId-specific
 * failure (e.g. permission issue). Used to decide whether retrying without OwnerId
 * is appropriate — prevents masking unrelated errors like validation rules.
 */
export function isOwnerIdError(errors: any[] | undefined): boolean {
  if (!errors || errors.length === 0) return false;
  return errors.some((e: any) => {
    if (typeof e === 'string') return /OwnerId/i.test(e);
    const code = e.statusCode || e.errorCode || '';
    const fields: string[] = e.fields || [];
    const message: string = e.message || '';
    return (
      (code === 'FIELD_INTEGRITY_EXCEPTION' && fields.includes('OwnerId')) ||
      (code === 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY' && fields.includes('OwnerId')) ||
      /OwnerId/i.test(message)
    );
  });
}

/**
 * In-memory cache: email → Salesforce User ID.
 * Keyed by "orgId:email" to handle multi-org correctly. TTL: 1 hour.
 */
const sfUserIdCache = new Map<string, { userId: string | null; cachedAt: number }>();
const SF_USER_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Resolve a user's email to an active Salesforce User ID for OwnerId attribution.
 * Returns null (not an error) if no match — caller falls back to OAuth admin.
 */
export async function resolveSalesforceUserId(
  conn: any,
  organizationId: string,
  email: string | null | undefined,
): Promise<string | null> {
  if (!email) return null;

  const cacheKey = `${organizationId}:${email.toLowerCase()}`;
  const cached = sfUserIdCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < SF_USER_CACHE_TTL_MS) {
    return cached.userId;
  }

  try {
    const safeEmail = sanitizeSoql(email);
    const result = await conn.query(
      `SELECT Id, Name FROM User WHERE Email = '${safeEmail}' AND IsActive = true LIMIT 1`
    );
    const sfUserId = result.records?.[0]?.Id || null;
    sfUserIdCache.set(cacheKey, { userId: sfUserId, cachedAt: Date.now() });

    if (sfUserId) {
      log.info({ email, sfUserId, sfUserName: result.records[0].Name }, 'Resolved SF user for attribution');
    } else {
      log.info({ email }, 'No SF user found — using default owner');
    }
    return sfUserId;
  } catch (err: any) {
    log.warn({ err, email }, 'Failed to resolve SF user for attribution');
    return null;
  }
}

/**
 * Build an attribution tag to append to Description fields on Salesforce records.
 * Returns empty string if no email — callers can safely concatenate.
 */
export function buildAttributionTag(email: string | null | undefined): string {
  if (!email) return '';
  return `\n\n— Requested by ${email} via Slack Sales Agent`;
}
