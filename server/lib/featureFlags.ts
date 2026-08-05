/**
 * Feature Flags for Clerk Migration
 *
 * This module provides feature flags to control the phased rollout of Clerk integration.
 * Flags are checked at runtime to enable/disable specific features.
 *
 * Environment Variables:
 *   - CLERK_MIGRATION_ENABLED: Master switch for Clerk features (default: false)
 *   - CLERK_NATIVE_IDS_ENABLED: Use Clerk IDs directly in database (default: false)
 *   - CLERK_ORG_SYNC_ENABLED: Sync organization changes to Clerk (default: false)
 *   - CLERK_USER_SYNC_ENABLED: Sync user changes to Clerk (default: false)
 */

import { logger } from "./logger.js";

const log = logger.child({ component: "feature-flags" });

// ---------------------------------------------------------------------------
// Feature Flag Functions
// ---------------------------------------------------------------------------

/**
 * Master switch: Is Clerk migration enabled at all?
 */
export function isClerkMigrationEnabled(): boolean {
  return process.env.CLERK_MIGRATION_ENABLED === 'true';
}

/**
 * Are we using Clerk native IDs (user_2xxx) directly in the database?
 * When false, we still map through profiles.clerk_user_id
 * When true, profiles.user_id IS the Clerk ID
 */
export function isClerkNativeIdsEnabled(): boolean {
  return process.env.CLERK_NATIVE_IDS_ENABLED === 'true';
}

/**
 * Should we sync organization changes TO Clerk?
 * When false, Clerk webhooks still update Supabase (read-only from Clerk)
 * When true, changes in Supabase also update Clerk (bidirectional)
 */
export function isClerkOrgSyncEnabled(): boolean {
  return process.env.CLERK_ORG_SYNC_ENABLED === 'true';
}

/**
 * Should we sync user changes TO Clerk?
 * When false, Clerk webhooks still update Supabase
 * When true, user updates in Supabase also update Clerk
 */
export function isClerkUserSyncEnabled(): boolean {
  return process.env.CLERK_USER_SYNC_ENABLED === 'true';
}

/**
 * Should we use Clerk for authentication in the frontend?
 * When false, use Supabase Auth (legacy)
 * When true, use Clerk Auth
 */
export function isClerkAuthEnabled(): boolean {
  return isClerkMigrationEnabled() || process.env.USE_CLERK_AUTH === 'true';
}

/**
 * Should we run in dual-mode (both Supabase Auth and Clerk)?
 * Useful for gradual rollout where some users use Clerk, others use Supabase
 */
export function isDualModeEnabled(): boolean {
  return process.env.DUAL_AUTH_MODE === 'true';
}

// ---------------------------------------------------------------------------
// Migration Phase Helper
// ---------------------------------------------------------------------------

export type MigrationPhase = 
  | 'pre-migration'      // Before migration: Supabase Auth only
  | 'dual-mode'          // During migration: Both auth systems active
  | 'clerk-native-ids'   // After DB migration: Clerk IDs in database
  | 'clerk-only';        // Complete: Supabase Auth disabled

/**
 * Get the current migration phase based on feature flags
 */
export function getCurrentMigrationPhase(): MigrationPhase {
  if (!isClerkMigrationEnabled()) {
    return 'pre-migration';
  }
  
  if (isDualModeEnabled()) {
    return 'dual-mode';
  }
  
  if (isClerkNativeIdsEnabled()) {
    return 'clerk-native-ids';
  }
  
  // Clerk enabled but not native IDs yet (legacy mapping mode)
  return 'clerk-only';
}

// ---------------------------------------------------------------------------
// Log Current Configuration
// ---------------------------------------------------------------------------

export function logMigrationConfig(): void {
  const phase = getCurrentMigrationPhase();
  
  log.info({
    phase,
    masterEnabled: isClerkMigrationEnabled(),
    nativeIds: isClerkNativeIdsEnabled(),
    orgSync: isClerkOrgSyncEnabled(),
    userSync: isClerkUserSyncEnabled(),
    useClerkAuth: isClerkAuthEnabled(),
    dualMode: isDualModeEnabled(),
  }, "Clerk Migration Configuration");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that feature flags are in a consistent state
 */
export function validateMigrationFlags(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Native IDs require migration to be enabled
  if (isClerkNativeIdsEnabled() && !isClerkMigrationEnabled()) {
    errors.push('CLERK_NATIVE_IDS_ENABLED requires CLERK_MIGRATION_ENABLED=true');
  }
  
  // Org/user sync requires migration to be enabled
  if (isClerkOrgSyncEnabled() && !isClerkMigrationEnabled()) {
    errors.push('CLERK_ORG_SYNC_ENABLED requires CLERK_MIGRATION_ENABLED=true');
  }
  
  if (isClerkUserSyncEnabled() && !isClerkMigrationEnabled()) {
    errors.push('CLERK_USER_SYNC_ENABLED requires CLERK_MIGRATION_ENABLED=true');
  }
  
  // Dual mode requires migration to be enabled
  if (isDualModeEnabled() && !isClerkMigrationEnabled()) {
    errors.push('DUAL_AUTH_MODE requires CLERK_MIGRATION_ENABLED=true');
  }
  
  // Can't be in dual mode AND have native IDs enabled (those are sequential phases)
  if (isDualModeEnabled() && isClerkNativeIdsEnabled()) {
    errors.push('DUAL_AUTH_MODE and CLERK_NATIVE_IDS_ENABLED are mutually exclusive');
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Startup Check
// ---------------------------------------------------------------------------

/**
 * Check feature flags at startup and warn about inconsistencies
 */
export function checkMigrationFlagsAtStartup(): void {
  const validation = validateMigrationFlags();
  
  if (!validation.valid) {
    log.error({ errors: validation.errors }, "Invalid Clerk migration feature flag configuration");
    throw new Error('Invalid Clerk migration configuration');
  }
  
  // Log current configuration
  if (isClerkMigrationEnabled()) {
    logMigrationConfig();
  }
}
