/**
 * Per-user integration status checks.
 *
 * Runs lightweight DB queries in parallel to determine which integrations
 * the user (or their org) has connected. Used by the supervisor to gate
 * which skills are visible to the agent.
 */

import { supabase } from '../lib/supabase.js';
import { hasGranolaConnection } from './granola-client.js';
import { hasAttioConnection } from './attio-client.js';
import { isSalesforceConfiguredForOrg } from '../salesforce/client.js';

export interface UserIntegrations {
  google: boolean;
  granola: boolean;
  salesforce: boolean;
  attio: boolean;
}

async function hasGoogleConnection(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('calendar_credentials')
    .select('id')
    .eq('user_id', userId)
    .eq('sync_status', 'active')
    .limit(1)
    .maybeSingle();

  return !error && !!data;
}

/**
 * Check all integration connections for a user in parallel.
 * Returns which integrations are active and available for skill gating.
 */
export async function checkUserIntegrations(
  userId: string,
  organizationId: string | null,
): Promise<UserIntegrations> {
  const [google, granola, salesforce, attio] = await Promise.all([
    hasGoogleConnection(userId),
    hasGranolaConnection(userId),
    organizationId ? isSalesforceConfiguredForOrg(organizationId) : Promise.resolve(false),
    organizationId ? hasAttioConnection(organizationId) : Promise.resolve(false),
  ]);

  return { google, granola, salesforce, attio };
}
