/**
 * Post-Send Actions — Extracted from autonomous-email-agent.ts
 *
 * Handles all post-send operations after an auto-reply is sent:
 * - CRM contact/deal updates (including deal stage progression)
 * - Attio CRM sync (deal stage + activity logging)
 * - Thread conversation upsert for tracking
 * - Follow-up scheduling
 * - Draft + incoming email status updates
 */

import { logger } from "../../lib/logger";
import { getSupabaseAdmin, getSupabaseForUser } from "./supabase";
import {
  calculateFollowupTime,
  updateCRMAfterSend,
  upsertThreadConversation,
  type ThreadContext,
  type ConversationStage,
} from "./email-thread-context";
import { runAttioAgent, hasAttioConnection } from "../../src/attio/index";
import type { UserInfo } from "../../src/agent/system-prompt";
import type { FitScoreResult } from "./fit-score-dossier";

const log = logger.child({ util: "post-send-actions" });

// =============================================================================
// Types
// =============================================================================

export interface PostSendParams {
  userId: string;
  organizationId: string;
  email: {
    id: string;
    from_email: string;
    from_name: string | null;
    from_domain: string | null;
    subject: string;
    gmail_thread_id: string | null;
    classification: string | null;
  };
  draftRecordId: string;
  sendResult: {
    gmailMessageId: string;
    gmailThreadId?: string;
  };
  generatedResponse: {
    subject: string;
    body: string;
    reasoning: string;
    confidenceScore: number;
    shouldScheduleFollowup?: boolean;
    recommendedDealStage?: string | null;
    recommendedDealStatus?: string | null;
    dealStageReasoning?: string | null;
    recommendedNextStep?: string | null;
  };
  resolvedStage: ConversationStage;
  threadContext: ThreadContext;
  prospectResearch: {
    company?: { name?: string } | null;
  };
  fitResult: FitScoreResult;
  userContext: {
    userTimezone: string | null;
  };
  ingestedProfile: {
    userName: string | null;
    userEmail: string | null;
    userCompany: string | null;
    userTitle: string | null;
  };
}

export interface PostSendResult {
  threadConversationId: string | null;
  followupScheduled: boolean;
  followupAt: string | null;
}

// =============================================================================
// Main
// =============================================================================

export async function executePostSendActions(params: PostSendParams): Promise<PostSendResult> {
  const {
    userId,
    organizationId,
    email,
    draftRecordId,
    sendResult,
    generatedResponse,
    resolvedStage,
    threadContext,
    prospectResearch,
    fitResult,
    userContext,
    ingestedProfile,
  } = params;

  const senderDomain = email.from_domain || email.from_email.split("@")[1];

  // Update CRM contact and deal (including stage/status if recommended)
  try {
    await updateCRMAfterSend({
      userId,
      organizationId,
      toEmail: email.from_email,
      toDomain: senderDomain,
      gmailThreadId: email.gmail_thread_id,
      conversationStage: resolvedStage,
      dealStage: generatedResponse.recommendedDealStage || undefined,
      dealStatus: generatedResponse.recommendedDealStatus || undefined,
    });
    if (generatedResponse.recommendedDealStage) {
      log.info(
        { dealStage: generatedResponse.recommendedDealStage, dealStatus: generatedResponse.recommendedDealStatus, reason: generatedResponse.dealStageReasoning },
        "Deal stage updated by agent"
      );
    }
  } catch (err) {
    log.error({ err }, "CRM update failed (non-fatal)");
  }

  // Calculate follow-up timing
  const shouldFollowup = generatedResponse.shouldScheduleFollowup !== false
    && resolvedStage !== "closed_won"
    && resolvedStage !== "closed_lost";

  let followupAt: string | null = null;

  if (shouldFollowup) {
    const followupTime = calculateFollowupTime(resolvedStage, userContext.userTimezone);
    followupAt = followupTime.toISOString();
  }

  // Upsert thread conversation for tracking
  let threadConversationId: string | null = null;
  try {
    if (email.gmail_thread_id) {
      threadConversationId = await upsertThreadConversation({
        userId,
        organizationId,
        gmailThreadId: email.gmail_thread_id,
        fromEmail: email.from_email,
        fromName: email.from_name,
        subject: email.subject,
        conversationStage: resolvedStage,
        agentReasoning: generatedResponse.reasoning,
        confidenceScore: generatedResponse.confidenceScore,
        nextFollowupAt: followupAt ? new Date(followupAt) : null,
        ourReplyCount: threadContext.ourReplyCount + 1,
        theirReplyCount: threadContext.theirReplyCount,
      });
    }
  } catch (err) {
    log.error({ err }, "Thread tracking failed (non-fatal)");
  }

  // Schedule follow-up if needed
  if (shouldFollowup && followupAt && threadConversationId) {
    const supabase = getSupabaseAdmin();
    await supabase
      .from("email_scheduled_followups")
      .insert({
        user_id: userId,
        organization_id: organizationId,
        thread_conversation_id: threadConversationId,
        scheduled_for: followupAt,
        followup_number: threadContext.ourReplyCount + 1,
        status: "scheduled",
      });
  }

  // Update draft and incoming email statuses
  const supabase = getSupabaseForUser(userId); // RLS-enforced; user-owned drafts + emails

  await supabase
    .from("email_auto_response_drafts")
    .update({
      status: "auto_sent",
      sent_at: new Date().toISOString(),
      gmail_message_id: sendResult.gmailMessageId,
      gmail_thread_id: sendResult.gmailThreadId,
      thread_conversation_id: threadConversationId,
    })
    .eq("id", draftRecordId);

  await supabase
    .from("incoming_emails")
    .update({ status: "auto_sent" })
    .eq("id", email.id);

  // Log activity to Attio CRM if connected
  try {
    const hasAttio = await hasAttioConnection(organizationId);
    if (hasAttio) {
      const companyName = prospectResearch.company?.name || senderDomain;
      await Promise.race([
        runAttioAgent({
          query: `Log the following activity for ${email.from_name || email.from_email} at ${companyName}:
      - Auto-sent email reply
      - Subject: ${generatedResponse.subject}
      - Conversation stage: ${resolvedStage}
      - Fit Score: ${fitResult.fitScore}/100 (${fitResult.fitLevel})
      - Confidence: ${Math.round(generatedResponse.confidenceScore * 100)}%
      Create a note on the company record summarizing this interaction.`,
          organizationId,
          user: { name: null, email: null, company: null } as UserInfo,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Attio activity log timed out")), 30_000)
        ),
      ]);
    }
  } catch (err) {
    log.warn({ err }, "Attio activity logging failed (non-fatal)");
  }

  return {
    threadConversationId,
    followupScheduled: !!followupAt,
    followupAt,
  };
}
