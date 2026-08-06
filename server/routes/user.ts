/**
 * Protected User API Routes
 *
 * These routes require a verified Supabase Auth session.
 * They provide the frontend with the authenticated user's context
 * (userId, orgId, orgRole) without needing extra DB queries.
 */

import { Router, Response } from "express";
import crypto from "node:crypto";
import { getAuth, requireAuth } from "../lib/auth";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Request } from "../types";
import { getSupabaseForRequest } from "../lib/supabase";
import { validateBody } from "../lib/validate";

// ---------------------------------------------------------------------------
// Supabase admin client (service role — bypasses RLS)
// ---------------------------------------------------------------------------

const getSupabaseAdmin = () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
};

const router = Router();

/**
 * GET /api/user
 *
 * Returns the authenticated user's Supabase auth and organization context.
 *
 * Response:
 *   { userId, orgId, orgRole, orgSlug, sessionId }
 */
router.get(
  "/user",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const { userId, orgId, orgRole, orgSlug, sessionId } = auth;

      if (!userId) {
        return res.status(401).json({
          error: "Unauthorized - No user ID in session",
          requestId: req.id,
        });
      }

      req.log.info({ userId, orgId: orgId || "none", orgRole: orgRole || "none" }, "User context retrieved");

      return res.json({
        userId,
        orgId: orgId || null,
        orgRole: orgRole || null,
        orgSlug: orgSlug || null,
        sessionId: sessionId || null,
      });
    } catch (error) {
      req.log.error({ err: error }, "Error fetching user context");
      return res.status(500).json({
        error: "Failed to retrieve user context",
        requestId: req.id,
      });
    }
  }
);

/**
 * GET /api/user/profile
 *
 * Returns the authenticated user's profile from Supabase.
 *
 * Response:
 *   { id, email, first_name, last_name, avatar_url, ... }
 */
router.get(
  "/user/profile",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const { userId } = getAuth(req);

      if (!userId) {
        return res.status(401).json({
          error: "Unauthorized - No user ID in session",
          requestId: req.id,
        });
      }

      const supabase = getSupabaseAdmin();

      const { data: profile, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) {
        req.log.error({ err: error, userId }, "Error fetching profile");
        return res.status(500).json({
          error: "Error fetching profile",
          requestId: req.id,
        });
      }

      if (!profile) {
        req.log.warn({ userId }, "Profile not found");
        return res.status(404).json({
          error: "Profile not found",
          requestId: req.id,
        });
      }

      req.log.info({ userId }, "Profile retrieved");

      return res.json(profile);
    } catch (error) {
      req.log.error({ err: error }, "Error fetching profile");
      return res.status(500).json({
        error: "Failed to retrieve profile",
        requestId: req.id,
      });
    }
  }
);

/**
 * GET /api/user/organization
 *
 * Returns the authenticated user's active organization details and membership.
 * Uses the validated active organization from the request header or first membership.
 *
 * Response:
 *   { organization: { id, name, slug, ... }, membership: { role, ... } }
 */
router.get(
  "/user/organization",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const { userId, orgId, orgRole } = getAuth(req);

      if (!userId) {
        return res.status(401).json({
          error: "Unauthorized - No user ID in session",
          requestId: req.id,
        });
      }

      if (!orgId) {
        return res.status(400).json({
          error: "No active organization selected",
          requestId: req.id,
        });
      }

      const supabase = getSupabaseAdmin();

      // orgId is already an internal UUID validated by the auth middleware.
      const { data: organization, error: orgError } = await supabase
        .from("organizations")
        .select("*")
        .eq("id", orgId)
        .single();

      if (orgError || !organization) {
        req.log.warn({ err: orgError, orgId }, "Organization not found");
        return res.status(404).json({
          error: "Organization not found",
          requestId: req.id,
        });
      }

      // Fetch the user's membership in this organization
      const { data: membership, error: memberError } = await supabase
        .from("organization_users")
        .select("*")
        .eq("user_id", userId)
        .eq("organization_id", organization.id)
        .single();

      if (memberError) {
        req.log.warn({ err: memberError, userId, orgId: organization.id }, "Membership not found");
      }

      req.log.info({ orgId, orgRole: orgRole || "none" }, "Organization context retrieved");

      return res.json({
        organization,
        membership: membership || null,
        orgRole: orgRole || null,
      });
    } catch (error) {
      req.log.error({ err: error }, "Error fetching organization context");
      return res.status(500).json({
        error: "Failed to retrieve organization context",
        requestId: req.id,
      });
    }
  }
);

// ───────────────────────────────────────────────────────────────────────────
// User/profile writes
//
// These migrate browser → Supabase writes behind Express. Every route is
// gated by requireAuth() and derives the Supabase user id from getAuth(req) — a
// client-supplied user id is NEVER trusted. Each route uses a user-scoped
// Supabase client (getSupabaseForRequest) so RLS (`user_id = current_user_id()`)
// enforces the user boundary at the database in addition to the explicit
// `.eq("user_id", userId)` filters below — defense in depth.
// ───────────────────────────────────────────────────────────────────────────

const ensureProfileSchema = z.object({
  email: z.string().email().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
});

const updateProfileSchema = z.object({
  firstName: z.string().trim().min(1, "firstName is required"),
  lastName: z.string().trim().min(1, "lastName is required"),
});

const cookieConsentSchema = z.object({
  consent: z.enum(["accepted", "rejected"]),
});

const userContextSchema = z.object({
  communicationStyle: z.string().nullable().optional(),
  roleDescription: z.string().nullable().optional(),
  customContext: z.string().nullable().optional(),
  signaturePreferences: z
    .object({
      sign_off: z.string().optional(),
      use_first_name: z.boolean().optional(),
      include_title: z.boolean().optional(),
    })
    .optional(),
});

const markNotificationsReadSchema = z.object({
  channel: z.string().min(1, "channel is required"),
});

const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(100),
});

router.get("/user/organizations", requireAuth(), async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized", requestId: req.id });
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("organization_users")
    .select("role, joined_at, organizations!inner(id, name, slug)")
    .eq("user_id", userId)
    .order("joined_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message, requestId: req.id });
  return res.json({ organizations: data ?? [], requestId: req.id });
});

router.post("/user/organizations", requireAuth(), async (req: Request, res: Response) => {
  const body = validateBody(createOrganizationSchema, req, res);
  if (!body) return;
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized", requestId: req.id });
  const supabase = getSupabaseAdmin();
  const slugBase = body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "organization";
  const slug = `${slugBase}-${crypto.randomUUID().slice(0, 8)}`;
  const { data: organization, error: orgError } = await supabase
    .from("organizations")
    .insert({ name: body.name, slug, owner_user_id: userId })
    .select("id, name, slug")
    .single();
  if (orgError || !organization) {
    return res.status(500).json({ error: orgError?.message ?? "Could not create organization", requestId: req.id });
  }
  const { error: memberError } = await supabase.from("organization_users").insert({
    organization_id: organization.id,
    user_id: userId,
    role: "owner",
  });
  if (memberError) {
    await supabase.from("organizations").delete().eq("id", organization.id);
    return res.status(500).json({ error: memberError.message, requestId: req.id });
  }
  return res.status(201).json({ organization, role: "owner", requestId: req.id });
});

/**
 * POST /api/user/ensure-profile
 *
 * Upserts a minimal profile for the authenticated Supabase user. Idempotent on
 * `user_id`; identity fields come from the verified Auth user, not the client.
 */
router.post(
  "/user/ensure-profile",
  requireAuth(),
  async (req: Request, res: Response) => {
    const body = validateBody(ensureProfileSchema, req, res);
    if (!body) return;

    try {
      const { userId, user } = getAuth(req);
      if (!userId) {
        return res.status(401).json({
          error: "Unauthorized - No user ID in session",
          requestId: req.id,
        });
      }

      const metadata = user?.user_metadata ?? {};
      const email = user?.email || body.email;
      if (!email) {
        return res.status(400).json({
          error: "No email address available for profile creation",
          requestId: req.id,
        });
      }

      const supabase = getSupabaseForRequest(req);

      // Short-circuit if a profile already exists — keeps the route idempotent
      // without overwriting fields the user may have since edited.
      const { data: existing, error: fetchError } = await supabase
        .from("profiles")
        .select("user_id")
        .eq("user_id", userId)
        .maybeSingle();

      if (fetchError) {
        req.log.error({ err: fetchError, userId }, "Error checking for existing profile");
        return res.status(500).json({
          error: "Error checking profile",
          requestId: req.id,
        });
      }

      if (existing) {
        return res.json({ created: false, requestId: req.id });
      }

      const now = new Date().toISOString();
      const { error: upsertError } = await supabase.from("profiles").upsert(
        {
          user_id: userId,
          email,
          first_name: typeof metadata.first_name === "string" ? metadata.first_name : body.firstName ?? null,
          last_name: typeof metadata.last_name === "string" ? metadata.last_name : body.lastName ?? null,
          avatar_url: typeof metadata.avatar_url === "string" ? metadata.avatar_url : null,
          created_at: user?.created_at || now,
          updated_at: now,
        },
        { onConflict: "user_id" }
      );

      if (upsertError) {
        req.log.error({ err: upsertError, userId }, "Error creating profile");
        return res.status(500).json({
          error: "Error creating profile",
          requestId: req.id,
        });
      }

      req.log.info({ userId }, "Minimal profile created");
      return res.json({ created: true, requestId: req.id });
    } catch (error) {
      req.log.error({ err: error }, "Error in ensure-profile");
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Internal server error",
        requestId: req.id,
      });
    }
  }
);

/**
 * PATCH /api/user/profile
 *
 * Sets the caller's first/last name and marks the profile completed.
 */
router.patch(
  "/user/profile",
  requireAuth(),
  async (req: Request, res: Response) => {
    const body = validateBody(updateProfileSchema, req, res);
    if (!body) return;

    try {
      const { userId } = getAuth(req);
      if (!userId) {
        return res.status(401).json({
          error: "Unauthorized - No user ID in session",
          requestId: req.id,
        });
      }

      const supabase = getSupabaseForRequest(req);

      const { error } = await supabase
        .from("profiles")
        .update({
          first_name: body.firstName,
          last_name: body.lastName,
          profile_completed: true,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);

      if (error) {
        req.log.error({ err: error, userId }, "Error updating profile");
        return res.status(500).json({
          error: "Error updating profile",
          requestId: req.id,
        });
      }

      req.log.info({ userId }, "Profile updated");
      return res.json({ success: true, requestId: req.id });
    } catch (error) {
      req.log.error({ err: error }, "Error updating profile");
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Internal server error",
        requestId: req.id,
      });
    }
  }
);

/**
 * PUT /api/user/cookie-consent
 *
 * Records the caller's cookie-consent choice on their profile.
 */
router.put(
  "/user/cookie-consent",
  requireAuth(),
  async (req: Request, res: Response) => {
    const body = validateBody(cookieConsentSchema, req, res);
    if (!body) return;

    try {
      const { userId } = getAuth(req);
      if (!userId) {
        return res.status(401).json({
          error: "Unauthorized - No user ID in session",
          requestId: req.id,
        });
      }

      const supabase = getSupabaseForRequest(req);

      const { error } = await supabase
        .from("profiles")
        .update({
          cookie_consent: body.consent,
          cookie_consent_date: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);

      if (error) {
        req.log.error({ err: error, userId }, "Error saving cookie consent");
        return res.status(500).json({
          error: "Error saving cookie consent",
          requestId: req.id,
        });
      }

      req.log.info({ userId, consent: body.consent }, "Cookie consent saved");
      return res.json({ success: true, requestId: req.id });
    } catch (error) {
      req.log.error({ err: error }, "Error saving cookie consent");
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Internal server error",
        requestId: req.id,
      });
    }
  }
);

/**
 * PUT /api/user/context
 *
 * Upserts the caller's `user_context` row (communication style, role,
 * signature preferences, custom context). Idempotent — onConflict on user_id.
 */
router.put(
  "/user/context",
  requireAuth(),
  async (req: Request, res: Response) => {
    const body = validateBody(userContextSchema, req, res);
    if (!body) return;

    try {
      const { userId } = getAuth(req);
      if (!userId) {
        return res.status(401).json({
          error: "Unauthorized - No user ID in session",
          requestId: req.id,
        });
      }

      const supabase = getSupabaseForRequest(req);

      const { error } = await supabase.from("user_context").upsert(
        {
          user_id: userId,
          communication_style: body.communicationStyle ?? null,
          role_description: body.roleDescription ?? null,
          signature_preferences: body.signaturePreferences ?? {},
          custom_context: body.customContext ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );

      if (error) {
        req.log.error({ err: error, userId }, "Error saving user context");
        return res.status(500).json({
          error: "Error saving user context",
          requestId: req.id,
        });
      }

      req.log.info({ userId }, "User context saved");
      return res.json({ success: true, requestId: req.id });
    } catch (error) {
      req.log.error({ err: error }, "Error saving user context");
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Internal server error",
        requestId: req.id,
      });
    }
  }
);

/**
 * POST /api/user/notifications/mark-read
 *
 * Marks the caller's unread notifications in the given channel as read.
 * The update is explicitly scoped to the authenticated user — the previous
 * browser-side query filtered only by `channel`, which (under a service-role
 * client) would have touched every user's notifications.
 */
router.post(
  "/user/notifications/mark-read",
  requireAuth(),
  async (req: Request, res: Response) => {
    const body = validateBody(markNotificationsReadSchema, req, res);
    if (!body) return;

    try {
      const { userId } = getAuth(req);
      if (!userId) {
        return res.status(401).json({
          error: "Unauthorized - No user ID in session",
          requestId: req.id,
        });
      }

      const supabase = getSupabaseForRequest(req);

      const { error } = await supabase
        .from("notifications")
        .update({ read: true })
        .eq("user_id", userId)
        .eq("channel", body.channel)
        .eq("read", false);

      if (error) {
        req.log.error({ err: error, userId }, "Error marking notifications read");
        return res.status(500).json({
          error: "Error marking notifications read",
          requestId: req.id,
        });
      }

      req.log.info({ userId, channel: body.channel }, "Notifications marked read");
      return res.json({ success: true, requestId: req.id });
    } catch (error) {
      req.log.error({ err: error }, "Error marking notifications read");
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Internal server error",
        requestId: req.id,
      });
    }
  }
);

export default router;
