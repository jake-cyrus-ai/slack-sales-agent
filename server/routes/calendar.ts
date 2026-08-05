/**
 * Calendar API Routes
 *
 * Handles calendar-related API endpoints. Dispatches to Vercel Workflow for async processing.
 */

import { Router, Response } from "express";
import { getAuth, requireAuth } from "@clerk/express";
import { workflow } from "../workflows/client";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import crypto from "crypto";
import type { Request } from "../types";
import type { Logger } from "pino";

const router = Router();

const getSupabaseAdmin = (): SupabaseClient => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
};

const resolveOrgId = async (
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
    log.error({ err: error }, "Error resolving org by clerk_id");
    return null;
  }

  return org?.id ?? null;
};

interface SyncRequestBody {
  syncType?: "initial" | "on_demand" | "scheduled";
}

/**
 * POST /api/calendar/sync
 *
 * Triggers calendar sync for the authenticated user.
 * Sends a "calendar/sync" Vercel Workflow event and returns 202 Accepted.
 *
 * Replaces: supabase.functions.invoke('sync-calendar-events', ...)
 */
router.post(
  "/calendar/sync",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const { userId: clerkUserId, orgId: clerkOrgId } = auth;

      if (!clerkUserId) {
        return res.status(401).json({
          error: "Unauthorized - No user ID in session",
          requestId: req.id,
        });
      }

      const { syncType } = req.body as SyncRequestBody;

      req.log.info(
        { userId: clerkUserId, syncType: syncType || "on_demand" },
        "Calendar sync requested"
      );

      const supabase = getSupabaseAdmin();

      // Verify user has calendar credentials before triggering sync
      const { data: credentials, error: credError } = await supabase
        .from("calendar_credentials")
        .select("id, sync_status")
        .eq("user_id", clerkUserId)
        .maybeSingle();

      if (credError) {
        req.log.error(
          { err: credError },
          "Error checking calendar credentials"
        );
        return res.status(500).json({
          error: "Failed to verify calendar connection",
          requestId: req.id,
        });
      }

      if (!credentials) {
        return res.status(404).json({
          error: "No calendar connected. Please connect your Google Calendar first.",
          requestId: req.id,
        });
      }

      if (credentials.sync_status === "expired") {
        return res.status(401).json({
          error: "Calendar connection expired. Please reconnect your Google Calendar.",
          requestId: req.id,
        });
      }

      // Resolve organization ID if user is in an org context
      let organizationId: string | undefined;
      if (clerkOrgId) {
        const resolvedOrgId = await resolveOrgId(supabase, clerkOrgId, req.log);
        if (resolvedOrgId) {
          organizationId = resolvedOrgId;
        }
      }

      // Send Vercel Workflow event for async calendar sync
      await workflow.send({
        name: "calendar/sync",
        data: {
          userId: clerkUserId,
          organizationId,
        },
      });

      req.log.info({ userId: clerkUserId }, "Dispatched calendar/sync event");

      return res.status(202).json({
        success: true,
        message: "Calendar sync initiated",
        requestId: req.id,
      });
    } catch (error: any) {
      req.log.error({ err: error }, "Error triggering calendar sync");
      return res.status(500).json({
        error: error.message || "Internal server error",
        requestId: req.id,
      });
    }
  }
);

// ===========================================================================
// Calendar Event Creation Routes
// ===========================================================================

interface CreateEventRequestBody {
  summary: string;
  startDateTime: string;
  endDateTime?: string;
  description?: string;
  attendees?: string[];
  location?: string;
  addVideoConference?: boolean;
}

/**
 * POST /api/calendar/create
 *
 * Creates a new calendar event for the authenticated user.
 * Sends a "calendar/create-event" Vercel Workflow event and returns 202 Accepted.
 */
router.post(
  "/calendar/create",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const { userId: clerkUserId, orgId: clerkOrgId } = auth;

      if (!clerkUserId) {
        return res.status(401).json({
          error: "Unauthorized - No user ID in session",
          requestId: req.id,
        });
      }

      const {
        summary,
        startDateTime,
        endDateTime,
        description,
        attendees,
        location,
        addVideoConference,
      } = req.body as CreateEventRequestBody;

      // Validate required fields
      if (!summary || !startDateTime) {
        return res.status(400).json({
          error: "summary and startDateTime are required",
          requestId: req.id,
        });
      }

      // Validate date formats
      if (isNaN(new Date(startDateTime).getTime())) {
        return res.status(400).json({
          error: "startDateTime must be a valid ISO 8601 date string",
          requestId: req.id,
        });
      }
      if (endDateTime && isNaN(new Date(endDateTime).getTime())) {
        return res.status(400).json({
          error: "endDateTime must be a valid ISO 8601 date string",
          requestId: req.id,
        });
      }

      req.log.info(
        { userId: clerkUserId, summary },
        "Calendar create requested"
      );

      const supabase = getSupabaseAdmin();

      // Verify user has calendar credentials
      const { data: credentials, error: credError } = await supabase
        .from("calendar_credentials")
        .select("id, sync_status")
        .eq("user_id", clerkUserId)
        .maybeSingle();

      if (credError) {
        req.log.error(
          { err: credError },
          "Error checking calendar credentials"
        );
        return res.status(500).json({
          error: "Failed to verify calendar connection",
          requestId: req.id,
        });
      }

      if (!credentials) {
        return res.status(404).json({
          error: "No calendar connected. Please connect your Google Calendar first.",
          requestId: req.id,
        });
      }

      if (credentials.sync_status === "expired" || credentials.sync_status === "auth_required") {
        return res.status(401).json({
          error: "Calendar connection expired. Please reconnect your Google Calendar.",
          requestId: req.id,
        });
      }

      // Resolve organization ID if user is in an org context
      let organizationId: string | undefined;
      if (clerkOrgId) {
        const resolvedOrgId = await resolveOrgId(supabase, clerkOrgId, req.log);
        if (resolvedOrgId) {
          organizationId = resolvedOrgId;
        }
      }

      // Send Vercel Workflow event for async calendar event creation
      await workflow.send({
        name: "calendar/create-event",
        data: {
          userId: clerkUserId,
          summary,
          startDateTime,
          endDateTime,
          description,
          attendees,
          location,
          addVideoConference,
          organizationId,
        },
      });

      req.log.info(
        { userId: clerkUserId, summary },
        "Dispatched calendar/create-event"
      );

      return res.status(202).json({
        success: true,
        message: "Calendar event creation initiated",
        summary,
        startDateTime,
        requestId: req.id,
      });
    } catch (error: any) {
      req.log.error({ err: error }, "Error creating calendar event");
      return res.status(500).json({
        error: error.message || "Internal server error",
        requestId: req.id,
      });
    }
  }
);

// ===========================================================================
// Meeting Prep Routes
// ===========================================================================

interface MeetingPrepRequestBody {
  eventId?: string;
  query?: string;
  dateContext?: {
    dateFrom: string;
    dateTo: string;
    relative: string;
    keywords?: string[];
  };
  includeWebResearch?: boolean;
}

interface MeetingPrepJob {
  jobId: string;
  eventId: string;
  userId: string;
  organizationId?: string;
  status: "pending" | "running" | "completed" | "failed";
  createdAt: string;
}

/**
 * POST /api/calendar/meeting-prep
 *
 * Triggers meeting prep for a calendar event.
 * Returns a job ID for polling, or cached prep if available.
 *
 * Replaces: supabase.functions.invoke('calendar-meeting-prep-agent', ...)
 */
router.post(
  "/calendar/meeting-prep",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const { userId: clerkUserId, orgId: clerkOrgId } = auth;

      if (!clerkUserId) {
        return res.status(401).json({
          error: "Unauthorized - No user ID in session",
          requestId: req.id,
        });
      }

      const { eventId, query, dateContext, includeWebResearch } =
        req.body as MeetingPrepRequestBody;

      req.log.info(
        { userId: clerkUserId, eventId: eventId || "from query" },
        "Meeting prep requested"
      );

      const supabase = getSupabaseAdmin();

      // Resolve organization ID if user is in an org context
      let organizationId: string | undefined;
      if (clerkOrgId) {
        const resolvedOrgId = await resolveOrgId(supabase, clerkOrgId, req.log);
        if (resolvedOrgId) {
          organizationId = resolvedOrgId;
        }
      }

      // If no eventId provided but dateContext is, find events in that date range
      let targetEventId = eventId;
      if (!targetEventId && dateContext) {
        const { data: events, error: eventsError } = await supabase
          .from("calendar_events")
          .select("id, summary, start_time, attendees")
          .eq("user_id", clerkUserId)
          .gte("start_time", dateContext.dateFrom)
          .lte("start_time", dateContext.dateTo)
          .order("start_time", { ascending: true })
          .limit(1);

        if (eventsError) {
          req.log.error({ err: eventsError }, "Error finding events");
          return res.status(500).json({
            error: "Failed to find calendar events",
            requestId: req.id,
          });
        }

        if (!events || events.length === 0) {
          return res.status(404).json({
            error: `No meetings found for ${dateContext.relative}`,
            requestId: req.id,
          });
        }

        targetEventId = events[0].id;
        req.log.info(
          { summary: events[0].summary, eventId: targetEventId },
          "Found event from dateContext"
        );
      }

      if (!targetEventId) {
        return res.status(400).json({
          error: "eventId or dateContext required",
          requestId: req.id,
        });
      }

      // Check for cached prep first
      const { data: cachedPrep, error: cacheError } = await supabase
        .from("meeting_prep_cache")
        .select("*")
        .eq("user_id", clerkUserId)
        .eq("event_id", targetEventId)
        .maybeSingle();

      if (!cacheError && cachedPrep && cachedPrep.prep_content) {
        req.log.info("Returning cached meeting prep");
        return res.status(200).json({
          status: "completed",
          prep: cachedPrep.prep_content,
          sources: cachedPrep.web_research_sources
            ? JSON.parse(cachedPrep.web_research_sources)
            : [],
          cached: true,
          requestId: req.id,
        });
      }

      // Check for existing workflow run (to avoid duplicates)
      const threadId = `meeting-prep-${clerkUserId}-${targetEventId}`;
      const { data: existingRun, error: runCheckError } = await supabase
        .from("langgraph_workflow_runs")
        .select("*")
        .eq("thread_id", threadId)
        .eq("user_id", clerkUserId)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!runCheckError && existingRun) {
        if (existingRun.status === "completed" && existingRun.final_prep_content) {
          req.log.info("Returning completed workflow result");
          return res.status(200).json({
            status: "completed",
            prep: existingRun.final_prep_content,
            sources: existingRun.sources_used || [],
            cached: true,
            jobId: existingRun.id,
            requestId: req.id,
          });
        }

        if (existingRun.status === "running" || existingRun.status === "interrupted") {
          req.log.info({ workflowStatus: existingRun.status }, "Workflow already in progress");
          return res.status(202).json({
            status: existingRun.status,
            jobId: existingRun.id,
            message: `Meeting prep is ${existingRun.status}. Poll for results.`,
            requestId: req.id,
          });
        }
      }

      // Create a new job ID
      const jobId = `prep-${crypto.randomUUID()}`;

      // Send Vercel Workflow event for async meeting prep
      await workflow.send({
        name: "calendar/meeting-prep",
        data: {
          userId: clerkUserId,
          eventId: targetEventId,
          organizationId,
          requireApproval: false,
        },
      });

      req.log.info(
        { userId: clerkUserId, eventId: targetEventId },
        "Dispatched calendar/meeting-prep event"
      );

      return res.status(202).json({
        status: "pending",
        jobId,
        eventId: targetEventId,
        message: "Meeting prep initiated. Poll for results.",
        requestId: req.id,
      });
    } catch (error: any) {
      req.log.error({ err: error }, "Error triggering meeting prep");
      return res.status(500).json({
        error: error.message || "Internal server error",
        requestId: req.id,
      });
    }
  }
);

/**
 * GET /api/calendar/meeting-prep/:eventId
 *
 * Polls for meeting prep status/results.
 * Returns the prep content when complete, or current status if still processing.
 */
router.get(
  "/calendar/meeting-prep/:eventId",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const { userId: clerkUserId } = auth;

      if (!clerkUserId) {
        return res.status(401).json({
          error: "Unauthorized - No user ID in session",
          requestId: req.id,
        });
      }

      const { eventId } = req.params;

      if (!eventId) {
        return res.status(400).json({
          error: "eventId is required",
          requestId: req.id,
        });
      }

      req.log.info(
        { userId: clerkUserId, eventId },
        "Polling meeting prep"
      );

      const supabase = getSupabaseAdmin();

      // Check for cached prep first (fastest path)
      const { data: cachedPrep, error: cacheError } = await supabase
        .from("meeting_prep_cache")
        .select("*")
        .eq("user_id", clerkUserId)
        .eq("event_id", eventId)
        .maybeSingle();

      if (!cacheError && cachedPrep && cachedPrep.prep_content) {
        req.log.info("Returning cached meeting prep");
        return res.status(200).json({
          status: "completed",
          prep: cachedPrep.prep_content,
          sources: cachedPrep.web_research_sources
            ? JSON.parse(cachedPrep.web_research_sources)
            : [],
          cached: true,
          requestId: req.id,
        });
      }

      // Check workflow run status
      const threadId = `meeting-prep-${clerkUserId}-${eventId}`;
      const { data: workflowRun, error: runError } = await supabase
        .from("langgraph_workflow_runs")
        .select("*")
        .eq("thread_id", threadId)
        .eq("user_id", clerkUserId)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (runError) {
        req.log.error({ err: runError }, "Error checking workflow run");
        return res.status(500).json({
          error: "Failed to check prep status",
          requestId: req.id,
        });
      }

      if (!workflowRun) {
        return res.status(404).json({
          status: "not_found",
          message: "No meeting prep job found for this event",
          requestId: req.id,
        });
      }

      if (workflowRun.status === "completed") {
        req.log.info("Returning completed workflow result");
        return res.status(200).json({
          status: "completed",
          prep: workflowRun.final_prep_content,
          sources: workflowRun.sources_used || [],
          jobId: workflowRun.id,
          requestId: req.id,
        });
      }

      if (workflowRun.status === "failed") {
        req.log.info({ errorMessage: workflowRun.error_message }, "Workflow failed");
        return res.status(200).json({
          status: "failed",
          error: workflowRun.error_message || "Meeting prep failed",
          jobId: workflowRun.id,
          requestId: req.id,
        });
      }

      // Still running or interrupted
      return res.status(200).json({
        status: workflowRun.status,
        jobId: workflowRun.id,
        message:
          workflowRun.status === "interrupted"
            ? "Awaiting approval"
            : "Meeting prep in progress",
        startedAt: workflowRun.started_at,
        attendeesCompleted: workflowRun.attendees_completed?.length || 0,
        requestId: req.id,
      });
    } catch (error: any) {
      req.log.error({ err: error }, "Error polling meeting prep");
      return res.status(500).json({
        error: error.message || "Internal server error",
        requestId: req.id,
      });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/calendar/sales-prep
// Generate a competitive sales brief for a given company
// ---------------------------------------------------------------------------

router.post(
  "/calendar/sales-prep",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      if (!auth.userId) {
        return res.status(401).json({ error: "Unauthorized", requestId: req.id });
      }

      const { company, userCompany, topic, additionalContext } = req.body as {
        company: string;
        userCompany?: string;
        topic?: string;
        additionalContext?: string;
      };

      if (!company) {
        return res.status(400).json({ error: "company is required", requestId: req.id });
      }

      req.log.info({ company }, "Sales prep requested");

      const { getAnthropicClient } = await import("../workflows/utils/llm/clients");
      const anthropic = getAnthropicClient();

      const prompt = `Generate a concise competitive sales brief for a meeting with ${company}.
${userCompany ? `Our company: ${userCompany}` : ""}
${topic ? `Topic: ${topic}` : ""}
${additionalContext ? `Additional context: ${additionalContext}` : ""}

Include these sections:
## TL;DR (2-3 sentences)
## Who They Are (company overview, size, market position)
## Their Likely Pain Points (3-5 bullet points)
## Why We Fit (3-5 bullet points on value proposition)
## Potential Objections & Counters (2-3 objections with counters)
## Smart Discovery Questions (5 questions)
## 30-Second Talk Track

Keep it actionable and specific. Focus on what a sales rep needs to know walking into this meeting.`;

      const message = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      });

      const prep =
        message.content[0].type === "text" ? message.content[0].text : "";

      return res.json({ prep });
    } catch (error: any) {
      req.log.error({ err: error }, "Sales prep error");
      return res.status(500).json({
        error: error.message || "Failed to generate sales prep",
        requestId: req.id,
      });
    }
  }
);

export default router;
