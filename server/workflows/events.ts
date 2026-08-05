/**
 * Vercel Workflow Event Schema Definitions
 *
 * All events in the Slack Sales Agent system are defined here for type safety
 * and consistent event handling across the application.
 */


// ============================================================================
// Email Events
// ============================================================================

export interface EmailQualifyData {
  userId: string;
  messageId: string;
  from: string;
  subject: string;
  body: string;
  userDomain: string;
  organizationId?: string;
}

export interface EmailProcessData {
  userId: string;
  messageId: string;
  from: string;
  subject: string;
  body: string;
  threadId?: string;
  organizationId?: string;
}

export interface EmailApprovalData {
  draftId: string;
  action: "approve" | "reject" | "edit";
  editedContent?: string;
  slackUserId?: string;
}

export interface EmailSendData {
  to: string;
  subject: string;
  body: string;
  userId: string;
  replyToMessageId?: string;
  threadId?: string;
  previousReferences?: string[];
  sendAs?: "user" | "agent";
  replyToEmail?: string;
  gmailMessageId?: string;
  /** Optional CC recipients. Used for handoff intros where the customer is CC'd. */
  cc?: string[];
  /**
   * When set, the email is sent as multipart/alternative — `body` is the
   * plain-text fallback, `htmlBody` is the rendered HTML part.
   */
  htmlBody?: string;
  /**
   * Skip appending the sender's profile signature. For agent-voiced emails
   * (handoff intros, debriefs) that already sign themselves off as Sales Agent.
   */
  skipSignature?: boolean;
  /** Links this outbound email back to a prospect chat session (warm handoff). */
  prospectSessionId?: string;
}

export interface EmailAutonomousProcessData {
  userId: string;
  messageId: string;
  from: string;
  subject: string;
  body: string;
  threadId?: string;
  organizationId?: string;
  qualificationConfidence?: number;
  qualificationCategory?: string;
}

export interface EmailRequestApprovalData {
  draftId: string;
  userId: string;
  organizationId?: string;
  subject?: string;
  body?: string;
  to?: string;
  message?: string;
  slackContext?: {
    workspaceId?: string;
    channelId?: string;
    threadTs?: string;
    botToken?: string;
  };
}

export interface EmailNotificationData {
  emailAddress: string;
  historyId: string;
}

export interface EmailPollInboxData {
  userId: string;
}

export interface EmailEnsureGmailWatchData {
  userId: string;
  // Optional: a Gmail watch is per-user (the inbox is per-user) and the org id
  // is only used for a log line. The renewal cron does not carry it.
  organizationId?: string;
}

export interface EmailFeedbackExtractData {
  userId: string;
  organizationId?: string;
}

// ============================================================================
// Calendar Events
// ============================================================================

export interface CalendarSyncData {
  userId: string;
  organizationId?: string;
}

export interface CalendarCreateEventData {
  userId: string;
  summary: string;
  startDateTime: string;
  endDateTime?: string;
  description?: string;
  attendees?: string[];
  location?: string;
  addVideoConference?: boolean;
  organizationId?: string;
}

export interface MeetingPrepData {
  userId: string;
  eventId: string;
  organizationId?: string;
  attendeesToSkip?: string[];
  requireApproval?: boolean;
  slackChannelId?: string;
  autoDeliver?: boolean;
}

export interface MeetingApprovalData {
  eventId: string;
  action: "approve" | "skip_attendees";
  attendeesToSkip?: string[];
}

// ============================================================================
// Slack Events
// ============================================================================

export interface SlackMessageData {
  type: string;
  user: string;
  text: string;
  channel: string;
  ts: string;
  [key: string]: any;
}

export interface SlackInteractionData {
  type: string;
  payload: string;
  user: {
    id: string;
    [key: string]: any;
  };
  [key: string]: any;
}

// ============================================================================
// Document/Knowledge Base Events
// ============================================================================

export interface DocumentUploadData {
  path: string;
  file?: Blob | File; // Optional - prefer using metadata.filePath for already-uploaded files (Blob cannot be JSON-serialized)
  userId: string;
  organizationId?: string;
  category?: string;
  metadata?: {
    title?: string;
    description?: string;
    docType?: string;
    tags?: string[];
    isPublic?: boolean;
    requiresNda?: boolean;
    version?: string;
    validUntil?: string;
    filePath?: string;
    fileName?: string;
    fileType?: string;
    fileSizeBytes?: number;
    textContent?: string;
  };
}

export interface DocumentProcessData {
  documentId: string;
  userId: string;
  organizationId?: string;
}

export interface DocumentGenerateEmbeddingData {
  chunkId: string;
  text: string;
  organizationId?: string;
}

export interface KnowledgeBaseSearchData {
  query: string;
  limit?: number;
  userId: string;
  organizationId?: string;
}

export interface SearchContextKBData {
  query: string;
  limit?: number;
  userId: string;
  organizationId?: string;
  category?: string;
  threshold?: number;
}

export interface SearchShareableDocsData {
  query: string;
  limit?: number;
  userId: string;
  organizationId?: string;
  doc_type?: string;
  threshold?: number;
  include_download_url?: boolean;
}

// ============================================================================
// Onboarding Events
// ============================================================================

export interface OnboardingInitializeDealsData {
  userId: string;
  organizationId?: string;
}

// ============================================================================
// Admin Events
// ============================================================================

export interface CreateWaitlistUserData {
  email: string;
  firstName: string;
  lastName: string;
  company?: string;
  title?: string;
  linkedinProfile?: string;
}

export interface SendWaitlistApprovalData {
  email: string;
  firstName: string;
  lastName: string;
  signupLink: string;
}

export interface SendOrganizationInviteData {
  inviteId: string;
}

// ============================================================================
// Briefing Events
// ============================================================================

export interface BriefingSendDailyData {
  userId: string;
  slackUserId: string;
  slackWorkspaceId: string;
  organizationId: string;
  firstName: string | null;
  timezone?: string | null;
}

// ============================================================================
// Autonomous Confirmation Events
// ============================================================================

export interface EmailAutoSendConfirmationData {
  draftId: string;
  action: "confirm" | "cancel" | "edit";
  slackUserId?: string;
}

export interface DealAutoFollowupConfirmationData {
  dealId: string;
  action: "confirm" | "cancel";
  slackUserId?: string;
}

// ============================================================================
// Deal Events
// ============================================================================


// ============================================================================
// Email Follow-Up Events
// ============================================================================

export interface EmailFollowupSendData {
  followupId: string;
  threadConversationId: string;
  userId: string;
  organizationId: string;
}

export interface EmailThreadReplyData {
  userId: string;
  messageId: string;
  from: string;
  subject: string;
  body: string;
  gmailThreadId: string;
  organizationId?: string;
  threadConversationId?: string;
}

// ============================================================================
// Meeting Follow-Up Events
// ============================================================================

export interface MeetingFollowupReadyData {
  userId: string;
  organizationId: string;
  source: string;
  externalMeetingId: string;
  title: string;
  endTime: string;
  attendees: Array<{ name: string; email?: string }>;
  highlights: string[];
  actionItems: string[];
  rawNotes?: string;
  transcriptUrl?: string;
}

// ============================================================================
// Org Context Events
// ============================================================================

export interface OrgResearchContextData {
  organizationId: string;
  userId?: string;
  source?: string;
  externalMeetingId?: string;
  title?: string;
  endTime?: string;
  attendees?: Array<{ name: string; email?: string }>;
  highlights?: string[];
  actionItems?: string[];
  rawNotes?: string;
  transcriptUrl?: string;
}

// ============================================================================
// Digest Events
// ============================================================================

export interface DigestSendDailyData {
  userId: string;
  slackUserId: string;
  slackWorkspaceId: string;
  organizationId: string;
  firstName: string | null;
}

// ============================================================================
// Feedback Learning Events
// ============================================================================

export interface FeedbackExtractLearningsData {
  userId: string;
  organizationId: string;
}

// ============================================================================
// Learning Events
// ============================================================================

export interface LearningAnalyzePreferencesData {
  userId: string;
}

// ============================================================================
// Reminder Events
// ============================================================================

export interface ReminderFireData {
  reminderId: string;
  userId: string;
  organizationId: string;
  reminderText: string;
}

// ============================================================================
// Onboarding Readiness Events
// ============================================================================

export interface OrgReadinessEvaluateData {
  orgId: string;
}

/**
 * Phase 2 forward-compat: emitted when an Autonomous agent or feedback signal
 * surfaces a knowledge gap (e.g. prospect asked something Sales Agent didn't
 * know, or admin corrected an answer). Listener will dedupe and queue
 * into org_knowledge_gaps for the onboarding chat to resurface.
 *
 * Phase 1: defined but never emitted; no listener wired.
 */
export interface OrgKnowledgeGapDetectedData {
  organizationId: string;
  /** If the gap maps to a known bank question (e.g. 'pricing.discount_authority'). */
  questionKey?: string;
  /** Freeform question text when no bank question matches. */
  questionText: string;
  /** Where the gap originated. */
  source: "autonomous_escalation" | "feedback_correction" | "chat_no_hit" | "manual";
  context?: Record<string, unknown>;
  severity?: "low" | "normal" | "high";
}

// ============================================================================
// Main Events Type
// ============================================================================

export type Events = {
  // Email events
  "email/notification": { data: EmailNotificationData };
  "email/qualify": { data: EmailQualifyData };
  "email/process": { data: EmailProcessData };
  "email/autonomous-process": { data: EmailAutonomousProcessData };
  "email/approval-response": { data: EmailApprovalData };
  "email/request-approval": { data: EmailRequestApprovalData };
  "email/send": { data: EmailSendData };
  "email/poll-inbox": { data: EmailPollInboxData };
  "email/ensure-gmail-watch": { data: EmailEnsureGmailWatchData };

  
  // Calendar events
  "calendar/sync": { data: CalendarSyncData };
  "calendar/create-event": { data: CalendarCreateEventData };
  "calendar/meeting-prep": { data: MeetingPrepData };
  "meeting/prep-approval": { data: MeetingApprovalData };
  
  // Slack events
  "slack/message": { data: SlackMessageData };
  "slack/interaction": { data: SlackInteractionData };
  "slack/event": { data: Record<string, any> };
  
  // Document events
  "document/uploaded": { data: DocumentUploadData };
  "document/process": { data: DocumentProcessData };
  "document/generate-embedding": { data: DocumentGenerateEmbeddingData };
  
  // Knowledge base events
  "knowledge-base/search": { data: KnowledgeBaseSearchData };
  "knowledge-base/search-context": { data: SearchContextKBData };
  "knowledge-base/search-shareable": { data: SearchShareableDocsData };
  
  // Onboarding events
  "onboarding/initialize-deals": { data: OnboardingInitializeDealsData };

  
  // Admin events
  "admin/create-waitlist-user": { data: CreateWaitlistUserData };
  "admin/send-waitlist-approval": { data: SendWaitlistApprovalData };
  "admin/send-organization-invite": { data: SendOrganizationInviteData };

  // Autonomous confirmation events
  "email/auto-send-confirmation": { data: EmailAutoSendConfirmationData };
  "deal/auto-followup-confirmation": { data: DealAutoFollowupConfirmationData };

  // Deal events (placeholder — no active deal event listeners)

  // Email follow-up events
  "email/followup-send": { data: EmailFollowupSendData };
  "email/thread-reply": { data: EmailThreadReplyData };

  // Meeting follow-up events
  "meeting/followup-ready": { data: MeetingFollowupReadyData };

  // Briefing events
  "briefing/send-daily": { data: BriefingSendDailyData };

  // Org context events
  "org/research-context": { data: OrgResearchContextData };

  // Digest events
  "digest/send-daily": { data: DigestSendDailyData };

  // Reminder events
  "reminder/fire": { data: ReminderFireData };

  // Feedback learning events
  "feedback/extract-learnings": { data: FeedbackExtractLearningsData };

  // Onboarding readiness events
  "org/readiness.evaluate": { data: OrgReadinessEvaluateData };

  // Phase 2: knowledge gap detection (no emitter wired yet)
  "org/knowledge.gap_detected": { data: OrgKnowledgeGapDetectedData };

  // Preference learning events
  "learning/analyze-preferences": { data: LearningAnalyzePreferencesData };

  // Agent background tasks (deal/meeting action → supervisor)
  "agent/background-task": { data: Record<string, unknown> };

  // Deep research prospecting
  "agent/deep-research": { data: Record<string, unknown> };
};
