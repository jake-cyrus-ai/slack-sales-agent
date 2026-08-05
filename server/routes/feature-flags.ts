/**
 * Feature Flag API Routes
 *
 * Migrates the frontend's direct Supabase `set_feature_flag` /
 * `set_org_feature_flag` RPC calls behind Express. The browser previously
 * invoked these RPCs directly, which let it pass an arbitrary `p_user_id` —
 * these routes always derive the user id from the authenticated Clerk
 * session instead.
 *
 *   - PUT /api/feature-flags/user — per-user profile feature flags
 *   - PUT /api/feature-flags/org  — per-org feature flags (admin-gated)
 */

import { Router, Response } from "express";
import { getAuth, requireAuth } from "@clerk/express";
import { z } from "zod";
import { isOrgAdmin, isMasterAdmin } from "../lib/auth";
import { getSupabaseForRequest, getSupabaseAdmin } from "../lib/supabase";
import { resolveOrgId } from "../lib/org";
import { validateBody } from "../lib/validate";
import type { Request } from "../types";

const router = Router();

// `flagValue` is unconstrained JSON — flags carry booleans (e.g.
// onboarding_wizard_completed) and objects (e.g. autonomous_emails
// { enabled, timestamp }). Validation just ensures the key is present.
const userFlagSchema = z.object({
  flagKey: z.string().min(1, "flagKey is required"),
  flagValue: z.unknown(),
});

const orgFlagSchema = z.object({
  orgId: z.string().min(1, "orgId is required"),
  flagKey: z.string().min(1, "flagKey is required"),
  flagValue: z.unknown(),
});

/**
 * Authorize the caller to act on the internal `orgId`. Returns `null` on
 * success, or an `{ status, error }` rejection. Mirrors the same-named
 * helper in routes/admin.ts: master admins pass for any org; otherwise the
 * caller's active Clerk org must resolve to `orgId` AND carry org-admin role.
 */
type AuthzRejection = { status: number; error: string };

const authorizeOrgAction = async (
  req: Request,
  orgId: string
): Promise<AuthzRejection | null> => {
  const { userId, orgRole, orgId: clerkOrgId, orgSlug } = getAuth(req);
  if (!userId) return { status: 401, error: "Unauthorized" };
  if (isMasterAdmin(orgSlug)) return null;
  if (!isOrgAdmin(orgRole)) return { status: 403, error: "Forbidden: org admin required" };
  if (!clerkOrgId) return { status: 403, error: "Organization context required" };

  // admin client: resolving a Clerk org the caller may not yet be a member
  // of via RLS — the org-admin gate above is the authorization boundary.
  const supabase = getSupabaseAdmin();
  const callerOrgId = await resolveOrgId(supabase, clerkOrgId, req.log);
  if (!callerOrgId) return { status: 404, error: "Caller organization not found" };
  if (callerOrgId !== orgId) {
    return { status: 403, error: "Can only act on your own organization" };
  }
  return null;
};

/**
 * PUT /api/feature-flags/user
 *
 * Sets a feature flag on the authenticated user's profile.
 * Body: { flagKey: string, flagValue: <json> }
 *
 * SECURITY: the target user id is always the authenticated caller — the
 * client never supplies a user id.
 */
router.put(
  "/feature-flags/user",
  requireAuth(),
  async (req: Request, res: Response) => {
    const body = validateBody(userFlagSchema, req, res);
    if (!body) return;

    try {
      const { userId } = getAuth(req);
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized", requestId: req.id });
      }

      // RLS-enforced user-scoped client. set_feature_flag is a SECURITY
      // DEFINER RPC; p_user_id is the caller's own id from the session.
      const supabase = getSupabaseForRequest(req);

      // The RPC's p_flag_value param is `text` and is cast `::jsonb` inside
      // the function — so the value must be passed JSON-stringified.
      const { error } = await supabase.rpc("set_feature_flag", {
        p_user_id: userId,
        p_flag_key: body.flagKey,
        p_flag_value: JSON.stringify(body.flagValue),
      });

      if (error) {
        req.log.error({ err: error, flagKey: body.flagKey }, "Failed to set user feature flag");
        return res.status(500).json({ error: error.message, requestId: req.id });
      }

      req.log.info({ userId, flagKey: body.flagKey }, "User feature flag updated");
      return res.json({ success: true, requestId: req.id });
    } catch (error) {
      req.log.error({ err: error }, "Error setting user feature flag");
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Internal server error",
        requestId: req.id,
      });
    }
  }
);

/**
 * PUT /api/feature-flags/org
 *
 * Sets a feature flag on an organization.
 * Body: { orgId: string, flagKey: string, flagValue: <json> }
 *
 * Caller must be a master admin or an org admin of `orgId`.
 */
router.put(
  "/feature-flags/org",
  requireAuth(),
  async (req: Request, res: Response) => {
    const body = validateBody(orgFlagSchema, req, res);
    if (!body) return;

    try {
      const rejection = await authorizeOrgAction(req, body.orgId);
      if (rejection) {
        return res.status(rejection.status).json({ error: rejection.error, requestId: req.id });
      }

      // RLS-enforced user-scoped client. set_org_feature_flag is a SECURITY
      // DEFINER RPC that re-checks the caller's org role via current_user_id()
      // — the user-scoped JWT makes that check resolve correctly and gives
      // defense-in-depth alongside the authorizeOrgAction gate above.
      const supabase = getSupabaseForRequest(req);

      // The RPC's p_flag_value param is `jsonb` — pass the raw value.
      const { error } = await supabase.rpc("set_org_feature_flag", {
        p_org_id: body.orgId,
        p_flag_key: body.flagKey,
        p_flag_value: body.flagValue,
      });

      if (error) {
        req.log.error({ err: error, orgId: body.orgId, flagKey: body.flagKey }, "Failed to set org feature flag");
        return res.status(500).json({ error: error.message, requestId: req.id });
      }

      req.log.info({ orgId: body.orgId, flagKey: body.flagKey }, "Org feature flag updated");
      return res.json({ success: true, requestId: req.id });
    } catch (error) {
      req.log.error({ err: error }, "Error setting org feature flag");
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Internal server error",
        requestId: req.id,
      });
    }
  }
);

export default router;
