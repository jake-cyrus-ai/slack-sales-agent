/**
 * Org Validation Middleware
 *
 * Defense-in-depth: validates that the userId in an Inngest event actually
 * belongs to the claimed organizationId before any function logic runs.
 *
 * This is a safety net — even when using getSupabaseForUser() (which enforces
 * RLS automatically), this catches misconfigured events early and prevents
 * wasted work or confusing errors deeper in the function.
 *
 * Skip conditions (middleware is a no-op):
 *   - Event has no userId (cron fan-out jobs)
 *   - Event has no organizationId (per-user jobs without org context)
 *   - Either field is null/undefined
 *
 * On mismatch: throws NonRetriableError so Inngest does NOT retry —
 * retrying a security violation wastes resources and changes nothing.
 */

import { InngestMiddleware, NonRetriableError } from "inngest";
import { getSupabaseAdmin, verifyUserInOrganization } from "../utils/supabase.js";
import { logger } from "../../lib/logger";

const log = logger.child({ component: "org-validation" });

// 5-minute in-memory cache to avoid a DB round-trip on every step retry.
// Keyed by "userId:orgId" so different org claims for the same user are independent.
// Negative results are also cached — once invalid, always invalid within TTL.
const cache = new Map<string, { verified: boolean; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export const orgValidationMiddleware = new InngestMiddleware({
  name: "org-validation",
  init: () => ({
    onFunctionRun: ({ ctx }) => ({
      transformInput: async () => {
        const data = (ctx.event as { data?: Record<string, unknown> }).data ?? {};
        const userId = typeof data.userId === "string" ? data.userId : undefined;
        const organizationId =
          typeof data.organizationId === "string" ? data.organizationId : undefined;

        // Skip when either field is absent — cron jobs, admin events, etc.
        if (!userId || !organizationId) return;

        const cacheKey = `${userId}:${organizationId}`;
        const now = Date.now();
        const cached = cache.get(cacheKey);

        if (cached && cached.expiresAt > now) {
          if (!cached.verified) {
            log.error({ userId, organizationId }, "userId is NOT a member of orgId (cached — blocking)");
            throw new NonRetriableError(
              `Security: user ${userId} is not a member of organization ${organizationId}`
            );
          }
          return; // cached positive — allow
        }

        const supabase = getSupabaseAdmin();
        const isMember = await verifyUserInOrganization(supabase, userId, organizationId);

        cache.set(cacheKey, { verified: isMember, expiresAt: now + CACHE_TTL_MS });

        if (!isMember) {
          log.error({ userId, organizationId }, "userId is NOT a member of orgId — blocking execution");
          throw new NonRetriableError(
            `Security: user ${userId} is not a member of organization ${organizationId}`
          );
        }
      },
    }),
  }),
});
