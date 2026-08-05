/**
 * Server-side Clerk role helpers and Express middlewares.
 *
 * Mirrors the frontend mapping in src/hooks/useUserRole.ts so the two sides
 * agree on "admin" vs "member" vs "master admin" for the same session.
 */

import type { Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import type { Request } from "../types";

/** Clerk org slugs that identify the Sales Agent internal "master admin" organization. */
export const MASTER_ORG_SLUGS: ReadonlySet<string> = new Set([
  "agent-ai-master",
  "agent-ai",
]);

/** Maps a Clerk org role string to our app-level org role. */
export const mapClerkOrgRole = (
  clerkRole: string | null | undefined
): "admin" | "member" | null => {
  if (!clerkRole) return null;
  if (clerkRole === "org:admin" || clerkRole === "org:platform_admin") return "admin";
  if (clerkRole === "org:member" || clerkRole === "basic_member" || clerkRole === "member")
    return "member";
  return null;
};

/**
 * Returns true if the Clerk orgRole indicates an org admin.
 * Use this to gate admin-only operations (doc upload, invites, etc.).
 */
export const isOrgAdmin = (
  orgRole: string | null | undefined
): boolean => {
  const mapped = mapClerkOrgRole(orgRole);
  return mapped === "admin";
};

/**
 * Returns true if the Clerk JWT session represents a Slack Sales Agent platform admin
 * or staff member, regardless of which org is currently active. Reads from
 * `sessionClaims.public_metadata.platformRole`.
 *
 * REQUIRES the Clerk Session Token template to include `public_metadata`
 * (i.e. `"public_metadata": "{{user.public_metadata}}"`). If the claim is
 * absent, this fails closed and the caller falls through to the standard
 * org-role check.
 */
export const isPlatformAdmin = (
  sessionClaims: Record<string, unknown> | null | undefined,
): boolean => {
  if (!sessionClaims) return false;
  const meta =
    (sessionClaims as { public_metadata?: unknown }).public_metadata ??
    (sessionClaims as { publicMetadata?: unknown }).publicMetadata ??
    null;
  if (!meta || typeof meta !== "object") return false;
  const role = (meta as { platformRole?: unknown }).platformRole;
  return role === "platform_admin" || role === "platform_staff";
};

/**
 * The union of "can manage this org's resources":
 *   - Standard Clerk org admins (per `auth.orgRole`), OR
 *   - Slack Sales Agent platform admins / staff (per `publicMetadata.platformRole`),
 *     who can manage on behalf of any customer org they've been added to.
 *
 * Use this in route gates instead of `isOrgAdmin(auth.orgRole)` when you want
 * platform staff to be able to act in customer orgs they've joined.
 */
export const canManageOrg = (auth: {
  orgRole?: string | null;
  sessionClaims?: Record<string, unknown> | null;
}): boolean => {
  if (isOrgAdmin(auth.orgRole)) return true;
  if (isPlatformAdmin(auth.sessionClaims ?? null)) return true;
  return false;
};

/**
 * Returns true when the active Clerk org is the Sales Agent master organization.
 *
 * NOTE: this is a slug-based check matching the existing precedent in
 * `admin/usage/leaderboard` and frontend `useUserRole.isMasterAdmin`. It
 * means any member of the agent-ai org passes — to tighten further (require
 * `publicMetadata.platformRole`), add that claim to the Clerk JWT template
 * and check `auth.sessionClaims` here.
 */
export const isMasterAdmin = (
  orgSlug: string | null | undefined
): boolean => !!orgSlug && MASTER_ORG_SLUGS.has(orgSlug);

/**
 * Middleware: require an authenticated Clerk session with org-admin role
 * in the active org. Returns 401 when not signed in, 403 when not admin.
 */
export const requireOrgAdmin = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { userId, orgRole } = getAuth(req);
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized", requestId: req.id });
  }
  if (!isOrgAdmin(orgRole)) {
    return res.status(403).json({
      error: "Forbidden: org admin required",
      requestId: req.id,
    });
  }
  next();
};

/**
 * Middleware: require the caller to be in the Sales Agent master organization.
 * Used for cross-org operations (customer org CRUD, cross-org listings).
 */
export const requireMasterAdmin = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { userId, orgSlug } = getAuth(req);
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized", requestId: req.id });
  }
  if (!isMasterAdmin(orgSlug)) {
    return res.status(403).json({
      error: "Forbidden: master admin required",
      requestId: req.id,
    });
  }
  next();
};
