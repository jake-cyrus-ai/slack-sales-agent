/**
 * Supabase client helpers for the Express server.
 *
 * Client hierarchy (prefer lower numbers):
 *   1. getSupabaseForRequest(req)  — user-scoped JWT, RLS enforced automatically.
 *                                    Default for user-initiated routes.
 *   2. getSupabaseForUser(userId)  — same as (1) when you already have the userId
 *                                    (e.g. inside an async worker or helper).
 *   3. getSupabaseAdmin()          — service role, bypasses RLS. Use only for
 *                                    legitimately admin/system operations
 *                                    (cross-user listings, cross-org master-admin
 *                                    work, service-role-only tables). Each call
 *                                    site should justify the bypass in a comment.
 *
 * Implementation lives under server/workflows/utils/supabase.ts and is re-exported
 * here so Express routes can import from a clean `lib/` path without depending
 * on Vercel Workflow internals.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAuth } from "@clerk/express";
import type { Request } from "../types";
import {
  getSupabaseAdmin,
  getSupabaseForUser,
  getSupabaseWithAuth,
} from "../workflows/utils/supabase";

export { getSupabaseAdmin, getSupabaseForUser, getSupabaseWithAuth };

/**
 * Returns a user-scoped Supabase client for the authenticated caller.
 * RLS policies enforce user/org boundaries at the database — queries
 * only return rows the user is permitted to see.
 *
 * Must be called inside a route protected by `requireAuth()`; throws if
 * there is no userId in the Clerk session.
 */
export function getSupabaseForRequest(req: Request): SupabaseClient {
  const { userId } = getAuth(req);
  if (!userId) {
    throw new Error(
      "getSupabaseForRequest called without an authenticated user — gate the route with requireAuth() first"
    );
  }
  return getSupabaseForUser(userId);
}
