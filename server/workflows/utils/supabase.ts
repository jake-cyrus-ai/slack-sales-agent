/**
 * Supabase Client Utilities for Vercel Workflow Functions
 *
 * Provides Supabase client instances configured for Vercel Workflow function execution.
 *
 * Client hierarchy (prefer lower numbers):
 *   1. getSupabaseForUser(userId)  — user-scoped JWT, RLS enforced automatically
 *   2. getSupabaseAdmin()          — service role, bypasses RLS; use only for:
 *        • cron fan-out queries that must scan all users
 *        • service-role-only tables: slack_workspaces, agent_email_credentials
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { createHmac } from "crypto";

/**
 * Get Supabase admin client with service role key
 * Use this for operations that need to bypass RLS
 */
export function getSupabaseAdmin(): SupabaseClient {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY;
  
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables must be set");
  }
  
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * Create a short-lived JWT for a specific user using the Supabase JWT secret.
 * This signs an HS256 token that Supabase accepts as an authenticated user session.
 */
function createUserJwt(userId: string, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      sub: userId,
      role: "authenticated",
      aud: "authenticated",
      iat: now,
      exp: now + 900, // 15 minutes — fresh per step.run() call
    })
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * Get a user-scoped Supabase client that respects RLS.
 *
 * Use this for ALL user-data operations in Vercel Workflow functions.
 * RLS policies will automatically enforce org isolation — no need to manually
 * filter by organization_id for tables with proper RLS policies.
 *
 * Call once per step.run() — each call mints a fresh 15-min JWT.
 *
 * Requires SUPABASE_JWT_SECRET env var (Supabase project Settings → API → JWT Secret).
 */
export function getSupabaseForUser(userId: string): SupabaseClient {
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (!jwtSecret) {
    throw new Error("SUPABASE_JWT_SECRET must be set to use user-scoped Supabase client");
  }
  const token = createUserJwt(userId, jwtSecret);
  return getSupabaseWithAuth(token);
}

/**
 * Get Supabase client with user JWT token
 * Use this for operations that should respect RLS
 */
export function getSupabaseWithAuth(jwtToken: string): SupabaseClient {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  
  if (!supabaseUrl || !anonKey) {
    throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY environment variables must be set");
  }
  
  const client = createClient(supabaseUrl, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
      },
    },
  });
  
  return client;
}

/**
 * Get the user's organization ID from their oldest org membership.
 */
export async function getUserOrganization(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  const { data: membership } = await supabase
    .from('organization_users')
    .select('organization_id')
    .eq('user_id', userId)
    .order('joined_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  return membership?.organization_id || null;
}

/**
 * Appends .eq("organization_id", orgId) to a Postgrest query builder.
 * Use ONLY with the admin client — user-scoped client already enforces org isolation via RLS.
 *
 * @example
 *   const { data } = await withOrgScope(
 *     adminSupabase.from("deals").select("*").eq("id", dealId),
 *     organizationId
 *   ).single();
 */
export function withOrgScope(query: any, orgId: string): any {
  return query.eq("organization_id", orgId);
}

/**
 * Verify user belongs to an organization
 */
export async function verifyUserInOrganization(
  supabase: SupabaseClient,
  userId: string,
  organizationId: string
): Promise<boolean> {
  const { data } = await supabase
    .from('organization_users')
    .select('user_id')
    .eq('user_id', userId)
    .eq('organization_id', organizationId)
    .single();
  
  return !!data;
}
