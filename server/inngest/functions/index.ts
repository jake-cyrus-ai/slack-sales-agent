/**
 * Inngest Function Registry
 *
 * All Inngest functions must be imported and exported here
 * to be registered with the Inngest serve handler.
 */

// Knowledge Base functions
import { searchKnowledgeBase } from "./knowledge-base/search-knowledge-base";
import { searchContextKB } from "./knowledge-base/search-context-kb";
import { searchShareableDocs } from "./knowledge-base/search-shareable-docs";
import { uploadShareableDocs } from "./knowledge-base/upload-shareable-docs";
import { processDocument } from "./knowledge-base/process-document";
import { generateEmbeddings } from "./knowledge-base/generate-embeddings";

// Email functions
import { sendEmail } from "./email/send-email";
import { ensureGmailWatch } from "./email/ensure-gmail-watch";

// Calendar functions
import { syncCalendarEvents } from "./calendar/sync-calendar-events";
import { createCalendarEvent } from "./calendar/create-calendar-event";

// Agent functions
import { qualifyEmailAgent } from "./agents/qualify-email-agent";
import { emailResponseAgent } from "./agents/email-response-agent";
import { emailApprovalWorkflow } from "./agents/email-approval-workflow";
import { meetingPrepAgent } from "./agents/meeting-prep-agent";
import { meetingFollowup } from "./agents/meeting-followup";
import { autonomousEmailAgent } from "./agents/autonomous-email-agent";
import { emailFollowupAgent } from "./agents/email-followup-agent";
import { researchOrgContext } from "./research-org-context";
import { deepResearchAgent } from "./agents/deep-research";

// Background task handler — runs supervisor for fire-and-forget agent tasks
// (deal_send_followup, meeting_send_drafts, meeting_schedule button actions)
import { handleBackgroundTask } from "./agents/handle-background-task";

// Webhook handlers
import { handleGmailNotification } from "./webhooks/gmail-notification";
import { handleSlackMessage } from "./webhooks/slack-message";
import { handleSlackInteraction } from "./webhooks/slack-interaction";

// Scheduled functions
import { pollGmailInboxes, pollUserInbox } from "./scheduled/poll-gmail-inboxes";
import { syncAllCalendars } from "./scheduled/sync-all-calendars";
import { backfillUsageRollups } from "./scheduled/backfill-usage-rollups";
import { scanNewMeetings } from "./scheduled/scan-new-meetings";
import { scanPendingFollowups } from "./scheduled/scan-pending-followups";
import { scanUpcomingMeetings } from "./scheduled/scan-upcoming-meetings";
import { scanMorningBriefings, sendDailyBriefing } from "./scheduled/morning-briefing";
import { scanActionDigests, sendActionDigest } from "./scheduled/action-digest";
import { scanDueReminders, fireReminder } from "./scheduled/scan-reminders";
import { renewGmailWatches } from "./scheduled/renew-gmail-watches";

// Onboarding functions
import { sendOrganizationInvite } from "./admin/send-organization-invite";

// Learning functions
import { analyzePreferences } from "./learning/analyze-preferences";
import { scanFeedbackLearnings, extractLearnings } from "./learning/extract-learnings";

// Alert functions
import { handleFunctionFailure } from "./alerts/handle-function-failure";

// Onboarding readiness
import {
  evaluateOrgReadiness,
  evaluateAllOrgsReadiness,
} from "./onboarding/evaluate-readiness";

// Export all functions in an array
export const functions = [
  // Knowledge Base
  searchKnowledgeBase,
  searchContextKB,
  searchShareableDocs,
  uploadShareableDocs,
  processDocument,
  generateEmbeddings,

  // Email
  sendEmail,
  ensureGmailWatch,

  // Calendar
  syncCalendarEvents,
  createCalendarEvent,

  // Agents
  qualifyEmailAgent,
  emailResponseAgent,
  emailApprovalWorkflow,
  meetingPrepAgent,
  meetingFollowup,
  autonomousEmailAgent,
  emailFollowupAgent,
  researchOrgContext,
  deepResearchAgent,
  handleBackgroundTask,

  // Webhooks
  handleGmailNotification,
  handleSlackMessage,
  handleSlackInteraction,

  // Scheduled
  pollGmailInboxes,
  pollUserInbox,
  renewGmailWatches,
  syncAllCalendars,
  backfillUsageRollups,
  scanNewMeetings,
  scanPendingFollowups,
  scanUpcomingMeetings,
  scanMorningBriefings,
  sendDailyBriefing,
  scanActionDigests,
  sendActionDigest,
  scanDueReminders,
  fireReminder,

  // Onboarding
  sendOrganizationInvite,

  // Learning
  analyzePreferences,
  scanFeedbackLearnings,
  extractLearnings,

  // Alerts
  handleFunctionFailure,

  // Onboarding readiness + ingestion
  evaluateOrgReadiness,
  evaluateAllOrgsReadiness,
];
