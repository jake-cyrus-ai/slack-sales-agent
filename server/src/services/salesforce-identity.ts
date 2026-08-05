/**
 * Salesforce org identity fetcher.
 *
 * Captures the canonical org identity (id + display name) at OAuth callback
 * time so the takeover-rejection check has something stable to compare on
 * (Salesforce instance URLs change when sandboxes refresh or when "My Domain"
 * is renamed; org_id stays the same for the lifetime of the org), and so the
 * conflict + disconnect UIs can show "Acme Inc" instead of an opaque URL.
 *
 * Sources, in order:
 *   1. ${instance_url}/services/oauth2/userinfo — returns the organization_id
 *      that any access token is scoped to. This is the load-bearing field.
 *   2. ${instance_url}/services/data/v59.0/sobjects/Organization/{orgId} —
 *      returns the org's `Name` field. Display-only; tolerated to fail.
 *
 * Never throws — caller treats nullable fields as degradations.
 */

import { logger } from "../../lib/logger";

const log = logger.child({ component: "salesforce-identity" });

const FETCH_TIMEOUT_MS = 5_000;
// Pinned API version. The Organization sobject and userinfo endpoints have
// been stable for years; bumping this is safe but not load-bearing.
const SFDC_API_VERSION = "v59.0";

export interface SalesforceIdentity {
  orgId: string | null;
  orgName: string | null;
}

interface UserInfoResponse {
  organization_id?: unknown;
}

interface OrganizationSObject {
  Name?: unknown;
}

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    log.info({ err, url }, "Salesforce identity fetch failed");
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchUserInfo(
  accessToken: string,
  instanceUrl: string,
): Promise<string | null> {
  const res = await fetchWithTimeout(
    `${instanceUrl}/services/oauth2/userinfo`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
  );
  if (!res) return null;
  if (!res.ok) {
    log.info({ httpStatus: res.status }, "Salesforce userinfo non-2xx");
    return null;
  }
  const body = (await res.json()) as UserInfoResponse;
  return pickString(body?.organization_id);
}

async function fetchOrgName(
  accessToken: string,
  instanceUrl: string,
  orgId: string,
): Promise<string | null> {
  const res = await fetchWithTimeout(
    `${instanceUrl}/services/data/${SFDC_API_VERSION}/sobjects/Organization/${orgId}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
  );
  if (!res) return null;
  if (!res.ok) {
    log.info({ httpStatus: res.status }, "Salesforce Organization sobject non-2xx");
    return null;
  }
  const body = (await res.json()) as OrganizationSObject;
  return pickString(body?.Name);
}

/**
 * Fetch the org identity (id + name) for a freshly-issued Salesforce token.
 * Caller persists `orgId` on `salesforce_credentials.salesforce_org_id` and
 * uses it as the authoritative "is this the same workspace?" check on
 * subsequent OAuth flows.
 */
export async function fetchSalesforceIdentity(args: {
  accessToken: string;
  instanceUrl: string;
}): Promise<SalesforceIdentity> {
  const orgId = await fetchUserInfo(args.accessToken, args.instanceUrl);
  if (!orgId) {
    return { orgId: null, orgName: null };
  }
  const orgName = await fetchOrgName(args.accessToken, args.instanceUrl, orgId);
  return { orgId, orgName };
}
