/**
 * Email Ingestion — Reusable utility that extracts the common setup steps
 * (org resolution, feature flag check, email fetch + idempotency, Slack
 * workspace resolution, and thread history building) from the autonomous
 * email agent into a single composable function.
 *
 * Usage:
 *   const result = await ingestEmail(step, { userId, messageId });
 *   if (result.skipped) return { status: "skipped" };
 *   const { orgId, email, threadContext, userProfile, slackContext } = result;
 */

import { NonRetriableError } from "inngest";
import { getSupabaseAdmin, getSupabaseForUser } from "./supabase";
import { logger } from "../../lib/logger";

const log = logger.child({ util: "email-ingestion" });
import { isAutonomousModeEnabled } from "./feature-flags";
import { resolveOrgForUser } from "./tenant-resolver";
import { buildThreadContext, type ThreadContext, type ConversationStage } from "./email-thread-context";
import { SlackProgress } from "./slack-progress";

// =============================================================================
// Types
// =============================================================================

export interface IngestEmailParams {
  userId: string;
  messageId: string;
  /** If already known, skip the org-resolution query. */
  organizationId?: string;
  /**
   * When true (default), verifies the org-level `autonomous_mode` flag
   * is enabled. Set to false for non-autonomous callers that still want the
   * shared ingestion logic.
   */
  requireAutonomousFlag?: boolean;
}

/** The incoming_emails row, typed loosely to match `select("*")`. */
export interface IncomingEmail {
  id: string;
  user_id: string;
  organization_id: string | null;
  from_email: string;
  from_name: string | null;
  from_domain: string | null;
  subject: string;
  body_text: string | null;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  status: string;
  received_at: string;
  processed_at: string | null;
  [key: string]: any; // allow extra columns without breaking
}

export interface SlackContext {
  initialized: boolean;
  botToken: string | null;
  channel: string | null;
  messageTs: string | null;
  progress: SlackProgress | null;
}

export interface UserProfile {
  userName: string | null;
  userEmail: string | null;
  userCompany: string | null;
  timezone: string | null;
}

export type IngestEmailResult =
  | { skipped: true; reason: string }
  | {
      skipped: false;
      orgId: string;
      email: IncomingEmail;
      threadContext: ThreadContext;
      userProfile: UserProfile;
      slackContext: SlackContext;
    };

// =============================================================================
// Main ingestEmail function
// =============================================================================

/**
 * Run the common email-ingestion pipeline (steps 1-5 of the autonomous agent).
 *
 * Each sub-step is wrapped in `step.run()` for Inngest observability.
 *
 * @returns Either `{ skipped: true, reason }` when the email was already
 *          processed, or a full context object for downstream steps.
 */
export async function ingestEmail(
  step: {
    run: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
  },
  params: IngestEmailParams,
): Promise<IngestEmailResult> {
  const {
    userId,
    messageId,
    organizationId,
    requireAutonomousFlag = true,
  } = params;

  // ===========================================================================
  // Step 1: Get organization (multi-tenant)
  // ===========================================================================
  const actualOrgId = await step.run("get-organization", async () => {
    if (organizationId) return organizationId;
    return resolveOrgForUser(userId);
  });

  if (!actualOrgId) {
    throw new NonRetriableError("No organization found for user");
  }

  // ===========================================================================
  // Step 2: Verify autonomous enabled (defense in depth)
  // ===========================================================================
  if (requireAutonomousFlag) {
    await step.run("verify-autonomous-enabled", async () => {
      if (!(await isAutonomousModeEnabled(actualOrgId))) {
        throw new NonRetriableError("Autonomous mode not enabled for organization");
      }
    });
  }

  // ===========================================================================
  // Step 3: Fetch incoming email (load + idempotency guard + status marking)
  // ===========================================================================
  const incomingEmail = await step.run("fetch-incoming-email", async () => {
    const supabase = getSupabaseForUser(userId); // RLS-enforced; user-owned emails + drafts

    const { data, error } = await supabase
      .from("incoming_emails")
      .select("*")
      .eq("gmail_message_id", messageId)
      .single();

    if (error || !data) {
      throw new Error(`Email not found: ${messageId}`);
    }

    // Multi-tenant ownership check
    if (actualOrgId && data.organization_id && data.organization_id !== actualOrgId) {
      throw new NonRetriableError("Unauthorized: Email does not belong to organization");
    }

    // Idempotency guard — skip if already processed
    if (data.status !== "pending" && data.status !== "processing") {
      return { skipped: true as const, status: data.status, email: data };
    }

    // Check if a draft was already sent (covers retry after send succeeded but status update failed)
    const { data: existingDraft } = await supabase
      .from("email_auto_response_drafts")
      .select("id, status, gmail_message_id")
      .eq("incoming_email_id", data.id)
      .eq("send_mode", "autonomous")
      .maybeSingle();

    if (existingDraft?.gmail_message_id) {
      await supabase.from("incoming_emails").update({ status: "auto_sent" }).eq("id", data.id);
      return { skipped: true as const, status: "already_sent", email: data };
    }

    // Mark as processing
    await supabase
      .from("incoming_emails")
      .update({ status: "processing", processed_at: new Date().toISOString() })
      .eq("id", data.id);

    return { skipped: false as const, email: data };
  });

  if (incomingEmail.skipped) {
    return { skipped: true, reason: `Email already processed (${incomingEmail.status})` };
  }

  const email = incomingEmail.email as IncomingEmail;

  // ===========================================================================
  // Step 4: Init Slack progress (workspace + DM channel resolution)
  // ===========================================================================
  const slackContext = await step.run("init-slack-progress", async () => {
    const supabase = getSupabaseAdmin();

    // Find the Slack workspace for this org (pick the one with a user mapping if possible)
    const { data: workspaces } = await supabase
      .from("slack_workspaces")
      .select("id, bot_token")
      .eq("organization_id", actualOrgId)
      .eq("is_active", true)
      .order("updated_at", { ascending: false });

    // Prefer the workspace that has a mapping for this user
    let workspace = workspaces?.[0] || null;
    if (workspaces && workspaces.length > 1) {
      const { data: mapping } = await supabase
        .from("slack_user_mappings")
        .select("slack_workspace_id")
        .eq("agent_user_id", userId)
        .eq("is_active", true)
        .in("slack_workspace_id", workspaces.map(w => w.id))
        .maybeSingle();
      if (mapping) {
        workspace = workspaces.find(w => w.id === mapping.slack_workspace_id) || workspace;
      }
    }

    if (!workspace?.bot_token) {
      return {
        initialized: false,
        reason: "no_slack_workspace",
        botToken: null,
        channel: null,
        messageTs: null,
      };
    }

    const { decryptBotToken } = await import("./slack-helpers");
    const botToken = await decryptBotToken(workspace.bot_token);

    // Find the user's Slack ID to DM them
    const { data: mapping } = await supabase
      .from("slack_user_mappings")
      .select("slack_user_id")
      .eq("agent_user_id", userId)
      .eq("slack_workspace_id", workspace.id)
      .eq("is_active", true)
      .maybeSingle();

    if (!mapping?.slack_user_id) {
      return {
        initialized: false,
        reason: "no_slack_user_mapping",
        botToken: null,
        channel: null,
        messageTs: null,
      };
    }

    // Open a DM channel with the user
    const dmResp = await fetch("https://slack.com/api/conversations.open", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({ users: mapping.slack_user_id }),
    });
    const dmData = (await dmResp.json()) as any;
    if (!dmData.ok) {
      log.warn({ err: dmData.error }, "Failed to open Slack DM");
      return {
        initialized: false,
        reason: "dm_open_failed",
        botToken: null,
        channel: null,
        messageTs: null,
      };
    }

    const channel = dmData.channel.id;

    // Create progress instance and send initial message
    const progress = new SlackProgress(botToken, channel);
    const senderDisplay = email.from_name
      ? `${email.from_name} (${email.from_email})`
      : email.from_email;
    const result = await progress.start(`Processing email from ${senderDisplay}`);

    return {
      initialized: true,
      botToken,
      channel,
      messageTs: result.ts || null,
    };
  });

  // Reconstruct a SlackProgress instance outside step.run for callers
  // (SlackProgress is not serializable so we recreate it from the tokens)
  let progressInstance: SlackProgress | null = null;
  if (slackContext.initialized && slackContext.botToken && slackContext.channel) {
    progressInstance = new SlackProgress(slackContext.botToken, slackContext.channel);
    // Manually set the messageTs so subsequent .check() calls update the right message.
    // SlackProgress stores this privately, but we can work around it by calling
    // the underlying updateSlackMessage directly from the caller instead.
    // For convenience, expose the raw tokens + ts so callers can choose either path.
  }

  const resolvedSlackContext: SlackContext = {
    initialized: slackContext.initialized,
    botToken: slackContext.botToken,
    channel: slackContext.channel,
    messageTs: slackContext.messageTs,
    progress: progressInstance,
  };

  // ===========================================================================
  // Step 5: Load thread history (full conversation context)
  // ===========================================================================
  const threadContext: ThreadContext = await step.run("load-thread-history", async () => {
    if (!email.gmail_thread_id) {
      return {
        threadId: "",
        messages: [],
        messageCount: 1,
        ourReplyCount: 0,
        theirReplyCount: 1,
        lastOurReplyAt: null,
        lastTheirReplyAt: new Date().toISOString(),
        conversationStage: "intro" as ConversationStage,
        isFirstInteraction: true,
        threadSummary: "",
      };
    }

    return buildThreadContext(userId, email.gmail_thread_id, actualOrgId);
  });

  // ===========================================================================
  // Bonus: Fetch user profile (needed by nearly every downstream consumer)
  // ===========================================================================
  const userProfile: UserProfile = await step.run("fetch-user-profile", async () => {
    const supabase = getSupabaseAdmin();

    const { data: profile } = await supabase
      .from("profiles")
      .select("first_name, last_name, email, timezone")
      .eq("user_id", userId)
      .maybeSingle();

    if (!profile) {
      return { userName: null, userEmail: null, userCompany: null, timezone: null };
    }

    // Resolve company name from org
    let companyName: string | null = null;
    const { data: org } = await supabase
      .from("organizations")
      .select("name")
      .eq("id", actualOrgId)
      .maybeSingle();

    if (org?.name) {
      companyName = org.name;
    }

    const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(" ") || null;

    return {
      userName: fullName,
      userEmail: profile.email || null,
      userCompany: companyName,
      timezone: profile.timezone || null,
    };
  });

  return {
    skipped: false,
    orgId: actualOrgId,
    email,
    threadContext,
    userProfile,
    slackContext: resolvedSlackContext,
  };
}
