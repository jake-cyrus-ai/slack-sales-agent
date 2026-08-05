/**
 * Server-side Clerk role helpers and Express middlewares.
 *
 * Mirrors the frontend mapping in src/hooks/useUserRole.ts so the two sides
 * agree on "admin" vs "member" for the same session.
 */

import type { Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import type { Request } from "../types";

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
