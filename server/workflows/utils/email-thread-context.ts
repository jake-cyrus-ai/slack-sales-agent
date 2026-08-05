/**
 * Email Thread Context — Shared utilities for thread-aware email processing
 *
 * Provides:
 * - Full thread history loading from incoming_emails + drafts
 * - Conversation stage classification
 * - Human-like response delay calculation
 * - Follow-up scheduling logic
 * - CRM/deal integration helpers
 */

import { getSupabaseAdmin } from "./supabase";
import { logger } from "../../lib/logger";

const log = logger.child({ util: "email-thread-context" });

// =============================================================================
// Types
// =============================================================================

export interface ThreadMessage {
  id: string;
  direction: "inbound" | "outbound";
  from: string;
  fromName: string | null;
  subject: string;
  body: string;
  timestamp: string;
  isAutoSent: boolean;
}

export interface ThreadContext {
  threadId: string;
  messages: ThreadMessage[];
  messageCount: number;
  ourReplyCount: number;
  theirReplyCount: number;
  lastOurReplyAt: string | null;
  lastTheirReplyAt: string | null;
  conversationStage: ConversationStage;
  isFirstInteraction: boolean;
  threadSummary: string;
}

export type ConversationStage =
  | "intro"
  | "discovery"
  | "demo"
  | "negotiation"
  | "procurement"
  | "proposal"
  | "closed_won"
  | "closed_lost"
  | "nurture"
  | "meeting_scheduled";

interface StageClassifierMessage {
  direction: "inbound" | "outbound";
  body: string;
}

interface ResponseDelayConfig {
  userTimezone: string;
  isFirstReply: boolean;
  conversationStage: ConversationStage;
  relationshipStrength: "cold" | "warm" | "hot";
}

// =============================================================================
// Thread History Loading
// =============================================================================

/**
 * Load full conversation thread from DB, ordered chronologically.
 * Combines incoming_emails (their messages) and sent drafts (our messages).
 */
export async function loadThreadHistory(
  userId: string,
  gmailThreadId: string,
  organizationId?: string | null
): Promise<ThreadMessage[]> {
  const supabase = getSupabaseAdmin();

  // Fetch inbound messages in this thread
  const inboundQuery = supabase
    .from("incoming_emails")
    .select("id, from_email, from_name, subject, body_text, received_at, status")
    .eq("user_id", userId)
    .eq("gmail_thread_id", gmailThreadId)
    .order("received_at", { ascending: true });

  if (organizationId) {
    inboundQuery.eq("organization_id", organizationId);
  }

  const { data: inbound } = await inboundQuery;

  // Fetch outbound messages (our sent drafts) in this thread
  const { data: outbound } = await supabase
    .from("email_auto_response_drafts")
    .select("id, to_email, to_name, subject, body, sent_at, status, send_mode, gmail_thread_id")
    .eq("user_id", userId)
    .eq("gmail_thread_id", gmailThreadId)
    .in("status", ["sent", "auto_sent", "approved"])
    .order("sent_at", { ascending: true });

  const messages: ThreadMessage[] = [];

  // Map inbound
  for (const msg of inbound || []) {
    messages.push({
      id: msg.id,
      direction: "inbound",
      from: msg.from_email,
      fromName: msg.from_name,
      subject: msg.subject,
      body: (msg.body_text || "").substring(0, 1500),
      timestamp: msg.received_at,
      isAutoSent: false,
    });
  }

  // Map outbound
  for (const draft of outbound || []) {
    if (!draft.sent_at) continue;
    messages.push({
      id: draft.id,
      direction: "outbound",
      from: "you",
      fromName: null,
      subject: draft.subject,
      body: (draft.body || "").substring(0, 1500),
      timestamp: draft.sent_at,
      isAutoSent: draft.send_mode === "autonomous",
    });
  }

  // Sort chronologically
  messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return messages;
}

/**
 * Build full thread context including stage classification.
 */
export async function buildThreadContext(
  userId: string,
  gmailThreadId: string,
  organizationId?: string | null
): Promise<ThreadContext> {
  const messages = await loadThreadHistory(userId, gmailThreadId, organizationId);

  const ourReplies = messages.filter((m) => m.direction === "outbound");
  const theirReplies = messages.filter((m) => m.direction === "inbound");

  const lastOurReply = ourReplies[ourReplies.length - 1];
  const lastTheirReply = theirReplies[theirReplies.length - 1];

  const conversationStage = classifyConversationStage(messages);

  // Build a summary of the thread for the LLM
  const threadSummary = messages
    .map((m) => {
      const dir = m.direction === "inbound" ? `FROM ${m.fromName || m.from}` : "YOUR REPLY";
      const date = new Date(m.timestamp).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
      return `[${date}] ${dir}: ${m.body.substring(0, 300)}${m.body.length > 300 ? "..." : ""}`;
    })
    .join("\n\n");

  return {
    threadId: gmailThreadId,
    messages,
    messageCount: messages.length,
    ourReplyCount: ourReplies.length,
    theirReplyCount: theirReplies.length,
    lastOurReplyAt: lastOurReply?.timestamp || null,
    lastTheirReplyAt: lastTheirReply?.timestamp || null,
    conversationStage,
    isFirstInteraction: ourReplies.length === 0,
    threadSummary,
  };
}

// =============================================================================
// Conversation Stage Classification
// =============================================================================

// Stage classification regexes (inlined from former Autonomous deal-stages classifier)
const DEMO_RE = /\b(demo|walkthrough|see it in action|show me|trial|pilot|poc|proof of concept)\b/i;
const PRICING_RE = /\b(pric|cost|budget|quote|plan|tier|package|discount|deal|how much|what.s the cost)\b/i;
const PROCUREMENT_RE = /\b(soc.?2|iso.?27001|dpa|gdpr|hipaa|trust center|security questionnaire|legal review|security review|msa|redline|procurement|vendor approval|infosec|compliance docs?|terms of service|tos)\b/i;
const PROPOSAL_RE = /\b(contract|agreement|sign|proceed|move forward|next steps to (buy|sign)|purchase order|invoice|payment|sow|statement of work|let.s do (this|it)|i.?m in|sounds good let.?s|where do i sign)\b/i;
const OBJECTION_RE = /\b(not sure|too expensive|competitor|alternative|not ready|maybe later|think about it|budget.{0,20}(tight|limited))\b/i;
const HUMAN_RE = /\b(talk to (a |someone|human|person)|speak with|meet with|call with|set up a (call|meeting)|connect me|human handoff)\b/i;

/**
 * Classify conversation stage from message history using regex signals.
 */
export function classifyConversationStage(messages: ThreadMessage[]): ConversationStage {
  const mapped: StageClassifierMessage[] = messages.map((m) => ({
    direction: m.direction,
    body: m.body,
  }));

  if (mapped.length === 0) return "intro";

  const outbound = mapped.filter((m) => m.direction === "outbound");
  const allText = mapped.map((m) => m.body).join(" ");
  const lastInbound = [...mapped].reverse().find((m) => m.direction === "inbound");
  const lastInboundBody = lastInbound?.body ?? "";

  if (HUMAN_RE.test(lastInboundBody)) return "meeting_scheduled";
  if (PROPOSAL_RE.test(allText) && outbound.length >= 2) return "proposal";
  if (PROCUREMENT_RE.test(allText)) return "procurement";
  if (PRICING_RE.test(lastInboundBody) && outbound.length >= 1) return "negotiation";
  if (DEMO_RE.test(allText)) return "demo";
  if (OBJECTION_RE.test(lastInboundBody)) return "nurture";
  if (outbound.length >= 1) return "discovery";
  return "intro";
}

// =============================================================================
// Human-Like Response Delay
// =============================================================================

/**
 * Calculate a human-like response delay.
 * Returns the timestamp when the response should be sent.
 *
 * Behavior:
 * - Business hours (8am-6pm local): 4-45 min delay
 * - First reply to new thread: slightly longer (8-60 min)
 * - Hot leads: shorter delays (2-15 min)
 * - Off-hours: delay until next business morning + jitter
 */
export function calculateResponseDelay(config: ResponseDelayConfig): Date {
  const now = new Date();
  const localHour = getLocalHour(config.userTimezone);
  const localDow = getLocalDayOfWeek(config.userTimezone);
  const isBusinessHours = localDow >= 1 && localDow <= 5 && localHour >= 8 && localHour < 18;

  if (!isBusinessHours) {
    // Queue for next business morning with jitter
    return getNextBusinessMorning(config.userTimezone);
  }

  // During business hours — calculate appropriate delay
  let minMinutes: number;
  let maxMinutes: number;

  if (config.relationshipStrength === "hot") {
    minMinutes = 2;
    maxMinutes = 15;
  } else if (config.isFirstReply) {
    minMinutes = 8;
    maxMinutes = 60;
  } else if (config.conversationStage === "negotiation" || config.conversationStage === "proposal") {
    minMinutes = 3;
    maxMinutes = 20;
  } else {
    minMinutes = 4;
    maxMinutes = 45;
  }

  const delayMinutes = minMinutes + Math.random() * (maxMinutes - minMinutes);
  const sendAt = new Date(now.getTime() + delayMinutes * 60 * 1000);

  // If delay pushes past 6pm, queue for next business morning
  const sendAtHour = getHourAtTime(config.userTimezone, sendAt);
  if (sendAtHour >= 18) {
    return getNextBusinessMorning(config.userTimezone);
  }

  return sendAt;
}

/**
 * Calculate when to schedule a follow-up if no reply is received.
 *
 * - Intro stage: 2 business days
 * - Discovery: 3 business days
 * - Demo/proposal: 2 business days
 * - Nurture: 5 business days
 */
export function calculateFollowupTime(
  conversationStage: ConversationStage,
  userTimezone: string
): Date {
  const businessDays: Record<ConversationStage, number> = {
    intro: 2,
    discovery: 3,
    demo: 2,
    proposal: 2,
    negotiation: 1,
    procurement: 2,
    closed_won: 0,
    closed_lost: 0,
    nurture: 5,
    meeting_scheduled: 1,
  };

  const days = businessDays[conversationStage] || 3;
  if (days === 0) return new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // effectively never

  return addBusinessDays(new Date(), days, userTimezone);
}

// =============================================================================
// CRM/Deal Integration
// =============================================================================

/**
 * Update CRM contact and deal activity after sending an email.
 */
export async function updateCRMAfterSend(params: {
  userId: string;
  organizationId: string;
  toEmail: string;
  toDomain: string;
  gmailThreadId: string;
  conversationStage: ConversationStage;
  dealStage?: string;
  dealStatus?: string;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  // Update contact last_contact_date
  await supabase
    .from("contacts")
    .update({ last_contact_date: now, updated_at: now })
    .eq("user_id", params.userId)
    .eq("email", params.toEmail.toLowerCase());

  // Update deal last_activity if we can find a matching deal
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, company_name, company_domain")
    .eq("user_id", params.userId)
    .eq("email", params.toEmail.toLowerCase())
    .maybeSingle();

  if (contact?.company_name) {
    const dealUpdate: Record<string, any> = {
      last_activity: now.split("T")[0],
      updated_at: now,
    };

    if (params.dealStage) {
      // Read current stage before update to track transitions
      const { data: currentDeal } = await supabase
        .from("deals")
        .select("id, stage")
        .eq("user_id", params.userId)
        .eq("company_name", contact.company_name)
        .eq("status", "Active")
        .maybeSingle();

      const previousStage = currentDeal?.stage;

      if (previousStage !== params.dealStage) {
        dealUpdate.stage = params.dealStage;

        // Record the stage change for activity tracking
        if (currentDeal?.id) {
          await supabase.from("usage_events").insert({
            user_id: params.userId,
            org_id: params.organizationId,
            event_name: "deal_stage_change",
            metadata: {
              type: "deal_stage_change",
              deal_id: currentDeal.id,
              company_name: contact.company_name,
              previous_stage: previousStage,
              new_stage: params.dealStage,
            },
          });
        }
      }
    }
    if (params.dealStatus) {
      dealUpdate.status = params.dealStatus;
    }

    await supabase
      .from("deals")
      .update(dealUpdate)
      .eq("user_id", params.userId)
      .eq("company_name", contact.company_name)
      .eq("status", "Active");
  }
}

/**
 * Upsert thread conversation record for tracking.
 */
export async function upsertThreadConversation(params: {
  userId: string;
  organizationId: string | null;
  gmailThreadId: string;
  fromEmail: string;
  fromName: string | null;
  subject: string;
  conversationStage: ConversationStage;
  agentReasoning: string | null;
  confidenceScore: number | null;
  nextFollowupAt: Date | null;
  ourReplyCount?: number;
  theirReplyCount?: number;
}): Promise<string> {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("email_thread_conversations")
    .upsert(
      {
        user_id: params.userId,
        organization_id: params.organizationId,
        gmail_thread_id: params.gmailThreadId,
        from_email: params.fromEmail,
        from_name: params.fromName,
        from_domain: params.fromEmail.split("@")[1],
        subject: params.subject,
        conversation_stage: params.conversationStage,
        stage_updated_at: now,
        last_message_at: now,
        last_our_reply_at: now,
        our_reply_count: params.ourReplyCount || 1,
        their_reply_count: params.theirReplyCount || 1,
        last_agent_reasoning: params.agentReasoning,
        last_confidence_score: params.confidenceScore,
        next_followup_at: params.nextFollowupAt?.toISOString() || null,
        followup_status: params.nextFollowupAt ? "scheduled" : "none",
        updated_at: now,
      },
      { onConflict: "user_id,gmail_thread_id" }
    )
    .select("id")
    .single();

  if (error) {
    log.error({ err: error }, "Failed to upsert thread conversation");
    throw error;
  }

  return data.id;
}

// =============================================================================
// Timezone Helpers
// =============================================================================

function getLocalHour(tz: string): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    });
    return parseInt(formatter.format(new Date()), 10);
  } catch {
    return 9;
  }
}

function getHourAtTime(tz: string, date: Date): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    });
    return parseInt(formatter.format(date), 10);
  } catch {
    return 9;
  }
}

function getLocalDayOfWeek(tz: string): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
    });
    const day = formatter.format(new Date());
    const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[day] ?? 1;
  } catch {
    return 1;
  }
}

function getNextBusinessMorning(tz: string): Date {
  const now = new Date();
  const localHour = getLocalHour(tz);
  const localDow = getLocalDayOfWeek(tz);

  let daysToAdd = 1;

  // If it's Friday after hours, skip to Monday
  if (localDow === 5 && localHour >= 18) daysToAdd = 3;
  // Saturday
  else if (localDow === 6) daysToAdd = 2;
  // Sunday
  else if (localDow === 0) daysToAdd = 1;

  const nextMorning = new Date(now.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
  // Set to ~8:30am + jitter (8:15-9:15am)
  const jitterMinutes = 15 + Math.random() * 60;
  nextMorning.setHours(8, Math.floor(jitterMinutes), 0, 0);

  return nextMorning;
}

function addBusinessDays(start: Date, days: number, tz: string): Date {
  let current = new Date(start);
  let added = 0;

  while (added < days) {
    current = new Date(current.getTime() + 24 * 60 * 60 * 1000);
    const dow = getLocalDayOfWeek(tz);
    if (dow >= 1 && dow <= 5) {
      added++;
    }
  }

  // Set to morning with jitter
  const jitterMinutes = 15 + Math.random() * 60;
  current.setHours(9, Math.floor(jitterMinutes), 0, 0);

  return current;
}
