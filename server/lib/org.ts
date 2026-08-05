import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";

/**
 * Resolve a Clerk organization ID (e.g. "org_abc123") to the internal
 * `organizations.id` UUID used by the database.
 *
 * Returns `null` when no matching row exists. Callers should treat this as
 * a 404 condition.
 *
 * Requires a Supabase client that can read `organizations` — use an admin
 * client (service role) at route/webhook boundaries where the caller is not
 * necessarily a member of the target org.
 */
export const resolveOrgId = async (
  supabase: SupabaseClient,
  clerkOrgId: string,
  log: Logger
): Promise<string | null> => {
  const { data: org, error } = await supabase
    .from("organizations")
    .select("id")
    .eq("clerk_id", clerkOrgId)
    .maybeSingle();

  if (error) {
    log.error({ err: error, clerkOrgId }, "Error resolving org by clerk_id");
    return null;
  }
  return org?.id ?? null;
};
