import { supabase } from '../lib/supabase.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ component: 'user-mapper' });

export interface UserMapping {
  /** Supabase Auth user ID (e.g., user_2xxx) — used as FK across all tables. */
  agentUserId: string;
  /** Internal Supabase organization UUID (selected from the authenticated membership). */
  organizationId: string | null;
}

/**
 * Resolve a Slack user ID to a Sales Agent user + organization.
 *
 * POST-MIGRATION: The `agentUserId` returned is the Supabase Auth user ID directly.
 * The mapping is created during the Slack OAuth flow and uses the profiles
 * table as the source of truth for user identity.
 *
 * Returns null if no mapping exists — the bot does NOT auto-create accounts.
 * Unlinked users are directed to sign up via the configuration UI.
 */
export async function resolveSlackUser(
  slackWorkspaceId: string,
  slackUserId: string
): Promise<UserMapping | null> {
  const { data: mapping, error } = await supabase
    .from('slack_user_mappings')
    .select('agent_user_id, organization_id')
    .eq('slack_workspace_id', slackWorkspaceId)
    .eq('slack_user_id', slackUserId)
    .eq('is_active', true)
    .single();

  if (error || !mapping) {
    log.info({ slackUserId, slackWorkspaceId }, 'No mapping found for Slack user');
    return null;
  }

  return {
    agentUserId: mapping.agent_user_id,
    organizationId: mapping.organization_id,
  };
}
