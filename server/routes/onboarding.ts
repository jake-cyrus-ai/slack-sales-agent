/**
 * Customer onboarding routes — writes formerly done directly from the browser
 * (CustomerOnboarding.tsx) against Supabase, now routed through Express.
 *
 * Routes:
 * - PUT  /api/onboarding/progress      — upsert onboarding_progress for an org
 * - POST /api/onboarding/invites       — create team invites during onboarding
 * - POST /api/onboarding/join-org      — add the caller to an org as a member
 * - POST /api/onboarding/accept-invite — mark an invite accepted by the caller
 *
 * Authorization model: the customer onboarding flow is gated by possession of
 * a valid, pending, unexpired invite token. The caller is a freshly signed-up
 * Clerk user who is NOT yet a member of the org and has no active Clerk org —
 * so org-admin checks (as in admin.ts) don't apply here. Instead, every route
 * validates the supplied invite token against `organization_invites` and
 * derives the target organization from that row. The token is the capability.
 *
 * All routes are `requireAuth()` gated so the acting user id comes from the
 * Clerk session (getAuth) and can never be spoofed by the client.
 */

import { Router, type Response } from "express";
import { getAuth, requireAuth } from "@clerk/express";
import { z } from "zod";
import crypto from "crypto";
import type { Request } from "../types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { validateBody } from "../lib/validate";
// RLS bypass justification: the caller is a brand-new user who is not yet a
// member of the target org, so a user-scoped (RLS-enforced) client could not
// read the invite or write the membership rows. Authorization is enforced at
// the app layer by validating the invite token on every route.
import { getSupabaseAdmin } from "../lib/supabase";

const router = Router();

const generateToken = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

type ValidInvite = {
  id: string;
  organization_id: string;
  token: string;
  status: string;
  expires_at: string;
};

type InviteRejection = { status: number; error: string };

/**
 * Loads the invite for `token` and validates it is pending + not expired.
 * Returns the invite row on success, or an `{ status, error }` rejection.
 */
const loadValidInvite = async (
  supabase: SupabaseClient,
  token: string,
  log: Request["log"],
): Promise<ValidInvite | InviteRejection> => {
  const { data: invite, error } = await supabase
    .from("organization_invites")
    .select("id, organization_id, token, status, expires_at")
    .eq("token", token)
    .maybeSingle();

  if (error) {
    log.error({ err: error }, "Error loading invite by token");
    return { status: 500, error: "Failed to validate invite" };
  }
  if (!invite) {
    return { status: 404, error: "Invite not found" };
  }
  if (invite.status !== "pending") {
    return { status: 409, error: "Invite is no longer pending" };
  }
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    return { status: 410, error: "Invite has expired" };
  }
  return invite as ValidInvite;
};

const isRejection = (
  v: ValidInvite | InviteRejection,
): v is InviteRejection => "error" in v && "status" in v;

// ---------------------------------------------------------------------------
// PUT /api/onboarding/progress
//
// Upsert onboarding_progress for the org tied to the supplied invite token.
// onboarding_progress is unique on organization_id, so this is an upsert with
// onConflict: organization_id.
// ---------------------------------------------------------------------------
const progressSchema = z
  .object({
    inviteToken: z.string().min(1).max(256),
    currentStep: z.number().int().min(1).max(5),
    completed: z.boolean().optional().default(false),
  })
  .strict();

router.put(
  "/onboarding/progress",
  requireAuth(),
  async (req: Request, res: Response) => {
    const { userId } = getAuth(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized", requestId: req.id });
    }

    const body = validateBody(progressSchema, req, res);
    if (!body) return;

    try {
      const supabase = getSupabaseAdmin();
      const invite = await loadValidInvite(supabase, body.inviteToken, req.log);
      if (isRejection(invite)) {
        return res
          .status(invite.status)
          .json({ error: invite.error, requestId: req.id });
      }

      const step = body.currentStep;
      const completed = body.completed;
      const stepsCompleted = {
        "1": step >= 1 || completed,
        "2": step >= 2 || completed,
        "3": step >= 3 || completed,
        "4": step >= 4 || completed,
        "5": completed,
      };
      const status = completed
        ? "completed"
        : step > 1
          ? "in_progress"
          : "not_started";

      const { error } = await supabase
        .from("onboarding_progress")
        .upsert(
          {
            organization_id: invite.organization_id,
            current_step: step,
            status,
            steps_completed: stepsCompleted,
            last_updated: new Date().toISOString(),
            ...(completed && {
              completed_at: new Date().toISOString(),
              completed_by: userId,
            }),
          },
          { onConflict: "organization_id" },
        );

      if (error) {
        req.log.error(
          { err: error, organizationId: invite.organization_id },
          "Error saving onboarding progress",
        );
        return res
          .status(500)
          .json({ error: error.message, requestId: req.id });
      }

      req.log.info(
        { organizationId: invite.organization_id, step, status },
        "Onboarding progress saved",
      );
      return res.json({ success: true, requestId: req.id });
    } catch (error) {
      req.log.error({ err: error }, "Error saving onboarding progress");
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Internal server error",
        requestId: req.id,
      });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/onboarding/invites
//
// Create team-member invites during onboarding. The caller proves they may
// invite into the org by supplying the invite token they were onboarded with.
// Tokens for the new invites are generated server-side and returned so the UI
// can show shareable links.
// ---------------------------------------------------------------------------
const invitesSchema = z
  .object({
    inviteToken: z.string().min(1).max(256),
    emails: z.array(z.string().email()).min(1).max(50),
  })
  .strict();

router.post(
  "/onboarding/invites",
  requireAuth(),
  async (req: Request, res: Response) => {
    const { userId } = getAuth(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized", requestId: req.id });
    }

    const body = validateBody(invitesSchema, req, res);
    if (!body) return;

    try {
      const supabase = getSupabaseAdmin();
      const invite = await loadValidInvite(supabase, body.inviteToken, req.log);
      if (isRejection(invite)) {
        return res
          .status(invite.status)
          .json({ error: invite.error, requestId: req.id });
      }

      const rows = body.emails.map((email) => ({
        organization_id: invite.organization_id,
        token: generateToken(),
        email: email.trim(),
        created_by: userId,
        status: "pending" as const,
      }));

      const { data: created, error } = await supabase
        .from("organization_invites")
        .insert(rows)
        .select("id, organization_id, token, email, status, expires_at");

      if (error) {
        req.log.error(
          { err: error, organizationId: invite.organization_id },
          "Error creating onboarding invites",
        );
        return res
          .status(500)
          .json({ error: error.message, requestId: req.id });
      }

      req.log.info(
        { organizationId: invite.organization_id, count: created?.length ?? 0 },
        "Created onboarding team invites",
      );
      return res
        .status(201)
        .json({ invites: created ?? [], requestId: req.id });
    } catch (error) {
      req.log.error({ err: error }, "Error creating onboarding invites");
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Internal server error",
        requestId: req.id,
      });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/onboarding/join-org
//
// Add the authenticated caller to the org tied to the invite token. Idempotent
// — if they're already a member the existing membership is returned. The role
// matches the existing onboarding behavior ("owner" for the user accepting the
// org's onboarding invite).
// ---------------------------------------------------------------------------
const joinOrgSchema = z
  .object({
    inviteToken: z.string().min(1).max(256),
  })
  .strict();

router.post(
  "/onboarding/join-org",
  requireAuth(),
  async (req: Request, res: Response) => {
    const { userId } = getAuth(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized", requestId: req.id });
    }

    const body = validateBody(joinOrgSchema, req, res);
    if (!body) return;

    try {
      const supabase = getSupabaseAdmin();
      const invite = await loadValidInvite(supabase, body.inviteToken, req.log);
      if (isRejection(invite)) {
        return res
          .status(invite.status)
          .json({ error: invite.error, requestId: req.id });
      }

      // Idempotent — skip the insert if the caller is already a member.
      const { data: existing, error: lookupError } = await supabase
        .from("organization_users")
        .select("id")
        .eq("user_id", userId)
        .eq("organization_id", invite.organization_id)
        .maybeSingle();

      if (lookupError) {
        req.log.error(
          { err: lookupError, organizationId: invite.organization_id },
          "Error checking existing membership",
        );
        return res
          .status(500)
          .json({ error: lookupError.message, requestId: req.id });
      }

      if (existing) {
        return res.json({
          success: true,
          alreadyMember: true,
          requestId: req.id,
        });
      }

      const { error } = await supabase.from("organization_users").insert({
        organization_id: invite.organization_id,
        user_id: userId,
        role: "owner",
      });

      if (error) {
        req.log.error(
          { err: error, organizationId: invite.organization_id },
          "Error adding user to organization",
        );
        return res
          .status(500)
          .json({ error: error.message, requestId: req.id });
      }

      req.log.info(
        { organizationId: invite.organization_id, userId },
        "User joined organization via onboarding",
      );
      return res
        .status(201)
        .json({ success: true, alreadyMember: false, requestId: req.id });
    } catch (error) {
      req.log.error({ err: error }, "Error joining organization");
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Internal server error",
        requestId: req.id,
      });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/onboarding/accept-invite
//
// Mark the invite identified by the token as accepted by the authenticated
// caller. Used at the end of the onboarding flow.
// ---------------------------------------------------------------------------
const acceptInviteSchema = z
  .object({
    inviteToken: z.string().min(1).max(256),
  })
  .strict();

router.post(
  "/onboarding/accept-invite",
  requireAuth(),
  async (req: Request, res: Response) => {
    const { userId } = getAuth(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized", requestId: req.id });
    }

    const body = validateBody(acceptInviteSchema, req, res);
    if (!body) return;

    try {
      const supabase = getSupabaseAdmin();
      const invite = await loadValidInvite(supabase, body.inviteToken, req.log);
      if (isRejection(invite)) {
        return res
          .status(invite.status)
          .json({ error: invite.error, requestId: req.id });
      }

      const { error } = await supabase
        .from("organization_invites")
        .update({
          status: "accepted",
          accepted_by: userId,
          accepted_at: new Date().toISOString(),
        })
        .eq("id", invite.id);

      if (error) {
        req.log.error(
          { err: error, inviteId: invite.id },
          "Error marking invite accepted",
        );
        return res
          .status(500)
          .json({ error: error.message, requestId: req.id });
      }

      req.log.info(
        { inviteId: invite.id, organizationId: invite.organization_id, userId },
        "Onboarding invite accepted",
      );
      return res.json({ success: true, requestId: req.id });
    } catch (error) {
      req.log.error({ err: error }, "Error accepting invite");
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Internal server error",
        requestId: req.id,
      });
    }
  },
);

export default router;
