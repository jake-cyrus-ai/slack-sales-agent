/**
 * Shared organization ID resolver for Express routes.
 *
 * Resolves the internal Supabase organization UUID from a Clerk session.
 * Clerk's `auth.orgId` returns a Clerk-assigned ID (e.g. "org_2xxx"),
 * NOT a Supabase UUID. This resolver maps it to the internal UUID.
 *
 * Resolution tiers:
 *   1. Clerk session org (clerkOrgId -> organizations.clerk_id -> id)
 *   2. Oldest org membership from organization_users
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export async function resolveInternalOrgId(
  supabase: SupabaseClient,
  userId: string,
  clerkOrgId: string | null | undefined,
): Promise<string | null> {
  if (clerkOrgId) {
    const { data: org } = await supabase
      .from("organizations")
      .select("id")
      .eq("clerk_id", clerkOrgId)
      .maybeSingle();
    if (org?.id) return org.id;
  }

  // Tier 2: organization_users membership
  const { data: membership } = await supabase
    .from("organization_users")
    .select("organization_id")
    .eq("user_id", userId)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  return membership?.organization_id ?? null;
}
