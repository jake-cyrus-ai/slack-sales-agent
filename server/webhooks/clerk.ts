/**
 * Clerk Webhook Handler
 *
 * Receives Clerk webhook events and syncs organization/user data to Supabase.
 * Clerk is the source of truth for auth; this handler keeps Supabase tables
 * in sync so that existing RLS policies continue to work.
 *
 * Events handled:
 *   - organization.created   -> INSERT into organizations
 *   - organization.updated   -> UPDATE organizations
 *   - organization.deleted   -> DELETE from organizations
 *   - organizationMembership.created -> INSERT into organization_users
 *   - organizationMembership.updated -> UPDATE organization_users.role
 *   - organizationMembership.deleted -> DELETE from organization_users
 *   - user.created           -> INSERT/UPDATE profiles
 *   - user.updated           -> UPDATE profiles
 *   - user.deleted           -> DELETE all user data via delete_user_data RPC
 *
 * Webhook signature verification uses svix (Clerk's webhook infrastructure).
 * Configure the signing secret via CLERK_WEBHOOK_SIGNING_SECRET env var.
 */

import { Router, Request, Response } from "express";
import { Webhook } from "svix";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../lib/logger";

// ---------------------------------------------------------------------------
// Types for Clerk webhook payloads
// ---------------------------------------------------------------------------

interface ClerkOrganizationData {
  id: string;
  name: string;
  slug: string;
  created_at: number;
  updated_at: number;
  image_url?: string;
  max_allowed_memberships?: number;
  public_metadata?: Record<string, unknown>;
  private_metadata?: Record<string, unknown>;
}

interface ClerkOrganizationMembershipData {
  id: string;
  organization: { id: string; name: string; slug: string };
  public_user_data: {
    user_id: string;
    first_name: string | null;
    last_name: string | null;
    image_url: string | null;
    identifier: string; // usually primary email
  };
  role: string; // e.g. "org:admin", "org:member"
  created_at: number;
  updated_at: number;
}

interface ClerkUserData {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email_addresses: Array<{
    id: string;
    email_address: string;
  }>;
  primary_email_address_id: string;
  image_url: string | null;
  created_at: number;
  updated_at: number;
  public_metadata?: Record<string, unknown>;
}

// Clerk user.deleted payload is minimal — only id and deleted flag are guaranteed.
interface ClerkDeletedUserData {
  id: string;
  deleted?: boolean;
}

interface ClerkWebhookEvent {
  type: string;
  data: ClerkOrganizationData | ClerkOrganizationMembershipData | ClerkUserData | ClerkDeletedUserData;
  object: string;
}

// ---------------------------------------------------------------------------
// Supabase admin client (service role — bypasses RLS)
// ---------------------------------------------------------------------------

let _supabaseAdmin: SupabaseClient | null = null;

const getSupabaseAdmin = (): SupabaseClient => {
  if (_supabaseAdmin) return _supabaseAdmin;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  _supabaseAdmin = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return _supabaseAdmin;
};

// ---------------------------------------------------------------------------
// Helper: map Clerk org role string to our DB role enum
// ---------------------------------------------------------------------------

/**
 * Maps a Clerk organization role to the database role value.
 * Only org-level roles are valid here; platform-level roles are stored
 * separately in user_roles / Clerk publicMetadata and are NOT org roles.
 *
 * DB CHECK constraint: role IN ('owner', 'admin', 'member')
 */
const mapClerkRoleToDbRole = (clerkRole: string): string => {
  switch (clerkRole) {
    case "org:admin":
    case "org:platform_admin":
      return "admin";
    case "org:owner":
      return "owner";
    case "org:member":
    default:
      return "member";
  }
};

// ---------------------------------------------------------------------------
// Helper: extract primary email from Clerk user data
// ---------------------------------------------------------------------------

const getPrimaryEmail = (userData: ClerkUserData): string | null => {
  const primary = userData.email_addresses.find(
    (e) => e.id === userData.primary_email_address_id
  );
  return primary?.email_address ?? userData.email_addresses[0]?.email_address ?? null;
};

// ---------------------------------------------------------------------------
// Helper: check if a Clerk user exists in profiles
// ---------------------------------------------------------------------------

/**
 * Checks if a profile exists for the given Clerk user ID.
 * After migration, profiles.user_id IS the Clerk ID directly.
 *
 * Returns the Clerk user ID if the profile exists, null otherwise.
 */
const checkUserExists = async (
  supabase: SupabaseClient,
  clerkUserId: string
): Promise<string | null> => {
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("user_id")
    .eq("user_id", clerkUserId)
    .maybeSingle();

  if (error) {
    logger.error({ err: error }, "[clerk-webhook] Error looking up profile by user_id");
    return null;
  }

  return profile?.user_id ?? null;
};

// ---------------------------------------------------------------------------
// Helper: get or create a user profile
// ---------------------------------------------------------------------------

/**
 * Ensures a profile exists for the given Clerk user. If the profile doesn't
 * exist (e.g., user.created webhook hasn't arrived yet), creates a minimal
 * profile from the provided user data.
 *
 * This handles the webhook ordering edge case where organizationMembership.created
 * arrives before user.created.
 *
 * Returns the Clerk user ID if successful, null on error.
 */
const getOrCreateProfile = async (
  supabase: SupabaseClient,
  userData: {
    clerkUserId: string;
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    imageUrl?: string | null;
  }
): Promise<string | null> => {
  const existingUserId = await checkUserExists(supabase, userData.clerkUserId);
  if (existingUserId) {
    return existingUserId;
  }

  logger.info({ clerkUserId: userData.clerkUserId }, "[clerk-webhook] Profile not found, auto-creating from membership data");

  const { error } = await supabase.from("profiles").upsert(
    {
      user_id: userData.clerkUserId,
      email: userData.email,
      first_name: userData.firstName ?? null,
      last_name: userData.lastName ?? null,
      avatar_url: userData.imageUrl ?? null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );

  if (error) {
    logger.error({ err: error }, "[clerk-webhook] Failed to auto-create profile");
    return null;
  }

  logger.info({ email: userData.email, clerkUserId: userData.clerkUserId }, "[clerk-webhook] Profile auto-created");

  return userData.clerkUserId;
};

// ---------------------------------------------------------------------------
// Helper: resolve internal organization UUID from Clerk org ID
// ---------------------------------------------------------------------------

const resolveOrgId = async (
  supabase: SupabaseClient,
  clerkOrgId: string
): Promise<string | null> => {
  const { data: org, error } = await supabase
    .from("organizations")
    .select("id")
    .eq("clerk_id", clerkOrgId)
    .maybeSingle();

  if (error) {
    logger.error({ err: error }, "[clerk-webhook] Error looking up org by clerk_id");
    return null;
  }

  return org?.id ?? null;
};

// ---------------------------------------------------------------------------
// Event handlers — Organizations
// ---------------------------------------------------------------------------

const handleOrganizationCreated = async (data: ClerkOrganizationData) => {
  const supabase = getSupabaseAdmin();

  const { error } = await supabase.from("organizations").upsert(
    {
      clerk_id: data.id,
      name: data.name,
      slug: data.slug,
      logo_url: data.image_url ?? null,
      created_at: new Date(data.created_at).toISOString(),
      updated_at: new Date(data.updated_at).toISOString(),
    },
    { onConflict: "clerk_id" }
  );

  if (error) {
    logger.error({ err: error }, "[clerk-webhook] Failed to upsert organization");
    throw error;
  }

  logger.info({ name: data.name, clerkOrgId: data.id }, "[clerk-webhook] Organization created/upserted");
};

const handleOrganizationUpdated = async (data: ClerkOrganizationData) => {
  const supabase = getSupabaseAdmin();

  const { error } = await supabase
    .from("organizations")
    .update({
      name: data.name,
      slug: data.slug,
      logo_url: data.image_url ?? null,
      updated_at: new Date(data.updated_at).toISOString(),
    })
    .eq("clerk_id", data.id);

  if (error) {
    logger.error({ err: error }, "[clerk-webhook] Failed to update organization");
    throw error;
  }

  logger.info({ name: data.name, clerkOrgId: data.id }, "[clerk-webhook] Organization updated");
};

const handleOrganizationDeleted = async (data: ClerkOrganizationData) => {
  const supabase = getSupabaseAdmin();

  const orgId = await resolveOrgId(supabase, data.id);

  if (orgId) {
    const { error: membershipError } = await supabase
      .from("organization_users")
      .delete()
      .eq("organization_id", orgId);

    if (membershipError) {
      logger.error({ err: membershipError }, "[clerk-webhook] Failed to delete org memberships");
      throw membershipError;
    }

    logger.info({ orgId }, "[clerk-webhook] Deleted org memberships");
  }

  const { error } = await supabase
    .from("organizations")
    .delete()
    .eq("clerk_id", data.id);

  if (error) {
    logger.error({ err: error }, "[clerk-webhook] Failed to delete organization");
    throw error;
  }

  logger.info({ clerkOrgId: data.id }, "[clerk-webhook] Organization deleted");
};

// ---------------------------------------------------------------------------
// Event handlers — Organization Memberships
// ---------------------------------------------------------------------------

const handleMembershipCreated = async (data: ClerkOrganizationMembershipData) => {
  const supabase = getSupabaseAdmin();

  // 1. Resolve the internal org UUID from Clerk org ID.
  //    If the org doesn't exist yet (e.g. organization.created webhook failed
  //    or arrived out of order), auto-create it from the embedded org data
  //    that Clerk includes in every membership event.
  let orgId = await resolveOrgId(supabase, data.organization.id);

  if (!orgId) {
    logger.warn({ clerkOrgId: data.organization.id }, "[clerk-webhook] Organization not found for membership, auto-creating");

    const { data: newOrg, error: orgError } = await supabase
      .from("organizations")
      .upsert(
        {
          clerk_id: data.organization.id,
          name: data.organization.name,
          slug: data.organization.slug,
        },
        { onConflict: "clerk_id" }
      )
      .select("id")
      .single();

    if (orgError || !newOrg) {
      logger.error({ err: orgError }, "[clerk-webhook] Failed to auto-create organization");
      throw new Error(`Organization not found and auto-create failed: ${data.organization.id}`);
    }

    orgId = newOrg.id;
    logger.info({ name: data.organization.name, clerkOrgId: data.organization.id, orgId }, "[clerk-webhook] Organization auto-created");
  }

  // 2. Use Clerk user ID directly (no resolution needed post-migration)
  //    If the profile doesn't exist yet (user.created webhook arrived late),
  //    auto-create a minimal profile from the embedded user data.
  const clerkUserId = data.public_user_data.user_id;

  const profileUserId = await getOrCreateProfile(supabase, {
    clerkUserId,
    email: data.public_user_data.identifier,
    firstName: data.public_user_data.first_name,
    lastName: data.public_user_data.last_name,
    imageUrl: data.public_user_data.image_url,
  });

  if (!profileUserId) {
    logger.error({ clerkUserId, clerkOrgId: data.organization.id }, "[clerk-webhook] Failed to ensure user profile for membership");
    return;
  }

  // 3. Check if membership already exists (handles webhook retries gracefully
  //    without requiring a unique constraint on organization_id + user_id)
  const { data: existing } = await supabase
    .from("organization_users")
    .select("id")
    .eq("user_id", clerkUserId)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (existing) {
    // Already exists — update role in case it changed
    const { error } = await supabase
      .from("organization_users")
      .update({ role: mapClerkRoleToDbRole(data.role) })
      .eq("id", existing.id);

    if (error) {
      logger.error({ err: error }, "[clerk-webhook] Failed to update existing membership");
      throw error;
    }

    logger.info({ clerkUserId, orgId, role: data.role }, "[clerk-webhook] Membership already existed, updated role");
    return;
  }

  const { error } = await supabase.from("organization_users").insert({
    user_id: clerkUserId,
    organization_id: orgId,
    role: mapClerkRoleToDbRole(data.role),
    joined_at: new Date(data.created_at).toISOString(),
  });

  if (error) {
    logger.error({ err: error }, "[clerk-webhook] Failed to insert membership");
    throw error;
  }

  logger.info({ clerkUserId, orgId, role: data.role }, "[clerk-webhook] Membership created");
};

const handleMembershipUpdated = async (data: ClerkOrganizationMembershipData) => {
  const supabase = getSupabaseAdmin();

  const orgId = await resolveOrgId(supabase, data.organization.id);

  if (!orgId) {
    logger.warn({ clerkOrgId: data.organization.id }, "[clerk-webhook] Organization not found for membership update, skipping");
    return;
  }

  const clerkUserId = data.public_user_data.user_id;

  // Ensure profile exists (handles late webhook ordering)
  const profileUserId = await getOrCreateProfile(supabase, {
    clerkUserId,
    email: data.public_user_data.identifier,
    firstName: data.public_user_data.first_name,
    lastName: data.public_user_data.last_name,
    imageUrl: data.public_user_data.image_url,
  });

  if (!profileUserId) {
    logger.error({ clerkUserId, clerkOrgId: data.organization.id }, "[clerk-webhook] Failed to ensure user profile for membership update");
    return;
  }

  const { error } = await supabase
    .from("organization_users")
    .update({
      role: mapClerkRoleToDbRole(data.role),
    })
    .eq("user_id", clerkUserId)
    .eq("organization_id", orgId);

  if (error) {
    logger.error({ err: error }, "[clerk-webhook] Failed to update membership");
    throw error;
  }

  logger.info({ clerkUserId, orgId, role: data.role }, "[clerk-webhook] Membership updated");
};

const handleMembershipDeleted = async (data: ClerkOrganizationMembershipData) => {
  const supabase = getSupabaseAdmin();

  const orgId = await resolveOrgId(supabase, data.organization.id);

  if (!orgId) {
    logger.warn({ clerkOrgId: data.organization.id }, "[clerk-webhook] Organization not found for membership delete, skipping");
    return;
  }

  const clerkUserId = data.public_user_data.user_id;

  // For deletes, we only need to check if the profile exists — no need to create
  const userExists = await checkUserExists(supabase, clerkUserId);

  if (!userExists) {
    logger.warn({ clerkUserId, clerkOrgId: data.organization.id }, "[clerk-webhook] User profile does not exist for membership delete, skipping");
    return;
  }

  const { error } = await supabase
    .from("organization_users")
    .delete()
    .eq("user_id", clerkUserId)
    .eq("organization_id", orgId);

  if (error) {
    logger.error({ err: error }, "[clerk-webhook] Failed to delete membership");
    throw error;
  }

  logger.info({ clerkUserId, orgId }, "[clerk-webhook] Membership deleted");
};

// ---------------------------------------------------------------------------
// Event handlers — Users
// ---------------------------------------------------------------------------

/**
 * Handles user.created events from Clerk.
 *
 * Post-migration: profiles.user_id IS the Clerk user ID directly.
 * This handler creates a new profile record with the Clerk ID as the primary key.
 */
const handleUserCreated = async (data: ClerkUserData) => {
  const supabase = getSupabaseAdmin();
  const email = getPrimaryEmail(data);

  if (!email) {
    throw new Error(
      `[clerk-webhook] user.created event has no email address for user ${data.id} — cannot create profile`
    );
  }

  const clerkUserId = data.id; // e.g., "user_2xxx"

  // Upsert profile with Clerk ID as the primary key
  const { error } = await supabase.from("profiles").upsert(
    {
      user_id: clerkUserId, // Clerk ID is the primary user identifier
      email,
      first_name: data.first_name,
      last_name: data.last_name,
      avatar_url: data.image_url,
      created_at: new Date(data.created_at).toISOString(),
      updated_at: new Date(data.updated_at).toISOString(),
    },
    { onConflict: "user_id" }
  );

  if (error) {
    logger.error({ err: error }, "[clerk-webhook] Failed to create/update profile");
    throw error;
  }

  logger.info({ email, clerkUserId }, "[clerk-webhook] Profile created/updated");
};

const handleUserDeleted = async (data: ClerkDeletedUserData) => {
  const supabase = getSupabaseAdmin();
  const clerkUserId = data.id;

  // Atomically delete all user-owned data via the delete_user_data RPC.
  // Runs in a single transaction — any failure rolls back so Clerk can retry.
  const { error } = await supabase.rpc("delete_user_data", {
    p_user_id: clerkUserId,
  });

  if (error) {
    logger.error({ err: error, clerkUserId }, "[clerk-webhook] Failed to delete user data");
    throw error;
  }

  logger.info({ clerkUserId }, "[clerk-webhook] User data deleted");
};

const handleUserUpdated = async (data: ClerkUserData) => {
  const supabase = getSupabaseAdmin();
  const email = getPrimaryEmail(data);
  const clerkUserId = data.id;

  // Update profile using Clerk ID directly
  const { error } = await supabase
    .from("profiles")
    .update({
      email,
      first_name: data.first_name,
      last_name: data.last_name,
      avatar_url: data.image_url,
      updated_at: new Date(data.updated_at).toISOString(),
    })
    .eq("user_id", clerkUserId);

  if (error) {
    logger.error({ err: error }, "[clerk-webhook] Failed to update profile");
    throw error;
  }

  logger.info({ email, clerkUserId }, "[clerk-webhook] Profile updated");
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const clerkWebhookRouter = Router();

/**
 * POST /api/webhooks/clerk
 *
 * Receives Clerk webhook events, verifies the svix signature, and dispatches
 * to the appropriate handler to keep Supabase in sync.
 *
 * IMPORTANT: This endpoint needs access to the raw request body for svix
 * signature verification. The raw body is captured by the global JSON
 * middleware's `verify` callback and stored on `req.rawBody`.
 */
clerkWebhookRouter.post(
  "/",
  async (req: Request, res: Response) => {
    const log = (req as any).log ?? logger;

    try {
      log.info("Clerk webhook received");

      // 1. Verify webhook signature using svix
      const signingSecret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;

      if (!signingSecret) {
        log.error("[clerk-webhook] CLERK_WEBHOOK_SIGNING_SECRET is not set");
        return res.status(500).json({
          error: "Webhook signing secret not configured",
          requestId: (req as any).id,
        });
      }

      const svixId = req.headers["svix-id"] as string;
      const svixTimestamp = req.headers["svix-timestamp"] as string;
      const svixSignature = req.headers["svix-signature"] as string;

      if (!svixId || !svixTimestamp || !svixSignature) {
        log.warn("Missing svix headers");
        return res.status(400).json({
          error: "Missing svix verification headers",
          requestId: (req as any).id,
        });
      }

      const wh = new Webhook(signingSecret);
      let event: ClerkWebhookEvent;

      try {
        // Use the raw body captured by the JSON middleware's verify callback.
        // Falls back to JSON.stringify for compatibility, but this may cause
        // verification failures if the serialization differs from the original.
        const body = (req as any).rawBody || JSON.stringify(req.body);

        event = wh.verify(body, {
          "svix-id": svixId,
          "svix-timestamp": svixTimestamp,
          "svix-signature": svixSignature,
        }) as ClerkWebhookEvent;
      } catch (verifyError) {
        log.warn({ err: verifyError }, "Clerk webhook signature verification failed");
        return res.status(401).json({
          error: "Unauthorized - Invalid webhook signature",
          requestId: (req as any).id,
        });
      }

      log.info({ eventType: event.type }, "Clerk webhook verified");

      // 2. Dispatch to the appropriate handler
      switch (event.type) {
        case "organization.created":
          await handleOrganizationCreated(event.data as ClerkOrganizationData);
          break;

        case "organization.updated":
          await handleOrganizationUpdated(event.data as ClerkOrganizationData);
          break;

        case "organization.deleted":
          await handleOrganizationDeleted(event.data as ClerkOrganizationData);
          break;

        case "organizationMembership.created":
          await handleMembershipCreated(event.data as ClerkOrganizationMembershipData);
          break;

        case "organizationMembership.updated":
          await handleMembershipUpdated(event.data as ClerkOrganizationMembershipData);
          break;

        case "organizationMembership.deleted":
          await handleMembershipDeleted(event.data as ClerkOrganizationMembershipData);
          break;

        case "user.created":
          await handleUserCreated(event.data as ClerkUserData);
          break;

        case "user.updated":
          await handleUserUpdated(event.data as ClerkUserData);
          break;

        case "user.deleted":
          await handleUserDeleted(event.data as ClerkDeletedUserData);
          break;

        default:
          log.info({ eventType: event.type }, "Unhandled Clerk webhook event type");
      }

      res.status(200).json({
        success: true,
        type: event.type,
        requestId: (req as any).id,
      });
    } catch (error) {
      // Webhooks must return 2xx so Clerk does not retry the delivery
      // indefinitely on a permanent handler failure (which would re-run the
      // org/user sync handlers and risk duplicate rows). The error is logged
      // for observability; Clerk treats the 200 as acknowledged.
      log.error({ err: error }, "Clerk webhook handler error");
      res.status(200).json({ received: true, error: "handler_error" });
    }
  }
);
