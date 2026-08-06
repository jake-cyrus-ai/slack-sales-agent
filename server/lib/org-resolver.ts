/**
 * Shared organization ID resolver for Express routes.
 *
 * Resolves the active internal organization UUID from the validated Supabase
 * Auth context, falling back to the user's oldest membership.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export async function resolveInternalOrgId(
  supabase: SupabaseClient,
  userId: string,
  activeOrgId: string | null | undefined,
): Promise<string | null> {
  if (activeOrgId) return activeOrgId;

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
