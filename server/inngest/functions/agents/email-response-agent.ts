/**
 * Email Response Agent - Inngest Function
 *
 * Processes incoming emails with a ReAct-style agent workflow:
 * 1. Classify the email into categories
 * 2. Search knowledge bases for context
 * 3. Generate personalized draft response
 * 4. Evaluate auto-send eligibility (confidence-gated autonomy)
 * 5. Auto-send OR request approval via Slack (human-in-the-loop)
 * 6. Send approved email
 *
 * Autonomous Enhancement:
 * - Emails classified with high confidence AND matching safe categories
 *   can be auto-sent without human approval.
 * - Controlled by org-level feature_flags.email_auto_response.auto_send_threshold
 * - All auto-sent emails are logged for audit and can be reverted to manual mode.
 */

import { logger } from "../../../lib/logger";
import { NonRetriableError } from "inngest";
import { inngest } from "../../client";
import { getSupabaseAdmin } from "../../utils/supabase";
import { resolveOrgForUser } from "../../utils/tenant-resolver";
import { postDmToUser } from "../../utils/slack-helpers";
import { generateClaudeMessage, parseJSONResponse } from "../../utils/llm/clients";
import { SALES_AGENT_VOICE_PROMPT } from "../../utils/company-context";
import { sendEmail } from "../email/send-email";
import {
  getOrgFeatureFlags,
  isAutonomousModeEnabled,
  checkEmailRateLimit,
  checkCooldownPeriod,
} from "../../utils/feature-flags";

const log = logger.child({ fn: "email-response-agent" });

interface EmailClassification {
  classification: string;
  confidence: number;
  reasoning: string;
}

interface AutoSendEvaluation {
  shouldAutoSend: boolean;
  confidence: number;
  reasoning: string;
}

/** Categories considered safe for auto-send when confidence is high enough */
const AUTO_SEND_SAFE_CATEGORIES = [
  "meeting_request",
  "follow_up",
  "product_question",
];

/** Default confidence threshold — org can override via feature_flags */
const DEFAULT_AUTO_SEND_THRESHOLD = 0.92;

/**
 * Evaluate whether a draft can be auto-sent without human approval.
 * Requires: high classification confidence + safe category + org opt-in.
 */
function evaluateAutoSend(
  classification: EmailClassification,
  draftBody: string,
  orgThreshold: number,
): AutoSendEvaluation {
  // Category must be in the safe list
  if (!AUTO_SEND_SAFE_CATEGORIES.includes(classification.classification)) {
    return {
      shouldAutoSend: false,
      confidence: classification.confidence,
      reasoning: `Category "${classification.classification}" is not in the auto-send safe list`,
    };
  }

  // Classification confidence must exceed org threshold
  if (classification.confidence < orgThreshold) {
    return {
      shouldAutoSend: false,
      confidence: classification.confidence,
      reasoning: `Confidence ${classification.confidence} is below threshold ${orgThreshold}`,
    };
  }

  // Draft must not be too long (long emails are riskier to auto-send)
  if (draftBody.length > 1500) {
    return {
      shouldAutoSend: false,
      confidence: classification.confidence,
      reasoning: "Draft exceeds 1500 chars — requires human review",
    };
  }

  return {
    shouldAutoSend: true,
    confidence: classification.confidence,
    reasoning: `Auto-send: category="${classification.classification}", confidence=${classification.confidence} >= ${orgThreshold}`,
  };
}

export const emailResponseAgent = inngest.createFunction(
  {
    id: "email-response-agent",
    retries: 3,
    concurrency: [
      {
        // Per-user: limit concurrent email processing to prevent race conditions
        // with rate-limit checks (two emails could pass the check simultaneously)
        limit: 2,
        key: "event.data.userId",
      },
    ],
  },
  { event: "email/process" },
  async ({ event, step }) => {
    const { userId, messageId, from, subject, body, threadId, organizationId } = event.data;

    // Step 1: Get user's organization for multi-tenant isolation
    const actualOrgId = await step.run("get-organization", async () => {
      if (organizationId) return organizationId;
      const resolved = await resolveOrgForUser(userId);
      if (!resolved) {
        // Without an org id the draft would be written with organization_id=null,
        // breaking RLS isolation and silently skipping the auto-send guardrails.
        // The email came from an unknown user — retrying will not help.
        throw new NonRetriableError(
          `Cannot resolve organization for user ${userId} — aborting email response`,
        );
      }
      return resolved;
    });

    // Step 2: Fetch incoming email from database
    const incomingEmail = await step.run("fetch-email", async () => {
      const supabase = getSupabaseAdmin();

      // Try lookup by ID first (new event format), then by gmail_message_id (legacy)
      let data: any = null;
      let error: any = null;

      const { data: byId, error: idErr } = await supabase
        .from("incoming_emails")
        .select("*")
        .eq("id", messageId)
        .maybeSingle();

      if (byId) {
        data = byId;
      } else {
        const { data: byGmail, error: gmailErr } = await supabase
          .from("incoming_emails")
          .select("*")
          .eq("gmail_message_id", messageId)
          .maybeSingle();
        data = byGmail;
        error = gmailErr;
      }

      if (!data) {
        throw new Error(`Email not found: ${messageId}`);
      }

      // Verify organization ownership (multi-tenant check)
      if (actualOrgId && data.organization_id && data.organization_id !== actualOrgId) {
        throw new Error("Unauthorized: Email does not belong to organization");
      }

      // Check if already processed
      if (data.status !== "pending") {
        return { skipped: true as const, status: data.status, email: data };
      }

      // Update status to processing
      let updateQuery = supabase
        .from("incoming_emails")
        .update({
          status: "processing",
          processed_at: new Date().toISOString()
        })
        .eq("id", data.id);
      if (actualOrgId) updateQuery = updateQuery.eq("organization_id", actualOrgId);
      await updateQuery;

      return { skipped: false as const, email: data };
    });

    if (incomingEmail.skipped) {
      return {
        status: incomingEmail.status,
        message: "Email already processed",
      };
    }

    const email = incomingEmail.email;

    // Step 3: Classify email
    const classification = await step.run("classify-email", async () => {
      const prompt = `Classify this email into one of these categories:
- product_question: Question about product features or capabilities
- pricing_question: Question about pricing or plans
- technical_support: Technical issue or support request
- meeting_request: Request to schedule a meeting
- follow_up: Follow-up on previous conversation
- other: Other category

Email:
From: ${from}
Subject: ${subject}
Body: ${body.substring(0, 1500)}

Return JSON only:
{
  "classification": "category",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}`;

      const response = await generateClaudeMessage(
        [{ role: "user", content: prompt }],
        {
          model: "claude-haiku-4-5-20251001",
          temperature: 0.3,
          maxTokens: 500,
        }
      );

      const content = response.content[0];
      if (content.type !== "text") {
        throw new Error("Expected text response");
      }

      return parseJSONResponse<EmailClassification>(content.text);
    });

    // Step 4: Search knowledge base for context
    const kbContext = await step.run("search-knowledge-base", async () => {
      // Invoke knowledge base search function
      const searchQuery = `${subject} ${body.substring(0, 500)}`;
      
      // TODO: Implement actual KB search via step.invoke()
      // For now, return placeholder
      return {
        results: [],
        summary: "No context found",
      };
    });

    // Step 5: Generate draft response
    const draft = await step.run("generate-draft", async () => {
      const prompt = `${SALES_AGENT_VOICE_PROMPT}

You are responding to an inbound email on behalf of a seller. Write the reply AS the seller — never as "Sales Agent" or an AI assistant.

Incoming Email:
From: ${from}
Subject: ${subject}
Body: ${body}

Classification: ${classification.classification}

Knowledge Base Context:
${kbContext.summary}

Draft a reply that sounds like a real AE wrote it. Keep it to 2-4 sentences — short, direct, warm, and action-oriented. Never parrot back what the sender said. Move the conversation toward a clear next step.

Return JSON only:
{
  "subject": "Re: ...",
  "body": "email body text"
}`;

      const response = await generateClaudeMessage(
        [{ role: "user", content: prompt }],
        {
          model: "claude-sonnet-4-20250514",
          temperature: 0.7,
          maxTokens: 1000,
        }
      );

      const content = response.content[0];
      if (content.type !== "text") {
        throw new Error("Expected text response");
      }

      return parseJSONResponse<{ subject: string; body: string }>(content.text);
    });

    // Step 6: Save draft to database
    const draftRecord = await step.run("save-draft", async () => {
      const supabase = getSupabaseAdmin();

      const { data, error } = await supabase
        .from("email_auto_response_drafts")
        .insert({
          user_id: userId,
          organization_id: actualOrgId, // Multi-tenant isolation
          incoming_email_id: email.id,
          to_email: from,
          subject: draft.subject,
          body: draft.body,
          status: "pending",
          classification: classification.classification,
        })
        .select()
        .single();

      if (error) {
        throw new Error(`Failed to save draft: ${error.message}`);
      }

      return data;
    });

    // Validate draftRecord.id to prevent CEL injection in waitForEvent filter
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(draftRecord.id)) {
      throw new NonRetriableError(`Invalid draftRecord.id format: ${draftRecord.id}`);
    }

    // Step 7: Evaluate auto-send eligibility
    const autoSendEval = await step.run("evaluate-auto-send", async () => {
      // Fetch org-level autonomy settings
      let orgThreshold = DEFAULT_AUTO_SEND_THRESHOLD;
      let autoSendEnabled = false;

      if (actualOrgId) {
        // Master gate: autonomous mode must be enabled at org level
        if (!(await isAutonomousModeEnabled(actualOrgId))) {
          return {
            shouldAutoSend: false,
            confidence: classification.confidence,
            reasoning: "Autonomous mode is not enabled for this organization",
          };
        }

        const orgFlags = await getOrgFeatureFlags(actualOrgId);
        const flags = orgFlags.email_auto_response;
        autoSendEnabled = flags?.auto_send_enabled === true;
        orgThreshold = flags?.auto_send_threshold ?? DEFAULT_AUTO_SEND_THRESHOLD;
      }

      if (!autoSendEnabled) {
        return {
          shouldAutoSend: false,
          confidence: classification.confidence,
          reasoning: "Auto-send is not enabled for this organization",
        };
      }

      return evaluateAutoSend(classification as EmailClassification, draft.body, orgThreshold);
    });

    // ── Guardrail check before auto-send ────────────────────────────────
    let guardrailBlocked = false;
    if (autoSendEval.shouldAutoSend && actualOrgId) {
      const guardrailCheck = await step.run("check-guardrails", async () => {
        const [rateLimit, cooldown] = await Promise.all([
          checkEmailRateLimit(actualOrgId!, userId),
          checkCooldownPeriod(actualOrgId!, userId, from),
        ]);
        if (!rateLimit.allowed) return { blocked: true as const, reason: rateLimit.reason };
        if (!cooldown.allowed) return { blocked: true as const, reason: cooldown.reason };
        return { blocked: false as const, reason: undefined };
      });

      if (guardrailCheck.blocked) {
        log.info(`Guardrail blocked auto-send: ${guardrailCheck.reason}`);
        guardrailBlocked = true;
        // Fall through to manual approval path below
      }
    }

    // ── Auto-send path: preview + confirm OR skip confirmation ─────────
    if (autoSendEval.shouldAutoSend && !guardrailBlocked) {
      // Check if org wants to skip confirmation (fully autonomous)
      const skipConfirmation = await step.run("check-skip-confirmation", async () => {
        if (!actualOrgId) return false;
        const orgFlags = await getOrgFeatureFlags(actualOrgId);
        return orgFlags.email_auto_response?.skip_confirmation === true;
      });

      // Default: send preview and ask for confirmation
      if (!skipConfirmation) {
        // Send Slack DM preview with Confirm / Cancel buttons
        await step.run("send-auto-send-preview", async () => {
          const preview = draft.body.length > 300 ? draft.body.substring(0, 300) + "..." : draft.body;

          const result = await postDmToUser({
            agentUserId: userId,
            organizationId: actualOrgId!,
            text: `Sales Agent wants to auto-reply to ${from}`,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `*Ready to send* — _${classification.classification}_ (${(classification.confidence * 100).toFixed(0)}% confidence)\n\n*To:* ${from}\n*Subject:* ${draft.subject}\n\n\`\`\`${preview}\`\`\``,
                },
              },
              {
                type: "context",
                elements: [
                  {
                    type: "mrkdwn",
                    text: `${autoSendEval.reasoning} · Expires in 5 min if no action taken`,
                  },
                ],
              },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: { type: "plain_text", text: "Send Now" },
                    style: "primary",
                    value: draftRecord.id,
                    action_id: "confirm_auto_send",
                  },
                  {
                    type: "button",
                    text: { type: "plain_text", text: "Cancel" },
                    style: "danger",
                    value: draftRecord.id,
                    action_id: "cancel_auto_send",
                  },
                  {
                    type: "button",
                    text: { type: "plain_text", text: "Edit" },
                    value: draftRecord.id,
                    action_id: "edit_email",
                  },
                ],
              },
            ],
          });

          return { sent: result.ok, messageTs: result.ts };
        });

        // Wait for confirmation (5-min window — expires on timeout for safety)
        const confirmation = await step.waitForEvent("wait-for-auto-send-confirmation", {
          event: "email/auto-send-confirmation",
          timeout: "5m",
          if: `async.data.draftId == '${draftRecord.id}'`,
        });

        if (confirmation?.data.action === "confirm") {
          // User explicitly confirmed — proceed with auto-send
          const sendResult = await step.invoke("auto-send-email", {
            function: sendEmail,
            data: {
              to: from,
              subject: draft.subject,
              body: draft.body,
              userId,
              replyToMessageId: messageId,
              threadId,
            },
          });

          await step.run("update-auto-sent-status", async () => {
            const supabase = getSupabaseAdmin();
            await supabase
              .from("email_auto_response_drafts")
              .update({
                status: "auto_sent",
                approved_at: new Date().toISOString(),
                sent_at: new Date().toISOString(),
                gmail_message_id: sendResult.messageId,
                auto_send_reasoning: autoSendEval.reasoning,
              })
              .eq("id", draftRecord.id);
            await supabase
              .from("incoming_emails")
              .update({ status: "auto_sent" })
              .eq("id", email.id);
          });

          log.info(`Auto-sent reply to ${from} [confirmed] (confidence: ${autoSendEval.confidence})`);
          return {
            status: "auto_sent",
            draftId: draftRecord.id,
            messageId: sendResult.messageId,
            autoSendReasoning: autoSendEval.reasoning,
            confirmedBy: "user",
          };
        } else if (confirmation?.data.action === "edit") {
          // User wants to edit — re-trigger approval workflow
          await step.sendEvent("re-request-approval", {
            name: "email/request-approval",
            data: { draftId: draftRecord.id, userId },
          });
          return { status: "edited", draftId: draftRecord.id, action: "edit" };
        } else {
          // Cancelled OR timed out — fall through to manual approval flow
          const reason = confirmation ? "cancelled" : "timeout";
          log.info(`Auto-send not sent for ${from} (${reason}), falling through to manual approval`);
          // Continue to manual approval path below
        }
      } else {
        // skip_confirmation = true — send immediately without preview
        const sendResult = await step.invoke("auto-send-email", {
          function: sendEmail,
          data: {
            to: from,
            subject: draft.subject,
            body: draft.body,
            userId,
            replyToMessageId: messageId,
            threadId,
          },
        });

        await step.run("update-auto-sent-status", async () => {
          const supabase = getSupabaseAdmin();
          await supabase
            .from("email_auto_response_drafts")
            .update({
              status: "auto_sent",
              approved_at: new Date().toISOString(),
              sent_at: new Date().toISOString(),
              gmail_message_id: sendResult.messageId,
              auto_send_reasoning: autoSendEval.reasoning,
            })
            .eq("id", draftRecord.id);
          await supabase
            .from("incoming_emails")
            .update({ status: "auto_sent" })
            .eq("id", email.id);
        });

        // FYI DM notification
        await step.run("notify-auto-sent", async () => {
          const preview = draft.body.length > 200 ? draft.body.substring(0, 200) + "..." : draft.body;
          const result = await postDmToUser({
            agentUserId: userId,
            organizationId: actualOrgId!,
            text: `Auto-sent email to ${from}`,
            blocks: [
              {
                type: "context",
                elements: [
                  {
                    type: "mrkdwn",
                    text: `*Auto-sent* reply to *${from}* — _${classification.classification}_ (${(classification.confidence * 100).toFixed(0)}% confidence)`,
                  },
                ],
              },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `*Subject:* ${draft.subject}\n\`\`\`${preview}\`\`\``,
                },
              },
            ],
          });
          return { sent: result.ok };
        });

        log.info(`Auto-sent reply to ${from} [unapproved] (confidence: ${autoSendEval.confidence})`);
        return {
          status: "auto_sent",
          draftId: draftRecord.id,
          messageId: sendResult.messageId,
          autoSendReasoning: autoSendEval.reasoning,
          confirmedBy: "skip_confirmation",
        };
      }
    }

    // ── Manual approval path (existing behavior) ─────────────────────────
    // Step 8: Send Slack DM approval request
    await step.run("request-slack-approval", async () => {
      const userOrgId = await resolveOrgForUser(userId);
      if (!userOrgId) {
        log.info("No organization found, skipping Slack notification");
        return { sent: false };
      }

      const preview = draft.body.length > 300 ? draft.body.substring(0, 300) + "..." : draft.body;
      const result = await postDmToUser({
        agentUserId: userId,
        organizationId: userOrgId,
        text: `New email draft for ${from}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*New Email Draft*\n\n*To:* ${from}\n*Subject:* ${draft.subject}\n\n*Preview:*\n\`\`\`${preview}\`\`\``,
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `Classification: ${classification.classification} (${(classification.confidence * 100).toFixed(0)}% confidence)`,
              },
            ],
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Approve" },
                style: "primary",
                value: draftRecord.id,
                action_id: "approve_email",
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Reject" },
                style: "danger",
                value: draftRecord.id,
                action_id: "reject_email",
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Edit" },
                value: draftRecord.id,
                action_id: "edit_email",
              },
            ],
          },
        ],
      });

      if (!result.ok) {
        log.error({ err: result.error }, "postDmToUser failed for manual approval request");
        return { sent: false, error: result.error };
      }
      return { sent: true, messageTs: result.ts };
    });

    // Step 9: Wait for approval (human-in-the-loop)
    const approval = await step.waitForEvent("wait-for-approval", {
      event: "email/approval-response",
      timeout: "7d",
      if: `async.data.draftId == '${draftRecord.id}'`,
    });

    // Handle timeout - waitForEvent returns null when timeout expires
    if (!approval) {
      await step.run("mark-expired", async () => {
        const supabase = getSupabaseAdmin();

        await supabase
          .from("email_auto_response_drafts")
          .update({
            status: "expired",
            expired_at: new Date().toISOString(),
          })
          .eq("id", draftRecord.id);

        await supabase
          .from("incoming_emails")
          .update({ status: "expired" })
          .eq("id", email.id);
      });

      return {
        status: "expired",
        draftId: draftRecord.id,
      };
    }

    // Step 10: Handle approval decision
    if (approval.data.action === "approve") {
      // Send email via Inngest send-email function
      const sendResult = await step.invoke("send-approved-email", {
        function: sendEmail,
        data: {
          to: from,
          subject: draft.subject,
          body: draft.body,
          userId,
          replyToMessageId: messageId,
          threadId,
        },
      });

      // Update draft and incoming email status
      await step.run("update-email-status", async () => {
        const supabase = getSupabaseAdmin();

        // Update draft status
        await supabase
          .from("email_auto_response_drafts")
          .update({
            status: "sent",
            approved_at: new Date().toISOString(),
            sent_at: new Date().toISOString(),
            gmail_message_id: sendResult.messageId,
          })
          .eq("id", draftRecord.id);

        // Update incoming email status
        await supabase
          .from("incoming_emails")
          .update({ status: "sent" })
          .eq("id", email.id);
      });

      return {
        status: "sent",
        draftId: draftRecord.id,
        action: "approve",
        messageId: sendResult.messageId,
      };
    } else if (approval.data.action === "reject") {
      await step.run("mark-rejected", async () => {
        const supabase = getSupabaseAdmin();

        await supabase
          .from("email_auto_response_drafts")
          .update({ status: "rejected" })
          .eq("id", draftRecord.id);

        await supabase
          .from("incoming_emails")
          .update({ status: "skipped" })
          .eq("id", email.id);
      });

      return {
        status: "rejected",
        draftId: draftRecord.id,
        action: "reject",
      };
    } else if (approval.data.action === "edit") {
      // Handle edit - could regenerate draft or update with user's edits
      await step.run("update-draft", async () => {
        const supabase = getSupabaseAdmin();

        const newBody = approval.data.editedContent || draft.body;

        await supabase
          .from("email_auto_response_drafts")
          .update({
            body: newBody,
            status: "pending",
            edit_count: (draftRecord.edit_count || 0) + 1,
          })
          .eq("id", draftRecord.id);
      });

      // Re-trigger approval workflow
      await step.sendEvent("re-request-approval", {
        name: "email/request-approval",
        data: { draftId: draftRecord.id, userId },
      });

      return {
        status: "edited",
        draftId: draftRecord.id,
        action: "edit",
      };
    }

    return {
      status: "completed",
      draftId: draftRecord.id,
    };
  }
);
