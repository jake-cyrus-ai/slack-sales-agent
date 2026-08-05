/**
 * Slack Interactive Component Handler
 *
 * Thin dispatcher that resolves context (workspace, token, user mapping)
 * and delegates to domain-specific action handlers via the action registry.
 *
 * Action handlers are registered in server/inngest/functions/interactions/:
 *   - meeting-actions.ts  (meeting_*)
 *   - deal-actions.ts     (deal_*)
 *   - email-actions.ts    (email_*)
 *   - legal-actions.ts    (legal_*)
 *
 * Event: slack/interaction
 * Triggered by: Slack interactive components via /api/webhooks/slack
 */

import { inngest } from "../../client";
import { getSupabaseAdmin } from "../../utils/supabase";
import { trackUsageEvent } from "../../../src/lib/usage-tracking";
import { startWorkflowRun } from "../../../src/lib/workflow-tracking";
import { dispatchAction, hasHandler } from "../../utils/action-registry";
import { writeFeedbackEvent } from "../../utils/feedback-capture";
import "../interactions";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "slack-interaction" });

/**
 * Helper: Update Slack message
 */
async function updateSlackMessage(
  botToken: string,
  channel: string,
  ts: string,
  text: string
): Promise<void> {
  await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel, ts, text }),
  });
}

/**
 * Helper: Update Slack message with blocks
 */
async function updateSlackMessageWithBlocks(
  botToken: string,
  channel: string,
  ts: string,
  blocks: any[]
): Promise<void> {
  await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({
      channel,
      ts,
      text: "Email action completed",
      blocks,
    }),
  });
}

/**
 * Helper: Check org-level permissions for a user.
 *
 * Looks up the user's role in organization_users (synced from Clerk via
 * webhooks). Returns the role string or null if the user is not a member.
 */
async function checkOrgPermission(
  userId: string,
  organizationId: string,
): Promise<string | null> {
  const { getSupabaseAdmin } = await import("../../utils/supabase");
  const supabase = getSupabaseAdmin();
  const { data: orgUser, error } = await supabase
    .from("organization_users")
    .select("role")
    .eq("user_id", userId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) {
    log.error({ err: error }, "Error checking org permission");
    return null;
  }

  return orgUser?.role ?? null;
}

/**
 * Handle edit email modal submission — user edited a draft and submitted.
 * Updates the draft, records edit_history, writes feedback event, and
 * posts the updated draft back to the thread.
 */
async function handleEditEmailModal(payload: any, step: any) {
  const supabase = getSupabaseAdmin();

  // Extract data from modal submission
  const values = payload.view?.state?.values || {};
  const privateMetadata = JSON.parse(payload.view?.private_metadata || "{}");
  const { draftId, channelId, messageTs, botToken } = privateMetadata;
  const slackUserId = payload.user?.id;

  // Get edited values from the modal inputs
  const editedSubject = values.subject_block?.subject_input?.value || "";
  const editedBody = values.body_block?.body_input?.value || "";

  if (!draftId) {
    log.error("edit_email_modal: missing draftId in private_metadata");
    return { status: "error", reason: "missing_draft_id" };
  }

  // Load original draft
  const original = await step.run("load-original-draft", async () => {
    const { data } = await supabase
      .from("email_auto_response_drafts")
      .select("subject, body, to_email, user_id, organization_id, classification, confidence_score, edit_history")
      .eq("id", draftId)
      .maybeSingle();
    return data;
  });

  if (!original) {
    return { status: "error", reason: "draft_not_found" };
  }

  // Update draft with edited content + append to edit_history
  await step.run("update-draft-with-edit", async () => {
    const existingHistory = Array.isArray(original.edit_history) ? original.edit_history : [];
    const editEntry = {
      timestamp: new Date().toISOString(),
      before: { subject: original.subject, body: original.body },
      after: { subject: editedSubject, body: editedBody },
      edited_by: slackUserId,
    };

    await supabase
      .from("email_auto_response_drafts")
      .update({
        subject: editedSubject,
        body: editedBody,
        edit_history: [...existingHistory, editEntry],
        edit_count: existingHistory.length + 1,
      })
      .eq("id", draftId);
  });

  // Write feedback event with the edit delta
  if (original.organization_id && original.user_id) {
    writeFeedbackEvent({
      userId: original.user_id,
      organizationId: original.organization_id,
      domain: "email_draft",
      signalType: "edit",
      agentOutput: { subject: original.subject, body: (original.body || "").slice(0, 1500), to: original.to_email },
      userAction: { subject: editedSubject, body: editedBody.slice(0, 1500) },
      delta: {
        subjectChanged: original.subject !== editedSubject,
        bodyChanged: original.body !== editedBody,
      },
      context: { classification: original.classification, confidence: original.confidence_score, recipient: original.to_email },
      sourceRef: { table: "email_auto_response_drafts", id: draftId },
    });
  }

  // Post updated draft back to the thread for approval
  if (botToken && channelId) {
    await step.run("post-updated-draft", async () => {
      const bodyPreview = editedBody.length > 300 ? editedBody.slice(0, 300) + "..." : editedBody;
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify({
          channel: channelId,
          thread_ts: messageTs,
          text: `Draft updated by <@${slackUserId}>`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*Draft updated* by <@${slackUserId}>\n\n*To:* ${original.to_email}\n*Subject:* ${editedSubject}\n\n\`\`\`${bodyPreview}\`\`\``,
              },
            },
            {
              type: "context",
              elements: [
                { type: "mrkdwn", text: `Reply *"approved"* to send or *"cancel"* to discard.` },
              ],
            },
          ],
        }),
      });
    });
  }

  log.info({ draftId, slackUserId }, "Email draft edited");
  return { status: "edited", draftId };
}

/**
 * Main Inngest function: Handle Slack interactive components
 */
export const handleSlackInteraction = inngest.createFunction(
  {
    id: "handle-slack-interaction",
    retries: 2,
  },
  { event: "slack/interaction" },
  async ({ event, step }) => {
    // Parse the payload
    const payload =
      typeof event.data.payload === "string"
        ? JSON.parse(event.data.payload)
        : event.data.payload;

    log.info({ type: payload.type, action_id: payload.actions?.[0]?.action_id, user: payload.user?.id }, "Processing interaction");

    // Handle modal submissions (e.g., edit email draft)
    if (payload.type === "view_submission") {
      const callbackId = payload.view?.callback_id;
      if (callbackId === "edit_email_modal") {
        return await handleEditEmailModal(payload, step);
      }
      log.info({ callbackId }, "Skipping unknown modal");
      return { status: "skipped", reason: "unknown_modal" };
    }

    // Only handle block_actions beyond this point
    if (payload.type !== "block_actions") {
      log.info({ type: payload.type }, "Skipping unsupported payload type");
      return { status: "skipped", reason: "unsupported_type" };
    }

    const action = payload.actions?.[0];
    if (!action) {
      return { status: "skipped", reason: "no_actions" };
    }

    const actionId = action.action_id;
    const slackUserId = payload.user?.id;
    const channelId = payload.channel?.id;
    const messageTs = payload.message?.ts;
    const teamId = payload.team?.id;

    // Slack also fires block_actions for URL buttons (which carry no action_id)
    // and for any interactive component this app doesn't own. Bail before doing
    // workspace/user lookups — otherwise a missing user mapping from one of
    // those clicks ends up overwriting the source message via chat.update
    // (e.g. the prospect-context dossier post had its body replaced with
    // "User not found…" when sellers clicked the "Open in Attio" URL button).
    const isLegacyEmailAction = actionId === "email_approve" || actionId === "email_reject";
    if (!actionId || (!hasHandler(actionId) && !isLegacyEmailAction)) {
      log.info({ actionId }, "No registered handler for action; skipping");
      return { status: "skipped", reason: "no_handler", actionId: actionId ?? null };
    }

    // Step 1: Get workspace + decrypted bot token
    const workspaceResult = await step.run("get-workspace-and-token", async () => {
      const { getWorkspaceWithToken } = await import("../../utils/slack-helpers");
      return getWorkspaceWithToken(teamId);
    });

    if (!workspaceResult) {
      return { status: "error", reason: "workspace_not_found" };
    }

    const botToken = workspaceResult.botToken;

    // Step 2: Get user mapping with cached 3-tier org resolution
    const resolvedMapping = await step.run("get-user-mapping", async () => {
      const { resolveSlackUserMapping } = await import("../../utils/tenant-resolver");
      return resolveSlackUserMapping(slackUserId, workspaceResult.id);
    });

    if (!resolvedMapping) {
      await updateSlackMessage(
        botToken,
        channelId,
        messageTs,
        "User not found. Please sign up at https://your-app.example.com and link your account.",
      );
      return { status: "error", reason: "user_not_found" };
    }

    const userMapping = {
      agent_user_id: resolvedMapping.agentUserId,
      organization_id: resolvedMapping.organizationId ?? "",
    };

    // Step 3: Verify org-level permissions (non-blocking during migration)
    if (userMapping.organization_id) {
      const orgRole = await step.run("check-org-permission", async () => {
        return checkOrgPermission(userMapping.agent_user_id, userMapping.organization_id);
      });

      if (!orgRole) {
        log.warn({ userId: userMapping.agent_user_id, orgId: userMapping.organization_id }, "User not a member of the mapped organization");
      }
    }

    // Step 4: Handle legacy email approve/reject buttons gracefully
    // These button action IDs were removed but existing Slack messages may still have them.
    if (actionId === "email_approve" || actionId === "email_reject") {
      log.info({ actionId }, "Legacy email action received");
      await step.run("handle-legacy-email-action", async () => {
        await updateSlackMessageWithBlocks(botToken, channelId, messageTs, [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `This email action is no longer available via buttons. Please reply *"approved"* to send or *"cancel"* to discard the draft in the thread instead.`,
            },
          },
        ]);
      });
      return { status: "legacy_action", actionId };
    }

    // Step 5: Dispatch to registered action handlers (deal_, meeting_, calendar_, legal_)
    const actionResult = await dispatchAction(actionId, {
      actionId,
      actionValue: action.value,
      botToken,
      channelId,
      messageTs,
      slackUserId,
      triggerId: payload.trigger_id,
      userMapping,
      step,
    });

    if (actionResult) {
      return actionResult;
    }

    return { status: "unknown_action", actionId };
  },
);
