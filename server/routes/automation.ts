/**
 * Autonomous sales workflow API routes
 *
 * Provides data for the Agent Activity page:
 * - GET /automation/activity — paginated activity feed
 * - GET /automation/guardrails/status — current guardrail usage vs limits
 * - GET /automation/reminders — active reminders for the user
 */

import { Router, Response } from "express";
import { getAuth, requireAuth } from "../lib/auth";
import { isOrgAdmin } from "../lib/auth";
import { getSupabaseAdmin } from "../lib/supabase";
import { resolveInternalOrgId } from "../lib/org-resolver";
import { getActivitySummary } from "../workflows/utils/activity-summary";
import { getGuardrails, checkEmailRateLimit } from "../workflows/utils/feature-flags";
import { getLocalDate } from "../workflows/utils/timezone-helpers";
import { workflow } from "../workflows/client";
import type { Request } from "../types";

// ---------------------------------------------------------------------------
// active-organization-first variant — used for Attio/Salesforce integration checks so the
// Activity page sidebar matches the Profile -> Integrations page.
//
// Now unified with resolveInternalOrgId since both use the same 2-tier
// resolution: (1) Supabase Auth session org, (2) organization_users membership.
// Kept as a separate function for call-site clarity.
// ---------------------------------------------------------------------------
async function resolveCredentialOrgId(
  ...args: Parameters<typeof resolveInternalOrgId>
): Promise<string | null> {
  return resolveInternalOrgId(...args);
}

const router = Router();

/**
 * GET /api/automation/activity
 *
 * Returns today's activity summary for the authenticated user.
 * Optional query param: ?date=YYYY-MM-DD for a specific day.
 */
router.get(
  "/automation/activity",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const userId = auth.userId;
      const activeOrgId = auth.orgId;

      if (!userId || !activeOrgId) {
        res.status(401).json({ success: false, error: "Unauthorized", requestId: req.id });
        return;
      }

      const supabase = getSupabaseAdmin();
      const resolvedOrgId = await resolveInternalOrgId(supabase, userId, activeOrgId);
      if (!resolvedOrgId) {
        res.status(400).json({ success: false, error: "No organization found", requestId: req.id });
        return;
      }

      // Get user timezone (org already resolved above)
      const { data: profile } = await supabase
        .from("profiles")
        .select("timezone")
        .eq("user_id", userId)
        .maybeSingle();

      const tz = profile?.timezone || "America/New_York";
      const targetDate = (req.query.date as string) || getLocalDate(new Date().toISOString(), tz);

      const summary = await getActivitySummary(resolvedOrgId, userId, tz, targetDate);
      res.json({ success: true, data: summary, requestId: req.id });
    } catch (err: any) {
      req.log.error({ err }, "Error fetching activity");
      res.status(500).json({ success: false, error: "Failed to fetch activity", requestId: req.id });
    }
  },
);

/**
 * GET /api/automation/deals/:dealId/handoff
 *
 * Returns the latest handoff dispatch + dossier snapshot for a deal, used
 * by the deal-page handoff card. 404 when no handoff has been dispatched.
 */
router.get(
  "/automation/deals/:dealId/handoff",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const userId = auth.userId;
      const activeOrgId = auth.orgId;
      const { dealId } = req.params;

      if (!userId || !activeOrgId) {
        res.status(401).json({ success: false, error: "Unauthorized", requestId: req.id });
        return;
      }
      if (!dealId) {
        res.status(400).json({ success: false, error: "Missing dealId", requestId: req.id });
        return;
      }

      const supabase = getSupabaseAdmin();
      const resolvedOrgId = await resolveInternalOrgId(supabase, userId, activeOrgId);
      if (!resolvedOrgId) {
        res.status(400).json({ success: false, error: "No organization found", requestId: req.id });
        return;
      }

      const { data: deal } = await supabase
        .from("deals")
        .select("id, organization_id, user_id")
        .eq("id", dealId)
        .maybeSingle();

      if (!deal || deal.organization_id !== resolvedOrgId) {
        res.status(404).json({ success: false, error: "Deal not found", requestId: req.id });
        return;
      }

      const { data: dispatch } = await supabase
        .from("handoff_dispatches")
        .select(
          "id, source, dispatched_at, dossier_id, meeting_event_ref, meeting_start, meeting_end, assigned_rep_user_id, customer_intro_sent_at, rep_debrief_email_sent_at, rep_debrief_slack_sent_at",
        )
        .eq("deal_id", dealId)
        .order("dispatched_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!dispatch) {
        res.status(404).json({ success: false, error: "No handoff dispatched for this deal", requestId: req.id });
        return;
      }

      let dossier = null;
      if (dispatch.dossier_id) {
        const { data } = await supabase
          .from("handoff_dossiers")
          .select("id, fit_score, fit_band, signals, conversation_summary, objections, decision_criteria, talking_points, crm_links, created_at")
          .eq("id", dispatch.dossier_id)
          .maybeSingle();
        dossier = data;
      }

      let rep = null;
      if (dispatch.assigned_rep_user_id) {
        const { data: repProfile } = await supabase
          .from("profiles")
          .select("user_id, first_name, last_name, email")
          .eq("user_id", dispatch.assigned_rep_user_id)
          .maybeSingle();
        rep = repProfile;
      }

      res.json({
        success: true,
        data: { dispatch, dossier, rep },
        requestId: req.id,
      });
    } catch (err: any) {
      req.log.error({ err }, "Error fetching handoff");
      res.status(500).json({ success: false, error: "Failed to fetch handoff", requestId: req.id });
    }
  },
);

/**
 * GET /api/automation/guardrails/status
 *
 * Returns current guardrail configuration and today's usage.
 */
router.get(
  "/automation/guardrails/status",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const userId = auth.userId;
      const activeOrgId = auth.orgId;

      if (!userId || !activeOrgId) {
        res.status(401).json({ success: false, error: "Unauthorized", requestId: req.id });
        return;
      }

      const supabase = getSupabaseAdmin();
      const resolvedOrgId = await resolveInternalOrgId(supabase, userId, activeOrgId);
      if (!resolvedOrgId) {
        res.status(400).json({ success: false, error: "No organization found", requestId: req.id });
        return;
      }

      const guardrails = await getGuardrails(resolvedOrgId);
      const rateLimit = await checkEmailRateLimit(resolvedOrgId, userId);

      req.log.info(
        {
          resolvedOrgId,
          flagsKeys: Object.keys(guardrails),
          usageCount: rateLimit.count ?? 0,
          usageLimit: rateLimit.limit ?? null,
        },
        "Guardrails status",
      );

      res.json({
        success: true,
        data: {
          config: guardrails,
          usage: {
            emailsSentToday: rateLimit.count ?? 0,
            maxEmailsPerDay: rateLimit.limit ?? null,
          },
        },
        requestId: req.id,
      });
    } catch (err: any) {
      req.log.error({ err }, "Error fetching guardrails status");
      res.status(500).json({ success: false, error: "Failed to fetch guardrails status", requestId: req.id });
    }
  },
);

/**
 * GET /api/automation/reminders
 *
 * Returns active reminders for the authenticated user.
 */
router.get(
  "/automation/reminders",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const userId = auth.userId;
      const activeOrgId = auth.orgId;

      if (!userId) {
        res.status(401).json({ success: false, error: "Unauthorized", requestId: req.id });
        return;
      }

      const supabase = getSupabaseAdmin();

      // Resolve org for isolation (reminders are org-scoped)
      const resolvedOrgId = activeOrgId
        ? await resolveInternalOrgId(supabase, userId, activeOrgId)
        : null;

      let query = supabase
        .from("reminders")
        .select("id, reminder_text, trigger_at, status, source, source_ref, created_at")
        .eq("user_id", userId)
        .in("status", ["pending", "sent", "snoozed"])
        .order("trigger_at", { ascending: true })
        .limit(50);

      if (resolvedOrgId) {
        query = query.eq("organization_id", resolvedOrgId);
      }

      const { data, error } = await query;

      if (error) {
        // Table may not exist yet during rollout
        req.log.warn({ err: error }, "Reminders query error");
        res.json({ success: true, data: [], requestId: req.id });
        return;
      }

      res.json({ success: true, data: data || [], requestId: req.id });
    } catch (err: any) {
      req.log.error({ err }, "Error fetching reminders");
      res.status(500).json({ success: false, error: "Failed to fetch reminders", requestId: req.id });
    }
  },
);

/**
 * GET /api/automation/integrations
 *
 * Returns integration connection status for the authenticated user.
 */
router.get(
  "/automation/integrations",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const userId = auth.userId;
      const activeOrgId = auth.orgId;

      if (!userId) {
        res.status(401).json({ success: false, error: "Unauthorized", requestId: req.id });
        return;
      }

      const supabase = getSupabaseAdmin();
      // Two orgs because different integrations use different tier orders:
      // - resolvedOrgId (profile-first): matches where data lives, used by Slack
      //   (oauth_connections) — same pattern as useIntegrationStatuses hook.
      // - credentialOrgId (active-organization-first): matches the canonical
      //   /oauth/attio/status and /salesforce/oauth/status endpoints, used by
      //   Attio and Salesforce credential checks.
      const [resolvedOrgId, credentialOrgId] = await Promise.all([
        resolveInternalOrgId(supabase, userId, activeOrgId),
        resolveCredentialOrgId(supabase, userId, activeOrgId),
      ]);

      // Each check is wrapped in an async function with try/catch because
      // Supabase's PostgrestBuilder.then() returns a PromiseLike<T>, which
      // does not expose `.catch()` in its TypeScript contract. Using
      // async/await lets TypeScript see real Promise types and gives us
      // uniform error handling across all 5 integrations.
      const checkGoogle = async (): Promise<boolean> => {
        try {
          // The configuration UI connects the organization-level Gmail sender
          // through agent_email_credentials. Retain the legacy user-level
          // calendar check so either supported Google connection is visible.
          const calendarQuery = supabase
            .from("calendar_credentials")
            .select("id")
            .eq("user_id", userId)
            .eq("sync_status", "active")
            .maybeSingle();

          const emailQuery = credentialOrgId
            ? supabase
                .from("agent_email_credentials")
                .select("id")
                .eq("organization_id", credentialOrgId)
                .eq("is_active", true)
                .eq("verification_status", "verified")
                .maybeSingle()
            : Promise.resolve({ data: null, error: null });

          const [calendar, email] = await Promise.all([calendarQuery, emailQuery]);
          return !!calendar.data || !!email.data;
        } catch {
          return false;
        }
      };

      const checkGranola = async (): Promise<boolean> => {
        try {
          const { data } = await supabase
            .from("granola_credentials")
            .select("id")
            .eq("user_id", userId)
            .maybeSingle();
          return !!data;
        } catch {
          return false;
        }
      };

      // Slack: query oauth_connections (org-scoped), not slack_user_mappings.
      // Mirrors the working pattern in src/hooks/useIntegrationStatuses.ts:94-100.
      // slack_user_mappings can contain multiple active rows per user (one per
      // workspace), which makes .maybeSingle() throw; oauth_connections is
      // guaranteed single per (org, provider).
      const checkSlack = async (): Promise<boolean> => {
        if (!resolvedOrgId) return false;
        try {
          const { data } = await supabase
            .from("oauth_connections")
            .select("id")
            .eq("organization_id", resolvedOrgId)
            .eq("provider", "slack_bot")
            .eq("is_active", true)
            .maybeSingle();
          return !!data;
        } catch {
          return false;
        }
      };

      // Salesforce: match the canonical check in routes/salesforce.ts:536
      // — `connected: creds.sync_status === 'active'`. A row can exist but be
      // marked disconnected/error; only treat "active" as connected.
      // Uses credentialOrgId (active-organization-first) to match the canonical
      // /api/salesforce/oauth/status endpoint behavior.
      const checkSalesforce = async (): Promise<boolean> => {
        if (!credentialOrgId) return false;
        try {
          const { data } = await supabase
            .from("salesforce_credentials")
            .select("id")
            .eq("organization_id", credentialOrgId)
            .eq("sync_status", "active")
            .maybeSingle();
          return !!data;
        } catch {
          return false;
        }
      };

      // Attio: match the canonical check in routes/oauth.ts:2281
      // — `connected: !!data && data.status === "active"`.
      // Uses credentialOrgId (active-organization-first) to match the canonical
      // /api/oauth/attio/status endpoint behavior.
      const checkAttio = async (): Promise<boolean> => {
        if (!credentialOrgId) return false;
        try {
          const { data } = await supabase
            .from("attio_credentials")
            .select("id")
            .eq("organization_id", credentialOrgId)
            .eq("status", "active")
            .maybeSingle();
          return !!data;
        } catch {
          return false;
        }
      };

      const [googleResult, granolaResult, slackResult, salesforceResult, attioResult] = await Promise.all([
        checkGoogle(),
        checkGranola(),
        checkSlack(),
        checkSalesforce(),
        checkAttio(),
      ]);

      res.json({
        success: true,
        data: {
          google: googleResult,
          granola: granolaResult,
          slack: slackResult,
          salesforce: salesforceResult,
          attio: attioResult,
        },
        requestId: req.id,
      });
    } catch (err: any) {
      req.log.error({ err }, "Error fetching integrations");
      res.json({
        success: true,
        data: { google: false, granola: false, slack: false, salesforce: false, attio: false },
        requestId: req.id,
      });
    }
  },
);

/**
 * GET /api/automation/learnings
 *
 * Returns all active learnings for the authenticated user.
 */
router.get(
  "/automation/learnings",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const userId = auth.userId;
      const activeOrgId = auth.orgId;

      if (!userId) {
        res.status(401).json({ success: false, error: "Unauthorized", requestId: req.id });
        return;
      }

      const supabase = getSupabaseAdmin();
      const resolvedOrgId = await resolveInternalOrgId(supabase, userId, activeOrgId);

      // Fail-closed: if we can't resolve an org, return empty rather than
      // dropping the org_id filter (preserves the security intent of
      // commit bb8baba — never leak cross-org learnings).
      if (!resolvedOrgId) {
        req.log.warn(
          { userId, activeOrgId: activeOrgId ?? null },
          "Could not resolve org for learnings; returning empty",
        );
        res.json({ success: true, data: [], requestId: req.id });
        return;
      }

      const { data, error } = await supabase
        .from("user_learnings")
        .select("id, domain, learning, source_event_ids, created_at, updated_at")
        .eq("user_id", userId)
        .eq("organization_id", resolvedOrgId)
        .eq("status", "active")
        .order("updated_at", { ascending: false })
        .limit(50);

      if (error) {
        req.log.warn({ err: error }, "Learnings query error");
        res.json({ success: true, data: [], requestId: req.id });
        return;
      }

      req.log.info(
        { resolvedOrgId, userId, rowCount: data?.length ?? 0 },
        "Learnings fetched",
      );

      res.json({ success: true, data: data || [], requestId: req.id });
    } catch (err: any) {
      req.log.error({ err }, "Error fetching learnings");
      res.status(500).json({ success: false, error: "Failed to fetch learnings", requestId: req.id });
    }
  },
);

/**
 * GET /api/automation/feedback-events?ids=uuid1,uuid2,uuid3
 *
 * Returns feedback events by IDs for the detail view.
 * Only returns events belonging to the authenticated user.
 */
router.get(
  "/automation/feedback-events",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const userId = auth.userId;

      if (!userId) {
        res.status(401).json({ success: false, error: "Unauthorized", requestId: req.id });
        return;
      }

      const idsParam = req.query.ids as string;
      if (!idsParam) {
        res.status(400).json({ success: false, error: "Missing ids parameter", requestId: req.id });
        return;
      }

      const ids = idsParam.split(",").map((id) => id.trim()).filter(Boolean).slice(0, 30);
      if (ids.length === 0) {
        res.json({ success: true, data: [], requestId: req.id });
        return;
      }

      const supabase = getSupabaseAdmin();
      const { data, error } = await supabase
        .from("feedback_events")
        .select("id, domain, signal_type, agent_output, user_action, created_at")
        .eq("user_id", userId)
        .in("id", ids)
        .order("created_at", { ascending: false });

      if (error) {
        req.log.warn({ err: error }, "Feedback events query error");
        res.json({ success: true, data: [], requestId: req.id });
        return;
      }

      const formatted = (data || []).map((e: any) => ({
        id: e.id,
        signalType: e.signal_type,
        domain: e.domain,
        agentOutput: e.agent_output,
        userAction: e.user_action,
        createdAt: e.created_at,
      }));

      res.json({ success: true, data: formatted, requestId: req.id });
    } catch (err: any) {
      req.log.error({ err }, "Error fetching feedback events");
      res.status(500).json({ success: false, error: "Failed to fetch feedback events", requestId: req.id });
    }
  },
);

/**
 * PATCH /api/automation/feature-flags
 *
 * Toggles an org-level feature flag.
 * Requires org admin role.
 *
 * Body: { flagKey: string, childKey: string, value: boolean }
 */
router.patch(
  "/automation/feature-flags",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const { userId, orgId: activeOrgId, orgRole } = auth;

      if (!userId || !activeOrgId) {
        res.status(401).json({ success: false, error: "Unauthorized", requestId: req.id });
        return;
      }

      if (!isOrgAdmin(orgRole)) {
        res.status(403).json({ success: false, error: "Org admin role required", requestId: req.id });
        return;
      }

      const { flagKey, childKey, value } = req.body;
      if (typeof flagKey !== "string" || typeof childKey !== "string" || typeof value !== "boolean") {
        res.status(400).json({ success: false, error: "Invalid body — expected { flagKey: string, childKey: string, value: boolean }", requestId: req.id });
        return;
      }

      const supabase = getSupabaseAdmin();
      const resolvedOrgId = await resolveInternalOrgId(supabase, userId, activeOrgId);
      if (!resolvedOrgId) {
        res.status(400).json({ success: false, error: "No organization found", requestId: req.id });
        return;
      }

      // Build extra metadata fields for autonomous_mode toggles
      const extraFields: Record<string, string> = {};
      if (flagKey === "autonomous_mode") {
        extraFields[value ? "enabled_at" : "disabled_at"] = new Date().toISOString();
        extraFields["enabled_by"] = userId;
      }

      // Atomic merge via Postgres function — no read-modify-write race
      const { data: updated, error: rpcErr } = await supabase.rpc("merge_feature_flags", {
        org_id: resolvedOrgId,
        flag_key: flagKey,
        child_key: childKey,
        flag_value: value,
        extra_fields: extraFields,
      });

      if (rpcErr) {
        req.log.error({ err: rpcErr }, "[automation/feature-flags] RPC error");
        res.status(500).json({ success: false, error: "Failed to update flags", requestId: req.id });
        return;
      }

      req.log.info(
        { userId, resolvedOrgId, flagKey, childKey, value },
        "[automation/feature-flags] Flag updated",
      );
      res.json({ success: true, data: updated, requestId: req.id });
    } catch (err: any) {
      req.log.error({ err }, "[automation/feature-flags] Error");
      res.status(500).json({ success: false, error: "Failed to update feature flags", requestId: req.id });
    }
  },
);

/**
 * GET /api/automation/saved-memories
 *
 * Returns saved Salesforce business rules and user facts for the authenticated user.
 */
router.get(
  "/automation/saved-memories",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const userId = auth.userId;
      const activeOrgId = auth.orgId;

      if (!userId || !activeOrgId) {
        res.status(401).json({ success: false, error: "Unauthorized", requestId: req.id });
        return;
      }

      const supabase = getSupabaseAdmin();
      const resolvedOrgId = await resolveInternalOrgId(supabase, userId, activeOrgId);
      if (!resolvedOrgId) {
        res.status(400).json({ success: false, error: "No organization found", requestId: req.id });
        return;
      }

      const [rulesResult, factsResult] = await Promise.all([
        // Salesforce business rules
        supabase
          .from("user_memories")
          .select("id, content, created_at")
          .eq("user_id", userId)
          .eq("organization_id", resolvedOrgId)
          .eq("skill_namespace", "salesforce_rules")
          .order("created_at", { ascending: false })
          .limit(50),

        // User facts (filter by org via JSON path — user_preferences has no
        // organization_id column; save-user-fact.ts writes it into preference_value)
        supabase
          .from("user_preferences")
          .select("id, preference_key, preference_value, created_at, updated_at")
          .eq("user_id", userId)
          .like("preference_key", "user_fact_%")
          .filter("preference_value->>organizationId", "eq", resolvedOrgId)
          .order("updated_at", { ascending: false })
          .limit(50),
      ]);

      if (rulesResult.error) {
        req.log.warn({ err: rulesResult.error }, "Saved rules query error");
      }
      if (factsResult.error) {
        req.log.warn({ err: factsResult.error }, "User facts query error");
      }

      // Strip the "role: " prefix the memory provider adds when persisting messages
      // (SupabaseMemoryProvider.save stores `${role}: ${content}`).
      const rules = (rulesResult.data || []).map((r: any) => ({
        id: r.id,
        content: String(r.content || "").replace(/^\w+:\s*/, ""),
        type: "salesforce_rule" as const,
        createdAt: r.created_at,
      }));

      const facts = (factsResult.data || []).map((f: any) => ({
        id: f.id,
        content: f.preference_value?.value || "",
        category: f.preference_value?.category || "context",
        type: "user_fact" as const,
        createdAt: f.updated_at || f.created_at,
      }));

      res.json({ success: true, data: { rules, facts }, requestId: req.id });
    } catch (err: any) {
      req.log.error({ err }, "Error fetching saved memories");
      res.status(500).json({ success: false, error: "Failed to fetch saved memories", requestId: req.id });
    }
  },
);

/**
 * GET /api/automation/activity-stats
 *
 * Returns aggregate counts over the last 30 days for the Autonomous stats row.
 * Requires org admin role (Autonomous page is admin-only).
 */
router.get(
  "/automation/activity-stats",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const userId = auth.userId;
      const activeOrgId = auth.orgId;
      const orgRole = auth.orgRole;

      if (!userId || !activeOrgId) {
        res.status(401).json({ success: false, error: "Unauthorized", requestId: req.id });
        return;
      }

      if (!isOrgAdmin(orgRole)) {
        res.status(403).json({ success: false, error: "Org admin role required", requestId: req.id });
        return;
      }

      // admin: cross-org aggregate counts require service role
      const supabase = getSupabaseAdmin();
      const resolvedOrgId = await resolveInternalOrgId(supabase, userId, activeOrgId);
      if (!resolvedOrgId) {
        res.status(400).json({ success: false, error: "No organization found", requestId: req.id });
        return;
      }

      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const [chatsResult, dealsOwnedResult, emailsResult, followupsResult, meetingsResult] = await Promise.all([
        // Leads qualified: prospect chat sessions where someone actually sent messages
        supabase
          .from("prospect_sessions")
          .select("id, prospect_messages!inner(id)", { count: "exact", head: true })
          .eq("organization_id", resolvedOrgId)
          .eq("prospect_messages.role", "user")
          .gte("started_at", thirtyDaysAgo),

        // Deals owned: prospects Sales Agent has created in CRM
        supabase
          .from("deals")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", resolvedOrgId)
          .eq("source", "inbound_email")
          .gte("created_at", thirtyDaysAgo),

        // Emails sent autonomously (all auto-sent)
        supabase
          .from("email_auto_response_drafts")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", resolvedOrgId)
          .in("status", ["auto_sent", "sent"])
          .gte("sent_at", thirtyDaysAgo),

        // Deals nudged: follow-up emails sent (subset of emails sent)
        supabase
          .from("email_scheduled_followups")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", resolvedOrgId)
          .eq("status", "sent")
          .gte("sent_at", thirtyDaysAgo),

        // Meetings booked
        supabase
          .from("workflow_runs")
          .select("id", { count: "exact", head: true })
          .eq("org_id", resolvedOrgId)
          .eq("status", "succeeded")
          .eq("workflow_kind", "meeting_followup")
          .gte("ended_at", thirtyDaysAgo),
      ]);

      const leadsQualified = chatsResult.count ?? 0;

      res.json({
        success: true,
        data: {
          leadsQualified,
          dealsOwned: dealsOwnedResult.count ?? 0,
          emailsSent: emailsResult.count ?? 0,
          dealsNudged: followupsResult.count ?? 0,
          meetingsBooked: meetingsResult.count ?? 0,
        },
        requestId: req.id,
      });
    } catch (err: any) {
      req.log.error({ err }, "Error fetching activity stats");
      res.status(500).json({ success: false, error: "Failed to fetch activity stats", requestId: req.id });
    }
  },
);

/**
 * GET /api/automation/pipeline
 *
 * Returns active qualified leads — email thread conversations that are
 * not closed (won/lost) or in nurture. These are deals the agent is
 * actively working.
 * Requires org admin role (Autonomous page is admin-only).
 */
router.get(
  "/automation/pipeline",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const userId = auth.userId;
      const activeOrgId = auth.orgId;
      const orgRole = auth.orgRole;

      if (!userId || !activeOrgId) {
        res.status(401).json({ success: false, error: "Unauthorized", requestId: req.id });
        return;
      }

      if (!isOrgAdmin(orgRole)) {
        res.status(403).json({ success: false, error: "Org admin role required", requestId: req.id });
        return;
      }

      // admin: org-wide pipeline listing requires service role
      const supabase = getSupabaseAdmin();
      const resolvedOrgId = await resolveInternalOrgId(supabase, userId, activeOrgId);
      if (!resolvedOrgId) {
        res.status(400).json({ success: false, error: "No organization found", requestId: req.id });
        return;
      }

      // Only active pipeline: exclude won, lost, nurture
      const { data, error } = await supabase
        .from("email_thread_conversations")
        .select(
          "id, from_name, from_email, from_domain, subject, conversation_stage, followup_status, next_followup_at, last_message_at, last_confidence_score, message_count",
        )
        .eq("organization_id", resolvedOrgId)
        .not("conversation_stage", "in", '("won","lost","nurture")')
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(100);

      if (error) {
        req.log.warn({ err: error }, "Pipeline query error");
        res.json({ success: true, data: [], requestId: req.id });
        return;
      }

      res.json({ success: true, data: data || [], requestId: req.id });
    } catch (err: any) {
      req.log.error({ err }, "Error fetching pipeline");
      res.status(500).json({ success: false, error: "Failed to fetch pipeline", requestId: req.id });
    }
  },
);

/**
 * GET /api/automation/slack-channels
 *
 * Returns public Slack channels the bot is in for the org's workspace.
 * Requires org admin role (Autonomous page is admin-only).
 * Note: only returns up to 200 channels (Slack API pagination not implemented).
 */
router.get(
  "/automation/slack-channels",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const userId = auth.userId;
      const activeOrgId = auth.orgId;
      const orgRole = auth.orgRole;

      if (!userId || !activeOrgId) {
        res.status(401).json({ success: false, error: "Unauthorized", requestId: req.id });
        return;
      }

      if (!isOrgAdmin(orgRole)) {
        res.status(403).json({ success: false, error: "Org admin role required", requestId: req.id });
        return;
      }

      // admin: reading workspace tokens requires service role
      const supabase = getSupabaseAdmin();
      const resolvedOrgId = await resolveInternalOrgId(supabase, userId, activeOrgId);
      if (!resolvedOrgId) {
        res.status(400).json({ success: false, error: "No organization found", requestId: req.id });
        return;
      }

      // Strictly org-scoped — no fallbacks to prevent cross-tenant token leaks
      const { data: workspace } = await supabase
        .from("slack_workspaces")
        .select("bot_token")
        .eq("organization_id", resolvedOrgId)
        .eq("is_active", true)
        .maybeSingle();

      const rawToken = workspace?.bot_token ?? null;

      if (!rawToken) {
        req.log.info({ resolvedOrgId }, "No Slack bot token available for slack-channels");
        res.json({ success: true, data: [], requestId: req.id });
        return;
      }

      // Dynamic import: slack-helpers pulls in crypto deps not needed by other automation routes
      const { decryptBotToken } = await import("../workflows/utils/slack-helpers");
      let botToken: string;
      try {
        botToken = await decryptBotToken(rawToken);
      } catch (err) {
        req.log.error({ err }, "Failed to decrypt bot token for slack-channels");
        res.json({ success: true, data: [], requestId: req.id });
        return;
      }

      // Fetch all public channels (bot membership checked below)
      const params = new URLSearchParams({
        types: "public_channel",
        exclude_archived: "true",
        limit: "200",
      });
      const slackResp = await fetch(`https://slack.com/api/conversations.list?${params}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${botToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      const slackData = (await slackResp.json()) as {
        ok: boolean;
        error?: string;
        channels?: Array<{ id: string; name: string; is_member: boolean }>;
      };

      if (!slackData.ok || !slackData.channels) {
        req.log.warn({ slackError: slackData.error }, "Slack conversations.list failed");
        res.json({ success: true, data: [], requestId: req.id });
        return;
      }

      // Return all channels — both joined and not — so admins can pick any public channel
      const channels = slackData.channels
        .map((c) => ({ id: c.id, name: c.name }))
        .sort((a, b) => a.name.localeCompare(b.name));

      res.json({ success: true, data: channels, requestId: req.id });
    } catch (err: any) {
      req.log.error({ err }, "Error fetching Slack channels");
      res.status(500).json({ success: false, error: "Failed to fetch Slack channels", requestId: req.id });
    }
  },
);

/**
 * GET /api/automation/prospect-notification-channel
 *
 * Returns the currently saved Slack channel ID for prospect notifications.
 * Requires org admin role.
 */
router.get(
  "/automation/prospect-notification-channel",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const userId = auth.userId;
      const activeOrgId = auth.orgId;
      const orgRole = auth.orgRole;

      if (!userId || !activeOrgId) {
        res.status(401).json({ success: false, error: "Unauthorized", requestId: req.id });
        return;
      }

      if (!isOrgAdmin(orgRole)) {
        res.status(403).json({ success: false, error: "Org admin role required", requestId: req.id });
        return;
      }

      // admin: reading org settings requires service role
      const supabase = getSupabaseAdmin();
      const resolvedOrgId = await resolveInternalOrgId(supabase, userId, activeOrgId);
      if (!resolvedOrgId) {
        res.status(400).json({ success: false, error: "No organization found", requestId: req.id });
        return;
      }

      const { data: org } = await supabase
        .from("organizations")
        .select("settings")
        .eq("id", resolvedOrgId)
        .single();

      const channelId = (org?.settings as Record<string, unknown>)?.prospect_dossier_slack_channel_id ?? null;
      res.json({ success: true, data: { channelId }, requestId: req.id });
    } catch (err: any) {
      req.log.error({ err }, "Error fetching prospect notification channel");
      res.status(500).json({ success: false, error: "Failed to fetch channel", requestId: req.id });
    }
  },
);

/**
 * PUT /api/automation/prospect-notification-channel
 *
 * Saves the selected Slack channel for prospect notifications.
 * Body: { channelId: string }
 */
router.put(
  "/automation/prospect-notification-channel",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const userId = auth.userId;
      const activeOrgId = auth.orgId;
      const orgRole = auth.orgRole;

      if (!userId || !activeOrgId) {
        res.status(401).json({ success: false, error: "Unauthorized", requestId: req.id });
        return;
      }

      if (!isOrgAdmin(orgRole)) {
        res.status(403).json({ success: false, error: "Org admin role required", requestId: req.id });
        return;
      }

      const { channelId } = req.body;
      if (typeof channelId !== "string" || !channelId) {
        res.status(400).json({ success: false, error: "Missing channelId", requestId: req.id });
        return;
      }

      // Validate Slack channel ID format (C + alphanumeric, e.g. C01ABCDEF23)
      if (!/^C[A-Z0-9]{8,}$/i.test(channelId)) {
        res.status(400).json({ success: false, error: "Invalid channelId format", requestId: req.id });
        return;
      }

      // admin: updating org settings requires service role
      const supabase = getSupabaseAdmin();
      const resolvedOrgId = await resolveInternalOrgId(supabase, userId, activeOrgId);
      if (!resolvedOrgId) {
        res.status(400).json({ success: false, error: "No organization found", requestId: req.id });
        return;
      }

      // Atomic JSONB merge — avoids read-modify-write race condition
      const { error: updateErr } = await supabase.rpc("merge_org_settings", {
        org_id: resolvedOrgId,
        new_settings: { prospect_dossier_slack_channel_id: channelId },
      });

      if (updateErr) {
        req.log.error({ err: updateErr }, "Failed to save prospect notification channel");
        res.status(500).json({ success: false, error: "Failed to save channel", requestId: req.id });
        return;
      }

      req.log.info({ resolvedOrgId, channelId }, "Prospect notification channel updated");
      res.json({ success: true, requestId: req.id });
    } catch (err: any) {
      req.log.error({ err }, "Error saving prospect notification channel");
      res.status(500).json({ success: false, error: "Failed to save channel", requestId: req.id });
    }
  },
);

// ---------------------------------------------------------------------------
// Autonomous Agent User Management
// ---------------------------------------------------------------------------

/**
 * GET /api/automation/automation-agent
 *
 * Returns the current Autonomous agent user info for the org.
 * Requires org admin role.
 */
router.get(
  "/automation/automation-agent",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const { userId, orgId: activeOrgId, orgRole } = auth;

      if (!userId || !activeOrgId) {
        res.status(401).json({ success: false, error: "Unauthorized", requestId: req.id });
        return;
      }

      if (!isOrgAdmin(orgRole)) {
        res.status(403).json({ success: false, error: "Org admin role required", requestId: req.id });
        return;
      }

      const supabase = getSupabaseAdmin();
      const resolvedOrgId = await resolveInternalOrgId(supabase, userId, activeOrgId);
      if (!resolvedOrgId) {
        res.status(400).json({ success: false, error: "No organization found", requestId: req.id });
        return;
      }

      const { data: org } = await supabase
        .from("organizations")
        .select("autonomous_agent_user_id")
        .eq("id", resolvedOrgId)
        .single();

      if (!org?.autonomous_agent_user_id) {
        res.json({ success: true, data: { autonomousAgentUserId: null }, requestId: req.id });
        return;
      }

      // Fetch Sales Agent display info and OAuth status
      const [agentCredsResult, calCredsResult] = await Promise.all([
        supabase
          .from("agent_email_credentials")
          .select("email_address, display_name")
          .eq("organization_id", resolvedOrgId)
          .maybeSingle(),
        supabase
          .from("calendar_credentials")
          .select("calendar_email, sync_status")
          .eq("user_id", org.autonomous_agent_user_id)
          .maybeSingle(),
      ]);

      res.json({
        success: true,
        data: {
          autonomousAgentUserId: org.autonomous_agent_user_id,
          agentEmail: agentCredsResult.data?.email_address || calCredsResult.data?.calendar_email || null,
          agentDisplayName: agentCredsResult.data?.display_name || null,
          oauthStatus: calCredsResult.data?.sync_status || null,
        },
        requestId: req.id,
      });
    } catch (err: any) {
      req.log.error({ err }, "Error fetching Autonomous agent");
      res.status(500).json({ success: false, error: "Failed to fetch Autonomous agent", requestId: req.id });
    }
  },
);

/**
 * PUT /api/automation/automation-agent
 *
 * Designate a user as the org's Autonomous agent.
 * Body: { userId: string, displayName?: string }
 * Requires org admin role.
 */
router.put(
  "/automation/automation-agent",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const { userId: authUserId, orgId: activeOrgId, orgRole } = auth;

      if (!authUserId || !activeOrgId) {
        res.status(401).json({ success: false, error: "Unauthorized", requestId: req.id });
        return;
      }

      if (!isOrgAdmin(orgRole)) {
        res.status(403).json({ success: false, error: "Org admin role required", requestId: req.id });
        return;
      }

      const { userId: targetUserId, displayName } = req.body;
      if (typeof targetUserId !== "string" || !targetUserId) {
        res.status(400).json({ success: false, error: "Missing userId", requestId: req.id });
        return;
      }

      const supabase = getSupabaseAdmin();
      const resolvedOrgId = await resolveInternalOrgId(supabase, authUserId, activeOrgId);
      if (!resolvedOrgId) {
        res.status(400).json({ success: false, error: "No organization found", requestId: req.id });
        return;
      }

      // Validate: target user is an org member
      const { data: orgMembership } = await supabase
        .from("organization_users")
        .select("id")
        .eq("user_id", targetUserId)
        .eq("organization_id", resolvedOrgId)
        .maybeSingle();

      if (!orgMembership) {
        res.status(400).json({ success: false, error: "User is not a member of this organization", requestId: req.id });
        return;
      }

      // Validate: target user has active calendar_credentials (Gmail OAuth'd)
      const { data: calCreds } = await supabase
        .from("calendar_credentials")
        .select("calendar_email, sync_status")
        .eq("user_id", targetUserId)
        .maybeSingle();

      if (!calCreds || calCreds.sync_status !== "active") {
        res.status(400).json({
          success: false,
          error: "User must have active Gmail OAuth before being designated as Autonomous agent",
          requestId: req.id,
        });
        return;
      }

      // Set autonomous_agent_user_id on the org
      const { error: updateErr } = await supabase
        .from("organizations")
        .update({ autonomous_agent_user_id: targetUserId })
        .eq("id", resolvedOrgId);

      if (updateErr) {
        req.log.error({ err: updateErr }, "Failed to set Autonomous agent user");
        res.status(500).json({ success: false, error: "Failed to set Autonomous agent", requestId: req.id });
        return;
      }

      // Upsert agent_email_credentials with display name
      const agentDisplayName = displayName || "Sales Agent";
      const { error: upsertErr } = await supabase
        .from("agent_email_credentials")
        .upsert(
          {
            organization_id: resolvedOrgId,
            email_address: calCreds.calendar_email,
            display_name: agentDisplayName,
            is_active: true,
            // Sentinel token — Autonomous path in send-email.ts uses calendar_credentials instead
            refresh_token: "__autonomous_agent__",
          },
          { onConflict: "organization_id" },
        );

      if (upsertErr) {
        req.log.error({ err: upsertErr }, "Failed to upsert agent_email_credentials");
        // Non-fatal — the org column is set, Sales Agent creds are supplementary
      }

      // Ensure Gmail push notifications are registered for the Autonomous agent's inbox.
      // This is fire-and-forget — if it fails, Vercel Workflow retries automatically.
      try {
        await workflow.send({
          name: "email/ensure-gmail-watch",
          data: {
            userId: targetUserId,
            organizationId: resolvedOrgId,
          },
        });
        req.log.info({ userId: targetUserId }, "Dispatched Gmail watch registration for Autonomous agent");
      } catch (watchErr: any) {
        req.log.error({ err: watchErr }, "Failed to dispatch Gmail watch event (non-fatal)");
        // Non-fatal — polling fallback runs every 5 minutes
      }

      req.log.info(
        { resolvedOrgId, autonomousAgentUserId: targetUserId, agentEmail: calCreds.calendar_email },
        "Autonomous agent user designated",
      );

      res.json({
        success: true,
        data: {
          autonomousAgentUserId: targetUserId,
          agentEmail: calCreds.calendar_email,
          agentDisplayName,
          oauthStatus: calCreds.sync_status,
        },
        requestId: req.id,
      });
    } catch (err: any) {
      req.log.error({ err }, "Error setting Autonomous agent");
      res.status(500).json({ success: false, error: "Failed to set Autonomous agent", requestId: req.id });
    }
  },
);

/**
 * DELETE /api/automation/automation-agent
 *
 * Remove the Autonomous agent designation from the org.
 * Requires org admin role.
 */
router.delete(
  "/automation/automation-agent",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const { userId, orgId: activeOrgId, orgRole } = auth;

      if (!userId || !activeOrgId) {
        res.status(401).json({ success: false, error: "Unauthorized", requestId: req.id });
        return;
      }

      if (!isOrgAdmin(orgRole)) {
        res.status(403).json({ success: false, error: "Org admin role required", requestId: req.id });
        return;
      }

      const supabase = getSupabaseAdmin();
      const resolvedOrgId = await resolveInternalOrgId(supabase, userId, activeOrgId);
      if (!resolvedOrgId) {
        res.status(400).json({ success: false, error: "No organization found", requestId: req.id });
        return;
      }

      const { error: updateErr } = await supabase
        .from("organizations")
        .update({ autonomous_agent_user_id: null })
        .eq("id", resolvedOrgId);

      if (updateErr) {
        req.log.error({ err: updateErr }, "Failed to remove Autonomous agent");
        res.status(500).json({ success: false, error: "Failed to remove Autonomous agent", requestId: req.id });
        return;
      }

      // Deactivate the sentinel agent_email_credentials row so the legacy
      // Sales Agent path doesn't pick up the "__autonomous_agent__" token
      const { error: deactivateErr } = await supabase
        .from("agent_email_credentials")
        .update({ is_active: false })
        .eq("organization_id", resolvedOrgId)
        .eq("refresh_token", "__autonomous_agent__");

      if (deactivateErr) {
        req.log.error({ err: deactivateErr }, "Failed to deactivate Autonomous sentinel credentials (non-fatal)");
      }

      req.log.info({ resolvedOrgId }, "Autonomous agent user removed");
      res.json({ success: true, requestId: req.id });
    } catch (err: any) {
      req.log.error({ err }, "Error removing Autonomous agent");
      res.status(500).json({ success: false, error: "Failed to remove Autonomous agent", requestId: req.id });
    }
  },
);

/**
 * GET /api/automation/efficiency?range=24h|7d|30d
 *
 * Returns real telemetry for the org's agent runs over the selected
 * range. NO invented metrics — only fields actually persisted on
 * workflow_runs. Useful for buyer demos and skeptical reps who want
 * defensible numbers (actions, cost, runtime, escalation rate).
 */
router.get(
  "/automation/efficiency",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const userId = auth.userId;
      const activeOrgId = auth.orgId;
      const range = (req.query.range as string) || "24h";

      if (!userId || !activeOrgId) {
        res.status(401).json({ success: false, error: "Unauthorized", requestId: req.id });
        return;
      }

      const hoursByRange: Record<string, number> = { "24h": 24, "7d": 24 * 7, "30d": 24 * 30 };
      const hours = hoursByRange[range];
      if (!hours) {
        res
          .status(400)
          .json({ success: false, error: "Invalid range (24h|7d|30d)", requestId: req.id });
        return;
      }

      const supabase = getSupabaseAdmin();
      const resolvedOrgId = await resolveInternalOrgId(supabase, userId, activeOrgId);
      if (!resolvedOrgId) {
        res.status(400).json({ success: false, error: "No organization found", requestId: req.id });
        return;
      }

      const sinceISO = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

      const { data, error } = await supabase
        .from("workflow_runs")
        .select("status, runtime_ms, cost_usd, escalations_count, llm_calls_count, tokens_in, tokens_out")
        .eq("org_id", resolvedOrgId)
        .eq("user_id", userId)
        .gte("started_at", sinceISO)
        .limit(5000);

      if (error) {
        req.log.warn({ err: error }, "Efficiency query error");
        res.json({
          success: true,
          data: {
            range,
            totalActions: 0,
            totalCostUsd: 0,
            avgRuntimeMs: 0,
            escalationRate: 0,
            llmCalls: 0,
            tokensIn: 0,
            tokensOut: 0,
          },
          requestId: req.id,
        });
        return;
      }

      const rows = data ?? [];
      const succeeded = rows.filter((r: any) => r.status === "succeeded");
      const totalActions = succeeded.length;
      const totalCostUsd = rows.reduce(
        (sum: number, r: any) => sum + (typeof r.cost_usd === "number" ? r.cost_usd : 0),
        0,
      );
      const totalRuntimeMs = rows.reduce(
        (sum: number, r: any) => sum + (typeof r.runtime_ms === "number" ? r.runtime_ms : 0),
        0,
      );
      const avgRuntimeMs = rows.length > 0 ? totalRuntimeMs / rows.length : 0;
      const totalEscalations = rows.reduce(
        (sum: number, r: any) => sum + (typeof r.escalations_count === "number" ? r.escalations_count : 0),
        0,
      );
      const escalationRate = totalActions > 0 ? totalEscalations / totalActions : 0;
      const llmCalls = rows.reduce(
        (sum: number, r: any) => sum + (typeof r.llm_calls_count === "number" ? r.llm_calls_count : 0),
        0,
      );
      const tokensIn = rows.reduce(
        (sum: number, r: any) => sum + (typeof r.tokens_in === "number" ? r.tokens_in : 0),
        0,
      );
      const tokensOut = rows.reduce(
        (sum: number, r: any) => sum + (typeof r.tokens_out === "number" ? r.tokens_out : 0),
        0,
      );

      res.json({
        success: true,
        data: {
          range,
          totalActions,
          totalCostUsd,
          avgRuntimeMs,
          escalationRate,
          llmCalls,
          tokensIn,
          tokensOut,
        },
        requestId: req.id,
      });
    } catch (err: any) {
      req.log.error({ err }, "Error fetching efficiency");
      res.status(500).json({ success: false, error: "Failed to fetch efficiency", requestId: req.id });
    }
  },
);

/**
 * GET /api/automation/activity/email/:id?source=draft|incoming
 *
 * Returns drill-in detail for a single email activity row.
 * source=draft  → email_auto_response_drafts row (sent or pending_approval)
 * source=incoming → incoming_emails row (processed/skipped/failed)
 *
 * Surfaces the agent's reasoning, KB context, edits, and outcome
 * (reply counts via email_thread_conversations).
 */
router.get(
  "/automation/activity/email/:id",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const userId = auth.userId;
      const activeOrgId = auth.orgId;
      const { id } = req.params;
      const source = (req.query.source as string) || "draft";

      if (!userId || !activeOrgId) {
        res.status(401).json({ success: false, error: "Unauthorized", requestId: req.id });
        return;
      }
      if (!id) {
        res.status(400).json({ success: false, error: "Missing id", requestId: req.id });
        return;
      }
      if (source !== "draft" && source !== "incoming") {
        res
          .status(400)
          .json({ success: false, error: "Invalid source (draft|incoming)", requestId: req.id });
        return;
      }

      const supabase = getSupabaseAdmin();
      const resolvedOrgId = await resolveInternalOrgId(supabase, userId, activeOrgId);
      if (!resolvedOrgId) {
        res.status(400).json({ success: false, error: "No organization found", requestId: req.id });
        return;
      }

      if (source === "draft") {
        const { data: draft, error } = await supabase
          .from("email_auto_response_drafts")
          .select(
            "id, subject, to_email, status, sent_at, created_at, confidence_score, agent_reasoning, auto_send_reasoning, context_kb_results, user_context_applied, edit_count, edit_history, gmail_thread_id, incoming_email_id",
          )
          .eq("id", id)
          .eq("user_id", userId)
          .eq("organization_id", resolvedOrgId)
          .maybeSingle();

        if (error) {
          req.log.error({ err: error }, "Failed to fetch draft drill-in");
          res
            .status(500)
            .json({ success: false, error: "Failed to fetch detail", requestId: req.id });
          return;
        }
        if (!draft) {
          res.status(404).json({ success: false, error: "Not found", requestId: req.id });
          return;
        }

        // Optional: pull classification reasoning from the originating inbound email
        let classificationReasoning: string | null = null;
        let classificationConfidence: number | null = null;
        if (draft.incoming_email_id) {
          const { data: incoming } = await supabase
            .from("incoming_emails")
            .select("classification_reasoning, classification_confidence")
            .eq("id", draft.incoming_email_id)
            .maybeSingle();
          classificationReasoning = incoming?.classification_reasoning ?? null;
          classificationConfidence = incoming?.classification_confidence ?? null;
        }

        // Outcome from thread conversation (if linked)
        let theirReplyCount = 0;
        let lastTheirReplyAt: string | null = null;
        if (draft.gmail_thread_id) {
          const { data: thread } = await supabase
            .from("email_thread_conversations")
            .select("their_reply_count, last_their_reply_at")
            .eq("gmail_thread_id", draft.gmail_thread_id)
            .eq("user_id", userId)
            .eq("organization_id", resolvedOrgId)
            .maybeSingle();
          theirReplyCount = thread?.their_reply_count ?? 0;
          lastTheirReplyAt = thread?.last_their_reply_at ?? null;
        }

        res.json({
          success: true,
          data: {
            source: "draft",
            id: draft.id,
            subject: draft.subject ?? "(no subject)",
            partyLabel: "To",
            partyEmail: draft.to_email ?? "",
            status: draft.status ?? "unknown",
            timestamp: draft.sent_at ?? draft.created_at,
            confidenceScore: draft.confidence_score ?? null,
            agentReasoning: draft.agent_reasoning ?? null,
            autoSendReasoning: draft.auto_send_reasoning ?? null,
            classificationReasoning,
            classificationConfidence,
            contextKbResults: draft.context_kb_results ?? null,
            userContextApplied: draft.user_context_applied ?? null,
            editCount: draft.edit_count ?? 0,
            editHistory: draft.edit_history ?? null,
            threadId: draft.gmail_thread_id ?? null,
            theirReplyCount,
            lastTheirReplyAt,
          },
          requestId: req.id,
        });
        return;
      }

      // source === "incoming"
      const { data: incoming, error: incomingErr } = await supabase
        .from("incoming_emails")
        .select(
          "id, from_email, subject, status, qualification_category, classification, classification_reasoning, classification_confidence, error_message, created_at",
        )
        .eq("id", id)
        .eq("user_id", userId)
        .eq("organization_id", resolvedOrgId)
        .maybeSingle();

      if (incomingErr) {
        req.log.error({ err: incomingErr }, "Failed to fetch incoming drill-in");
        res
          .status(500)
          .json({ success: false, error: "Failed to fetch detail", requestId: req.id });
        return;
      }
      if (!incoming) {
        res.status(404).json({ success: false, error: "Not found", requestId: req.id });
        return;
      }

      res.json({
        success: true,
        data: {
          source: "incoming",
          id: incoming.id,
          subject: incoming.subject ?? "(no subject)",
          partyLabel: "From",
          partyEmail: incoming.from_email ?? "",
          status: incoming.status ?? "unknown",
          timestamp: incoming.created_at,
          confidenceScore: null,
          agentReasoning: null,
          autoSendReasoning: null,
          classificationReasoning: incoming.classification_reasoning ?? null,
          classificationConfidence: incoming.classification_confidence ?? null,
          classification: incoming.classification ?? null,
          qualificationCategory: incoming.qualification_category ?? null,
          errorMessage: incoming.error_message ?? null,
          contextKbResults: null,
          userContextApplied: null,
          editCount: 0,
          editHistory: null,
          threadId: null,
          theirReplyCount: 0,
          lastTheirReplyAt: null,
        },
        requestId: req.id,
      });
    } catch (err: any) {
      req.log.error({ err }, "Error fetching activity drill-in");
      res
        .status(500)
        .json({ success: false, error: "Failed to fetch detail", requestId: req.id });
    }
  },
);

export default router;
