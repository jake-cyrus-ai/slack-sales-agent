/**
 * Attio workspace metadata fetcher.
 *
 * Captures the human-readable workspace identity (name + slug) at OAuth
 * callback time so:
 *   - The takeover-rejection error can show "you're already connected to
 *     workspace 'Slack Sales Agent'" instead of an opaque UUID.
 *   - The deep-link slug used by the Autonomous Slack post is auto-derived from the
 *     active connection instead of a hardcoded organizations.settings value.
 *
 * Three sources tried in order (cheapest first):
 *   1. JWT claims on the access token — Attio sometimes embeds workspace_slug
 *      and workspace_name alongside workspace_id.
 *   2. REST GET https://api.attio.com/v2/self — public endpoint that returns
 *      token metadata including workspace_id, workspace_name, workspace_slug.
 *      A historical comment in crm-sync.ts claimed REST endpoints rejected
 *      our MCP bearer ("different audience"), but that read of the failure
 *      mode wasn't verified — Attio's standard OAuth tokens normally work
 *      against both api.attio.com and mcp.attio.com. We try it anyway and
 *      tolerate any failure.
 *   3. Fallback: return whatever the JWT carried (typically workspace_id
 *      only). The caller stores nullable name/slug — UI degrades to UUID
 *      display and deep-link URL is skipped.
 */

import { logger } from "../../lib/logger";

const log = logger.child({ component: "attio-workspace" });

const ATTIO_REST_BASE = "https://api.attio.com";
const REST_TIMEOUT_MS = 3_000;

export interface AttioWorkspaceMetadata {
  id: string | null;
  name: string | null;
  slug: string | null;
}

interface JwtClaims {
  workspace_id?: unknown;
  workspace_name?: unknown;
  workspace_slug?: unknown;
}

function decodeJwtPayload(accessToken: string): JwtClaims | null {
  try {
    const payloadB64 = accessToken.split(".")[1];
    if (!payloadB64) return null;
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
    return payload as JwtClaims;
  } catch {
    return null;
  }
}

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function fetchSelfFromRest(accessToken: string): Promise<AttioWorkspaceMetadata | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
  try {
    const res = await fetch(`${ATTIO_REST_BASE}/v2/self`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      log.info({ httpStatus: res.status }, "Attio /v2/self returned non-2xx");
      return null;
    }
    const body = await res.json();
    const data = body?.data ?? body;
    return {
      id: pickString(data?.workspace_id),
      name: pickString(data?.workspace_name),
      slug: pickString(data?.workspace_slug),
    };
  } catch (err) {
    log.info({ err }, "Attio /v2/self fetch failed");
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Capture workspace identity for a freshly-issued Attio access token.
 *
 * Never throws — the caller treats null fields as degradations. workspace_id
 * is the load-bearing field (used by takeover-rejection comparison); name
 * and slug are display-only.
 */
export async function fetchAttioWorkspaceMetadata(
  accessToken: string,
): Promise<AttioWorkspaceMetadata> {
  const claims = decodeJwtPayload(accessToken);
  const fromJwt: AttioWorkspaceMetadata = {
    id: pickString(claims?.workspace_id),
    name: pickString(claims?.workspace_name),
    slug: pickString(claims?.workspace_slug),
  };

  if (fromJwt.id && fromJwt.name && fromJwt.slug) {
    return fromJwt;
  }

  const fromRest = await fetchSelfFromRest(accessToken);
  if (fromRest) {
    return {
      id: fromRest.id ?? fromJwt.id,
      name: fromRest.name ?? fromJwt.name,
      slug: fromRest.slug ?? fromJwt.slug,
    };
  }

  return fromJwt;
}
