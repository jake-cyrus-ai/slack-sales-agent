import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";

/** Confirm an internal organization UUID exists. Membership is validated by auth middleware. */
export const resolveOrgId = async (
  supabase: SupabaseClient,
  organizationId: string,
  log: Logger,
): Promise<string | null> => {
  const { data, error } = await supabase
    .from("organizations")
    .select("id")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) {
    log.error({ err: error, organizationId }, "Error resolving organization");
    return null;
  }
  return data?.id ?? null;
};
