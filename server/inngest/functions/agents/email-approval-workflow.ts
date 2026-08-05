/**
 * Email Approval Workflow - Inngest Function
 *
 * Handles email approval workflow triggered from Slack:
 * 1. Parse user's request to send an email
 * 2. Generate email draft
 * 3. Evaluate fast-path eligibility (routine email auto-approve)
 * 4. Auto-send OR send to Slack for approval
 * 5. Wait for user response (human-in-the-loop) if needed
 * 6. Send or discard based on approval
 *
 * Autonomous Enhancement:
 * - Routine emails (meeting confirmations, simple acks, short follow-ups)
 *   can be auto-approved and sent without waiting for the Slack button click.
 * - Controlled by org-level feature_flags.email_auto_response.fast_path_enabled
 */

import { logger } from "../../../lib/logger";
import { NonRetriableError } from "inngest";
import { inngest } from "../../client";
import { getSupabaseAdmin } from "../../utils/supabase";
import { resolveOrgForUser } from "../../utils/tenant-resolver";
import { generateClaudeMessage, parseJSONResponse } from "../../utils/llm/clients";
import { sendEmail } from "../email/send-email";
import { getOrgFeatureFlags } from "../../utils/feature-flags";

const log = logger.child({ fn: "email-approval-workflow" });

interface ParsedEmailRequest {
  isEmailRequest: boolean;
  recipientEmail: string | null;
  recipientName: string | null;
  subject: string | null;
  contentHints: string | null;
  reasoning: string;
}

/** Patterns that indicate a routine, low-risk email */
const FAST_PATH_PATTERNS = [
  /\b(confirm|confirming|confirmation)\b/i,
  /\b(thank|thanks|thank you)\b/i,
  /\b(sounds good|looking forward|see you)\b/i,
  /\b(acknowledge|received|got it)\b/i,
  /\b(schedule|reschedule|calendar invite)\b/i,
];

/** Max body length for fast-path (short emails are lower risk) */
const FAST_PATH_MAX_LENGTH = 500;

export const emailApprovalWorkflow = inngest.createFunction(
  {
    id: "email-approval-workflow",
    retries: 2,
  },
  { event: "email/request-approval" },
  async ({ event, step }) => {
    const { 
      userId, 
      message, 
      slackContext,
      organizationId 
    } = event.data;

    // Step 1: Get user's organization for multi-tenant isolation
    const actualOrgId = await step.run("get-organization", async () => {
      if (organizationId) return organizationId;
      return resolveOrgForUser(userId);
    });

    // Step 2: Parse the request
    const parsedRequest = await step.run("parse-request", async () => {
      const prompt = `Parse this message to determine if it's a request to send an email.

Message: "${message}"

Extract:
- isEmailRequest: true if this is asking to send/compose an email
- recipientEmail: email address if provided
- recipientName: recipient name if provided
- subject: suggested subject line
- contentHints: what the email should be about
- reasoning: brief explanation

Return JSON only:
{
  "isEmailRequest": boolean,
  "recipientEmail": string | null,
  "recipientName": string | null,
  "subject": string | null,
  "contentHints": string | null,
  "reasoning": string
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

      return parseJSONResponse<ParsedEmailRequest>(content.text);
    });

    // If not an email request, exit early
    if (!parsedRequest.isEmailRequest) {
      return {
        status: "not_email_request",
        message: "This doesn't appear to be a request to send an email",
        reasoning: parsedRequest.reasoning,
      };
    }

    // Step 3: Generate draft email
    const draft = await step.run("generate-draft", async () => {
      const supabase = getSupabaseAdmin();

      // Get user profile for context
      const { data: profile } = await supabase
        .from("profiles")
        .select("email, first_name, last_name, company")
        .eq("user_id", userId)
        .single();

      const userName = profile
        ? `${profile.first_name || ""} ${profile.last_name || ""}`.trim()
        : "User";

      const prompt = `Generate a professional email draft.

Recipient: ${parsedRequest.recipientName || parsedRequest.recipientEmail || "Unknown"}
Subject: ${parsedRequest.subject || "Follow up"}
Context: ${parsedRequest.contentHints || "General follow up"}

Sender: ${userName}
Company: ${profile?.company || ""}

Write a concise, professional email (2-4 sentences). Be direct and helpful.

Return JSON only:
{
  "subject": "email subject",
  "body": "email body text"
}`;

      const response = await generateClaudeMessage(
        [{ role: "user", content: prompt }],
        {
          model: "claude-sonnet-4-20250514",
          temperature: 0.7,
          maxTokens: 800,
        }
      );

      const content = response.content[0];
      if (content.type !== "text") {
        throw new Error("Expected text response");
      }

      return parseJSONResponse<{ subject: string; body: string }>(content.text);
    });

    // Step 4: Create approval request record
    const approvalRequest = await step.run("create-approval-request", async () => {
      const supabase = getSupabaseAdmin();

      const { data, error } = await supabase
        .from("email_approval_requests")
        .insert({
          user_id: userId,
          organization_id: actualOrgId, // Multi-tenant isolation
          recipient_email: parsedRequest.recipientEmail || "",
          recipient_name: parsedRequest.recipientName,
          subject: draft.subject,
          body: draft.body,
          status: "pending",
          source_message: message,
          slack_workspace_id: slackContext?.workspaceId,
          slack_channel_id: slackContext?.channelId,
          slack_thread_ts: slackContext?.threadTs,
        })
        .select()
        .single();

      if (error) {
        throw new Error(`Failed to create approval request: ${error.message}`);
      }

      return data;
    });

    // Validate approvalRequest.id to prevent CEL injection in waitForEvent filter
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(approvalRequest.id)) {
      throw new NonRetriableError(`Invalid approvalRequest.id format: ${approvalRequest.id}`);
    }

    // Step 5: Evaluate fast-path auto-approve eligibility
    const fastPathEval = await step.run("evaluate-fast-path", async () => {
      // Check org feature flags
      let fastPathEnabled = false;
      if (actualOrgId) {
        const orgFlags = await getOrgFeatureFlags(actualOrgId);
        fastPathEnabled = orgFlags.email_auto_response?.fast_path_enabled === true;
      }

      if (!fastPathEnabled) {
        return { eligible: false, reason: "fast_path_not_enabled" };
      }

      // Draft must be short
      if (draft.body.length > FAST_PATH_MAX_LENGTH) {
        return { eligible: false, reason: "draft_too_long" };
      }

      // Content must match routine patterns
      const matchesPattern = FAST_PATH_PATTERNS.some(
        (pattern) => pattern.test(draft.body) || pattern.test(draft.subject)
      );

      if (!matchesPattern) {
        return { eligible: false, reason: "content_not_routine" };
      }

      return { eligible: true, reason: "routine_email_fast_path" };
    });

    // ── Fast-path: preview + confirm OR skip confirmation ───────────────
    if (fastPathEval.eligible) {
      // Check if org wants to skip confirmation (fully autonomous)
      const skipConfirmation = await step.run("check-fast-path-skip-confirmation", async () => {
        if (!actualOrgId) return false;
        const orgFlags = await getOrgFeatureFlags(actualOrgId);
        return orgFlags.email_auto_response?.skip_confirmation === true;
      });

      if (!skipConfirmation) {
        // Default: show preview with Confirm / Cancel buttons
        await step.run("send-fast-path-preview", async () => {
          if (!slackContext?.botToken || !slackContext?.channelId) return { sent: false };

          const slackResponse = await fetch("https://slack.com/api/chat.postMessage", {
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              Authorization: `Bearer ${slackContext.botToken}`,
            },
            body: JSON.stringify({
              channel: slackContext.channelId,
              thread_ts: slackContext.threadTs,
              text: `Sales Agent wants to send a routine email to ${parsedRequest.recipientEmail}`,
              blocks: [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `*Ready to send* — routine email\n\n*To:* ${parsedRequest.recipientEmail}\n*Subject:* ${draft.subject}\n\n\`\`\`${draft.body}\`\`\``,
                  },
                },
                {
                  type: "context",
                  elements: [
                    {
                      type: "mrkdwn",
                      text: `Detected as routine (${fastPathEval.reason}) · Expires in 5 min if no action taken`,
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
                      value: approvalRequest.id,
                      action_id: "confirm_auto_send",
                    },
                    {
                      type: "button",
                      text: { type: "plain_text", text: "Cancel" },
                      style: "danger",
                      value: approvalRequest.id,
                      action_id: "cancel_auto_send",
                    },
                  ],
                },
              ],
            }),
          });

          const slackResult = await slackResponse.json();
          return { sent: slackResult.ok, messageTs: slackResult.ts };
        });

        // Wait for confirmation (5-min window — expires on timeout for safety)
        const confirmation = await step.waitForEvent("wait-for-fast-path-confirmation", {
          event: "email/auto-send-confirmation",
          timeout: "5m",
          if: `async.data.draftId == '${approvalRequest.id}'`,
        });

        if (confirmation?.data.action === "confirm") {
          // User explicitly confirmed — send the email
          const sendResult = await step.invoke("fast-path-send-email", {
            function: sendEmail,
            data: {
              to: parsedRequest.recipientEmail,
              subject: draft.subject,
              body: draft.body,
              userId,
            },
          });

          await step.run("update-fast-path-status", async () => {
            const supabase = getSupabaseAdmin();
            await supabase
              .from("email_approval_requests")
              .update({
                status: "auto_approved",
                sent_at: new Date().toISOString(),
                gmail_message_id: sendResult.messageId,
              })
              .eq("id", approvalRequest.id);
          });

          log.info(`Fast-path sent to ${parsedRequest.recipientEmail} [confirmed]`);
          return {
            status: "auto_approved",
            approvalRequestId: approvalRequest.id,
            messageId: sendResult.messageId,
            fastPath: true,
            confirmedBy: "user",
          };
        } else {
          // Cancelled OR timed out — fall through to manual approval path
          const reason = confirmation ? "cancelled" : "timeout";
          log.info(`Fast-path not sent (${reason}), falling through to manual approval`);
          // Continue to manual approval path below
        }
      } else {
        // skip_confirmation = true — send immediately without preview
        const sendResult = await step.invoke("fast-path-send-email", {
          function: sendEmail,
          data: {
            to: parsedRequest.recipientEmail,
            subject: draft.subject,
            body: draft.body,
            userId,
          },
        });

        await step.run("update-fast-path-status", async () => {
          const supabase = getSupabaseAdmin();
          await supabase
            .from("email_approval_requests")
            .update({
              status: "auto_approved",
              sent_at: new Date().toISOString(),
              gmail_message_id: sendResult.messageId,
            })
            .eq("id", approvalRequest.id);
        });

        // FYI notification
        await step.run("notify-fast-path-sent", async () => {
          if (!slackContext?.botToken || !slackContext?.channelId) return { sent: false };
          await fetch("https://slack.com/api/chat.postMessage", {
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              Authorization: `Bearer ${slackContext.botToken}`,
            },
            body: JSON.stringify({
              channel: slackContext.channelId,
              thread_ts: slackContext.threadTs,
              text: `Auto-sent routine email to ${parsedRequest.recipientEmail}`,
              blocks: [
                {
                  type: "context",
                  elements: [
                    {
                      type: "mrkdwn",
                      text: `*Auto-sent* to *${parsedRequest.recipientEmail}* — routine email (${fastPathEval.reason})`,
                    },
                  ],
                },
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `*Subject:* ${draft.subject}\n\`\`\`${draft.body}\`\`\``,
                  },
                },
              ],
            }),
          });
          return { sent: true };
        });

        log.info(`Fast-path sent to ${parsedRequest.recipientEmail} [unapproved]`);
        return {
          status: "auto_approved",
          approvalRequestId: approvalRequest.id,
          messageId: sendResult.messageId,
          fastPath: true,
          confirmedBy: "skip_confirmation",
        };
      }
    }

    // ── Manual approval path (existing behavior) ─────────────────────────
    // Step 6: Send to Slack for approval
    await step.run("send-slack-approval", async () => {
      if (!slackContext?.botToken || !slackContext?.channelId) {
        log.info("No Slack context provided, skipping notification");
        return { sent: false };
      }

      const preview = draft.body.length > 300 ? draft.body.substring(0, 300) + "..." : draft.body;

      const slackResponse = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${slackContext.botToken}`,
        },
        body: JSON.stringify({
          channel: slackContext.channelId,
          thread_ts: slackContext.threadTs,
          text: `Email draft ready for approval`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*Email Draft*\n\n*To:* ${parsedRequest.recipientEmail || "Unknown"}\n*Subject:* ${draft.subject}\n\n\`\`\`${preview}\`\`\``,
              },
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "Send" },
                  style: "primary",
                  value: approvalRequest.id,
                  action_id: "approve_email",
                },
                {
                  type: "button",
                  text: { type: "plain_text", text: "Cancel" },
                  style: "danger",
                  value: approvalRequest.id,
                  action_id: "reject_email",
                },
              ],
            },
          ],
        }),
      });

      const slackResult = await slackResponse.json();

      if (!slackResult.ok) {
        log.error({ err: slackResult.error }, "Slack API error");
        return { sent: false, error: slackResult.error };
      }

      return { sent: true, messageTs: slackResult.ts };
    });

    // Step 6: Wait for approval
    const approval = await step.waitForEvent("wait-for-slack-approval", {
      event: "email/approval-response",
      timeout: "7d",
      if: `async.data.draftId == '${approvalRequest.id}'`,
    });

    // Handle timeout - waitForEvent returns null when timeout expires
    if (!approval) {
      await step.run("mark-expired", async () => {
        const supabase = getSupabaseAdmin();
        await supabase
          .from("email_approval_requests")
          .update({
            status: "expired",
            expired_at: new Date().toISOString(),
          })
          .eq("id", approvalRequest.id);
      });

      return {
        status: "expired",
        approvalRequestId: approvalRequest.id,
      };
    }

    // Step 7: Handle approval
    if (approval.data.action === "approve") {
      // Send email via Inngest send-email function
      const sendResult = await step.invoke("send-email", {
        function: sendEmail,
        data: {
          to: parsedRequest.recipientEmail,
          subject: draft.subject,
          body: draft.body,
          userId,
        },
      });

      // Update approval request status
      await step.run("update-approval-status", async () => {
        const supabase = getSupabaseAdmin();

        await supabase
          .from("email_approval_requests")
          .update({
            status: "sent",
            sent_at: new Date().toISOString(),
            gmail_message_id: sendResult.messageId,
          })
          .eq("id", approvalRequest.id);
      });

      return {
        status: "sent",
        approvalRequestId: approvalRequest.id,
        messageId: sendResult.messageId,
      };
    } else {
      await step.run("mark-rejected", async () => {
        const supabase = getSupabaseAdmin();

        await supabase
          .from("email_approval_requests")
          .update({
            status: "rejected",
            rejected_at: new Date().toISOString(),
          })
          .eq("id", approvalRequest.id);
      });

      return {
        status: "rejected",
        approvalRequestId: approvalRequest.id,
      };
    }
  }
);
