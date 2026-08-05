import { FatalError } from "workflow";
import type { WorkflowEvent } from "../client.js";
import { getSupabaseAdmin, verifyUserInOrganization } from "../utils/supabase.js";
import { logger } from "../../lib/logger.js";

const log = logger.child({ component: "workflow-tenant-validation" });
const cache = new Map<string, { verified: boolean; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Validate the tenant claim before any provider or model operation runs. */
export async function validateWorkflowEvent(event: WorkflowEvent): Promise<void> {
  "use step";

  const data = event.data ?? {};
  const userId = typeof data.userId === "string" ? data.userId : undefined;
  const organizationId = typeof data.organizationId === "string" ? data.organizationId : undefined;
  if (!userId || !organizationId) return;

  const cacheKey = `${userId}:${organizationId}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.verified) return;
    throw new FatalError("Workflow tenant validation failed");
  }

  const verified = await verifyUserInOrganization(getSupabaseAdmin(), userId, organizationId);
  cache.set(cacheKey, { verified, expiresAt: Date.now() + CACHE_TTL_MS });
  if (!verified) {
    log.error({ userId, organizationId }, "Blocked cross-tenant workflow event");
    throw new FatalError("Workflow tenant validation failed");
  }
}

// Compatibility metadata for code/tests that previously imported the middleware.
export const orgValidationMiddleware = { name: "workflow-tenant-validation" };
