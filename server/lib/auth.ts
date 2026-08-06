import type { NextFunction, Response } from "express";
import type { User } from "@supabase/supabase-js";
import type { Request } from "../types";
import { getSupabaseAdmin } from "../workflows/utils/supabase";

export type AuthContext = {
  userId: string | null;
  orgId: string | null;
  orgRole: string | null;
  orgSlug: string | null;
  sessionId: string | null;
  sessionClaims: Record<string, unknown> | null;
  user: User | null;
  token: string | null;
};

const anonymousContext = (): AuthContext => ({
  userId: null,
  orgId: null,
  orgRole: null,
  orgSlug: null,
  sessionId: null,
  sessionClaims: null,
  user: null,
  token: null,
});

export const getAuth = (req: Request): AuthContext => req.auth ?? anonymousContext();

/** Resolve and validate a Supabase bearer session and optional active organization. */
export async function supabaseAuthMiddleware(req: Request, _res: Response, next: NextFunction) {
  req.auth = anonymousContext();
  const authorization = req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) return next();
  const token = authorization.slice(7).trim();
  if (!token) return next();

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return next();

    const requestedOrgId = req.header("x-organization-id")?.trim() || null;
    let membershipQuery = supabase
      .from("organization_users")
      .select("organization_id, role, organizations!inner(slug)")
      .eq("user_id", data.user.id);
    if (requestedOrgId) membershipQuery = membershipQuery.eq("organization_id", requestedOrgId);
    const { data: membership } = await membershipQuery
      .order("joined_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    const claims = data.user.app_metadata ?? {};
    req.auth = {
      userId: data.user.id,
      orgId: membership?.organization_id ?? null,
      orgRole: membership?.role ?? null,
      orgSlug: (membership?.organizations as unknown as { slug?: string } | null)?.slug ?? null,
      sessionId: typeof claims.session_id === "string" ? claims.session_id : null,
      sessionClaims: claims,
      user: data.user,
      token,
    };
  } catch (error) {
    req.log?.warn({ err: error }, "Supabase authentication failed");
  }
  next();
}

export const requireAuth = () => (req: Request, res: Response, next: NextFunction) => {
  if (!getAuth(req).userId) {
    return res.status(401).json({ error: "Unauthorized", requestId: req.id });
  }
  next();
};

export const isOrgAdmin = (role: string | null | undefined): boolean =>
  role === "owner" || role === "admin" || role === "org:owner" || role === "org:admin";

export const isPlatformAdmin = (claims: Record<string, unknown> | null | undefined): boolean => {
  const role = claims?.platform_role ?? claims?.platformRole;
  return role === "platform_admin" || role === "platform_staff";
};

export const canManageOrg = (auth: Pick<AuthContext, "orgRole" | "sessionClaims">): boolean =>
  isOrgAdmin(auth.orgRole) || isPlatformAdmin(auth.sessionClaims);

export const requireOrgAdmin = (req: Request, res: Response, next: NextFunction) => {
  const auth = getAuth(req);
  if (!auth.userId) return res.status(401).json({ error: "Unauthorized", requestId: req.id });
  if (!isOrgAdmin(auth.orgRole)) {
    return res.status(403).json({ error: "Forbidden: org admin required", requestId: req.id });
  }
  next();
};
