/**
 * Shared activity summary utility.
 *
 * Queries today's autonomous actions from multiple tables and returns
 * a structured summary. Used by:
 * - action-digest cron (sends Slack DM at 5 PM)
 * - settings skill get_activity_summary tool (conversational queries)
 * - GET /api/routes/activity endpoint (Activity page)
 */

import { getSupabaseAdmin } from "./supabase";
import { getLocalDate, getLocalMidnight } from "./timezone-helpers";

// ── Types ──────��─────────────────────────────────────────────────────────────

export interface AutoSentEmail {
  id: string;
  subject: string;
  recipientEmail: string;
  confidenceScore: number | null;
  sentAt: string;
  threadId: string | null;
  theirReplyCount: number;
  lastTheirReplyAt: string | null;
}

export interface NudgedDeal {
  dealId: string;
  companyName: string;
  dealValue: number | null;
  contactEmail: string | null;
  workflowRunId: string;
  completedAt: string;
}

export interface MeetingFollowup {
  workflowRunId: string;
  meetingTitle: string | null;
  completedAt: string;
}

export interface FiredReminder {
  id: string;
  reminderText: string;
  status: string;
  triggeredAt: string;
}

export interface PendingApproval {
  id: string;
  subject: string;
  toEmail: string;
  confidenceScore: number | null;
  reasoning: string | null;
  createdAt: string;
}

export interface ProcessedEmail {
  id: string;
  fromEmail: string;
  subject: string;
  status: string;
  qualificationCategory: string | null;
  processedAt: string;
}

export interface CreatedContact {
  id: string;
  name: string;
  email: string;
  company: string | null;
  createdAt: string;
}

export interface CreatedDeal {
  id: string;
  company: string | null;
  stage: string | null;
  value: number | null;
  createdAt: string;
}

export interface ScheduledFollowup {
  id: string;
  scheduledFor: string;
  followupNumber: number | null;
  subject: string | null;
}

export interface GuardrailsUsage {
  emailsSentToday: number;
  maxEmailsPerDay: number | null;
  actionsToday: number;
  maxActionsPerDay: number | null;
}

export interface FeedbackLearning {
  id: string;
  summary: string;
  learningIds: string[];
  sourceEventIds: string[];
  sourceEventCount: number;
  learnedAt: string;
}

export interface DealStageChange {
  id: string;
  companyName: string;
  previousStage: string;
  newStage: string;
  changedAt: string;
}

export interface HandoffActivityItem {
  dispatchId: string;
  dealId: string;
  source: string;
  dispatchedAt: string;
  meetingStart: string | null;
  customerName: string | null;
  customerEmail: string | null;
  companyName: string | null;
  fitScore: number | null;
  customerIntroSent: boolean;
  repDebriefEmailSent: boolean;
  repDebriefSlackSent: boolean;
}

export interface ActivitySummary {
  date: string; // YYYY-MM-DD in user's local timezone
  pendingApprovals: PendingApproval[];
  autoSentEmails: AutoSentEmail[];
  processedEmails: ProcessedEmail[];
  createdContacts: CreatedContact[];
  createdDeals: CreatedDeal[];
  dealStageChanges: DealStageChange[];
  scheduledFollowups: ScheduledFollowup[];
  nudgedDeals: NudgedDeal[];
  meetingFollowups: MeetingFollowup[];
  firedReminders: FiredReminder[];
  learnings: FeedbackLearning[];
  handoffs: HandoffActivityItem[];
  guardrailsUsage: GuardrailsUsage;
  totalActions: number;
}

// ── Main function ──────���─────────────────────────────────────────────────────

/**
 * Returns a structured summary of all autonomous actions taken for a user
 * on a given date (in the user's local timezone).
 *
 * @param orgId - Organization ID
 * @param userId - User ID
 * @param userTimezone - IANA timezone string (e.g., "America/New_York")
 * @param targetDate - Optional YYYY-MM-DD string. Defaults to today in user's TZ.
 */
export async function getActivitySummary(
  orgId: string,
  userId: string,
  userTimezone: string,
  targetDate?: string,
): Promise<ActivitySummary> {
  const supabase = getSupabaseAdmin();
  const date = targetDate || getLocalDate(new Date().toISOString(), userTimezone);

  // Get UTC boundaries for the target date in the user's timezone
  const dayStart = getLocalMidnight(userTimezone, 0);
  const dayEnd = getLocalMidnight(userTimezone, 1);

  // If targetDate is different from today, adjust
  if (targetDate && targetDate !== getLocalDate(new Date().toISOString(), userTimezone)) {
    const diff = Math.round(
      (new Date(targetDate + "T12:00:00Z").getTime() - new Date(getLocalDate(new Date().toISOString(), userTimezone) + "T12:00:00Z").getTime()) /
        (24 * 60 * 60 * 1000),
    );
    dayStart.setTime(getLocalMidnight(userTimezone, diff).getTime());
    dayEnd.setTime(getLocalMidnight(userTimezone, diff + 1).getTime());
  }

  const startISO = dayStart.toISOString();
  const endISO = dayEnd.toISOString();

  // Run all queries in parallel
  const [
    emailsResult,
    workflowsResult,
    remindersResult,
    guardrailsResult,
    learningsResult,
    pendingResult,
    incomingEmailsResult,
    contactsResult,
    dealsResult,
    followupsResult,
    stageChangesResult,
    handoffsResult,
  ] = await Promise.all([
    // 1. Auto-sent emails (include gmail_thread_id for outcome projection)
    supabase
      .from("email_auto_response_drafts")
      .select("id, subject, to_email, confidence_score, sent_at, gmail_thread_id")
      .eq("user_id", userId)
      .eq("organization_id", orgId)
      .in("status", ["auto_sent", "sent"])
      .gte("sent_at", startISO)
      .lt("sent_at", endISO)
      .order("sent_at", { ascending: false }),

    // 2. Completed workflows (deal followups + meeting followups)
    supabase
      .from("workflow_runs")
      .select("id, workflow_kind, deal_id, metadata, status, ended_at")
      .eq("org_id", orgId)
      .eq("user_id", userId)
      .eq("status", "succeeded")
      .in("workflow_kind", ["deal_followup", "meeting_followup"])
      .gte("ended_at", startISO)
      .lt("ended_at", endISO)
      .order("ended_at", { ascending: false }),

    // 3. Fired reminders
    supabase
      .from("reminders")
      .select("id, reminder_text, status, trigger_at")
      .eq("user_id", userId)
      .in("status", ["sent", "dismissed", "snoozed"])
      .gte("trigger_at", startISO)
      .lt("trigger_at", endISO)
      .order("trigger_at", { ascending: false }),

    // 4. Guardrails: count today's emails for rate limit display
    supabase
      .from("email_auto_response_drafts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("organization_id", orgId)
      .in("status", ["auto_sent", "sent"])
      .gte("sent_at", startISO)
      .lt("sent_at", endISO),

    // 5. Feedback learnings extracted today
    supabase
      .from("usage_events")
      .select("id, event_name, metadata, created_at")
      .eq("user_id", userId)
      .eq("org_id", orgId)
      .contains("metadata", { type: "feedback_learning" })
      .gte("created_at", startISO)
      .lt("created_at", endISO)
      .order("created_at", { ascending: false }),

    // 6. Pending approvals
    supabase
      .from("email_auto_response_drafts")
      .select("id, subject, to_email, confidence_score, agent_reasoning, created_at")
      .eq("user_id", userId)
      .eq("organization_id", orgId)
      .in("status", ["pending", "pending_approval"])
      .order("created_at", { ascending: false })
      .limit(20),

    // 7. Incoming emails processed today
    supabase
      .from("incoming_emails")
      .select("id, from_email, subject, status, qualification_category, created_at")
      .eq("user_id", userId)
      .eq("organization_id", orgId)
      .gte("created_at", startISO)
      .lt("created_at", endISO)
      .order("created_at", { ascending: false }),

    // 8. Contacts created from inbound emails today
    supabase
      .from("contacts")
      .select("id, full_name, email, company_name, created_at")
      .eq("organization_id", orgId)
      .eq("source", "inbound_email")
      .gte("created_at", startISO)
      .lt("created_at", endISO)
      .order("created_at", { ascending: false }),

    // 9. Deals created from inbound emails today
    supabase
      .from("deals")
      .select("id, company_name, stage, value, created_at")
      .eq("organization_id", orgId)
      .eq("source", "inbound_email")
      .gte("created_at", startISO)
      .lt("created_at", endISO)
      .order("created_at", { ascending: false }),

    // 10. Scheduled followups (forward-looking, not date-filtered)
    supabase
      .from("email_scheduled_followups")
      .select("id, scheduled_for, followup_number, subject")
      .eq("user_id", userId)
      .eq("organization_id", orgId)
      .eq("status", "scheduled")
      .gte("scheduled_for", new Date().toISOString())
      .order("scheduled_for", { ascending: true })
      .limit(10),

    // 11. Deal stage changes today
    supabase
      .from("usage_events")
      .select("id, metadata, created_at")
      .eq("user_id", userId)
      .eq("org_id", orgId)
      .eq("event_name", "deal_stage_change")
      .gte("created_at", startISO)
      .lt("created_at", endISO)
      .order("created_at", { ascending: false }),

    // 12. Autonomous handoffs dispatched today (filter to deals owned by this user)
    supabase
      .from("handoff_dispatches")
      .select(
        "id, deal_id, source, dispatched_at, meeting_start, customer_intro_sent_at, rep_debrief_email_sent_at, rep_debrief_slack_sent_at, dossier_id, deals!inner(user_id, contact_name, contact_email, company_name)",
      )
      .eq("organization_id", orgId)
      .eq("deals.user_id", userId)
      .gte("dispatched_at", startISO)
      .lt("dispatched_at", endISO)
      .order("dispatched_at", { ascending: false }),
  ]);

  // Parse emails + batch-fetch outcome data from email_thread_conversations
  const emailRows = emailsResult.data || [];
  const threadIds = Array.from(
    new Set(emailRows.map((e: any) => e.gmail_thread_id).filter((id: string | null) => !!id)),
  );

  const outcomeByThreadId = new Map<string, { theirReplyCount: number; lastTheirReplyAt: string | null }>();
  if (threadIds.length > 0) {
    const { data: outcomes } = await supabase
      .from("email_thread_conversations")
      .select("gmail_thread_id, their_reply_count, last_their_reply_at")
      .eq("user_id", userId)
      .eq("organization_id", orgId)
      .in("gmail_thread_id", threadIds);

    for (const o of outcomes || []) {
      outcomeByThreadId.set(o.gmail_thread_id, {
        theirReplyCount: o.their_reply_count || 0,
        lastTheirReplyAt: o.last_their_reply_at || null,
      });
    }
  }

  const autoSentEmails: AutoSentEmail[] = emailRows.map((e: any) => {
    const outcome = e.gmail_thread_id ? outcomeByThreadId.get(e.gmail_thread_id) : undefined;
    return {
      id: e.id,
      subject: e.subject || "(no subject)",
      recipientEmail: e.to_email || "",
      confidenceScore: e.confidence_score,
      sentAt: e.sent_at,
      threadId: e.gmail_thread_id || null,
      theirReplyCount: outcome?.theirReplyCount || 0,
      lastTheirReplyAt: outcome?.lastTheirReplyAt || null,
    };
  });

  // Parse workflows into deals and meetings
  const nudgedDeals: NudgedDeal[] = [];
  const meetingFollowups: MeetingFollowup[] = [];

  for (const w of workflowsResult.data || []) {
    if (w.workflow_kind === "deal_followup") {
      const meta = (w.metadata as any) || {};
      nudgedDeals.push({
        dealId: w.deal_id || "",
        companyName: meta.company_name || meta.companyName || "Unknown",
        dealValue: meta.deal_value || meta.dealValue || null,
        contactEmail: meta.contact_email || meta.contactEmail || null,
        workflowRunId: w.id,
        completedAt: w.ended_at,
      });
    } else if (w.workflow_kind === "meeting_followup") {
      const meta = (w.metadata as any) || {};
      meetingFollowups.push({
        workflowRunId: w.id,
        meetingTitle: meta.title || null,
        completedAt: w.ended_at,
      });
    }
  }

  // Parse reminders (table may not exist yet — handle gracefully)
  const firedReminders: FiredReminder[] = (remindersResult.data || []).map((r: any) => ({
    id: r.id,
    reminderText: r.reminder_text,
    status: r.status,
    triggeredAt: r.trigger_at,
  }));

  // Guardrails usage
  const emailsSentToday = guardrailsResult.count || 0;

  // Fetch org guardrails config
  const { data: org } = await supabase
    .from("organizations")
    .select("feature_flags")
    .eq("id", orgId)
    .single();
  const flags = (org?.feature_flags as any) || {};
  const guardrails = flags.guardrails || {};

  const guardrailsUsage: GuardrailsUsage = {
    emailsSentToday,
    maxEmailsPerDay: guardrails.max_emails_per_day ?? null,
    actionsToday: autoSentEmails.length + nudgedDeals.length + meetingFollowups.length,
    maxActionsPerDay: guardrails.max_actions_per_day ?? null,
  };

  // Parse feedback learnings
  const learnings: FeedbackLearning[] = (learningsResult.data || []).map((e: any) => {
    const meta = (e.metadata as any) || {};
    return {
      id: e.id,
      summary: e.event_name || "Updated preferences from feedback",
      learningIds: meta.learningIds || [],
      sourceEventIds: meta.sourceEventIds || [],
      sourceEventCount: meta.sourceEventCount || 0,
      learnedAt: e.created_at,
    };
  });

  // Parse pending approvals
  const pendingApprovals: PendingApproval[] = (pendingResult.data || []).map((e: any) => ({
    id: e.id,
    subject: e.subject || "(no subject)",
    toEmail: e.to_email ?? "",
    confidenceScore: e.confidence_score,
    reasoning: e.agent_reasoning || null,
    createdAt: e.created_at,
  }));

  // Parse processed emails
  const processedEmails: ProcessedEmail[] = (incomingEmailsResult.data || []).map((e: any) => ({
    id: e.id,
    fromEmail: e.from_email || "",
    subject: e.subject || "(no subject)",
    status: e.status || "unknown",
    qualificationCategory: e.qualification_category || null,
    processedAt: e.created_at,
  }));

  // Parse created contacts
  const createdContacts: CreatedContact[] = (contactsResult.data || []).map((c: any) => ({
    id: c.id,
    name: c.full_name || "",
    email: c.email || "",
    company: c.company_name || null,
    createdAt: c.created_at,
  }));

  // Parse created deals
  const createdDeals: CreatedDeal[] = (dealsResult.data || []).map((d: any) => ({
    id: d.id,
    company: d.company_name || null,
    stage: d.stage || null,
    value: d.value || null,
    createdAt: d.created_at,
  }));

  // Parse deal stage changes
  const dealStageChanges: DealStageChange[] = (stageChangesResult.data || []).map((e: any) => {
    const meta = (e.metadata as any) || {};
    return {
      id: e.id,
      companyName: meta.company_name || "Unknown",
      previousStage: meta.previous_stage || "Unknown",
      newStage: meta.new_stage || "Unknown",
      changedAt: e.created_at,
    };
  });

  // Parse scheduled followups
  const scheduledFollowups: ScheduledFollowup[] = (followupsResult.data || []).map((f: any) => ({
    id: f.id,
    scheduledFor: f.scheduled_for,
    followupNumber: f.followup_number || null,
    subject: f.subject || null,
  }));

  // Parse Autonomous handoffs dispatched today
  const handoffRows = (handoffsResult.data ?? []) as unknown as Array<{
    id: string;
    deal_id: string;
    source: string;
    dispatched_at: string;
    meeting_start: string | null;
    customer_intro_sent_at: string | null;
    rep_debrief_email_sent_at: string | null;
    rep_debrief_slack_sent_at: string | null;
    dossier_id: string | null;
    deals?: { contact_name: string | null; contact_email: string | null; company_name: string | null } | null;
  }>;

  const dossierIds = handoffRows.map((h) => h.dossier_id).filter((id): id is string => !!id);
  const fitScoreByDossier = new Map<string, number | null>();
  if (dossierIds.length > 0) {
    const { data: dossiers } = await supabase
      .from("handoff_dossiers")
      .select("id, fit_score")
      .in("id", dossierIds);
    for (const d of dossiers ?? []) fitScoreByDossier.set(d.id, d.fit_score);
  }

  const handoffs: HandoffActivityItem[] = handoffRows.map((h) => ({
    dispatchId: h.id,
    dealId: h.deal_id,
    source: h.source,
    dispatchedAt: h.dispatched_at,
    meetingStart: h.meeting_start,
    customerName: h.deals?.contact_name ?? null,
    customerEmail: h.deals?.contact_email ?? null,
    companyName: h.deals?.company_name ?? null,
    fitScore: h.dossier_id ? fitScoreByDossier.get(h.dossier_id) ?? null : null,
    customerIntroSent: !!h.customer_intro_sent_at,
    repDebriefEmailSent: !!h.rep_debrief_email_sent_at,
    repDebriefSlackSent: !!h.rep_debrief_slack_sent_at,
  }));

  const totalActions =
    autoSentEmails.length +
    nudgedDeals.length +
    meetingFollowups.length +
    firedReminders.length +
    handoffs.length;

  return {
    date,
    pendingApprovals,
    autoSentEmails,
    processedEmails,
    createdContacts,
    createdDeals,
    dealStageChanges,
    scheduledFollowups,
    nudgedDeals,
    meetingFollowups,
    firedReminders,
    learnings,
    handoffs,
    guardrailsUsage,
    totalActions,
  };
}
