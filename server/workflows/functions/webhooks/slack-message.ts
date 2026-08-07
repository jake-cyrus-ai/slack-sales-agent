/**
 * Slack Message Event Handler
 * 
 * Handles incoming Slack events including:
 * - App mentions (@Sales Agent)
 * - Direct messages
 * - Channel messages
 * 
 * This function:
 * 1. Links Slack user to Sales Agent account
 * 2. Determines intent (meeting prep, doc search, chat, etc.)
 * 3. Routes to appropriate agent function
 * 
 * Event: slack/message
 * Triggered by: Slack message events via /api/webhooks/slack
 */

import { workflow } from "../../client";
import { getSupabaseAdmin } from "../../utils/supabase";
import { getWorkspaceByTeamId, getWorkspaceWithToken, decryptBotToken, sendSlackMessage, sendSlackBlockMessage, updateSlackMessage, deleteSlackMessage, fetchSlackThread } from "../../utils/slack-helpers";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "slack-message" });
import { detectDocumentShareRequest, shareDocumentInWorkflow } from "./document-share";
import { detectEmailShareRequest, sendDocumentViaEmail } from "../../../src/slack/email-share";
import { runSupervisor } from "../../../src/agent/supervisor";
import { buildPreferenceInstructions } from "../../../src/agent/system-prompt";
import { formatMessageForSlack, buildConnectBlock } from "../../../src/slack/formatter";
import { getConnectUrl } from "../../../src/skills/connect-url";
import { trackUsageEvent } from "../../../src/lib/usage-tracking";
import { writeFeedbackEvent } from "../../utils/feedback-capture";
import { writeErrorEvent, markErrorsResolved, classifyError, toRequestId } from "../../utils/slack-error-reporter";
import { runBackupLLM, buildApologyMessage } from "../../utils/backup-response";
import { checkUserIntegrations } from "../../../src/services/integration-check";
import { sendEmail } from "../email/send-email";

/** Escape mrkdwn special characters in user-provided text for safe Slack interpolation. */
function escapeMrkdwn(text: string): string {
  return text.replace(/[&<>]/g, (ch) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
    return map[ch] || ch;
  });
}

// ─── User mapping cache (5-min TTL, follows tenant-context.ts pattern) ──────

const USER_MAPPING_CACHE_TTL_MS = 5 * 60 * 1000;

type UserMappingCacheEntry = {
  expiresAt: number;
  value: { userId: string; organizationId: string | null };
};

const userMappingCache = new Map<string, UserMappingCacheEntry>();

/**
 * Helper: Link Slack user to Sales Agent account.
 *
 * POST-MIGRATION: Returns the Supabase Auth user ID (TEXT) and organization context
 * from the slack_user_mappings table. The agent_user_id stored in the mapping
 * is now the Supabase Auth user ID directly.
 *
 * Results are cached for 5 minutes (direct lookups only, not auto-link).
 */
async function linkSlackUserToAgent(
  supabase: any,
  slackUserId: string,
  slackWorkspaceId: string,
  botToken?: string
): Promise<{ userId: string | null; organizationId: string | null; error?: string }> {
  // Check cache first (only stores successful direct lookups)
  const cacheKey = `${slackUserId}:${slackWorkspaceId}`;
  const now = Date.now();
  const cached = userMappingCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { userId: cached.value.userId, organizationId: cached.value.organizationId };
  }

  // Find user mapping — include organization_id for org-scoped permission checks
  // Look up by workspace ID first, then fall back to any workspace with the same team_id
  // so mappings work across staging/dev Slack apps sharing the same workspace.
  const { data: initialMapping, error } = await supabase
    .from("slack_user_mappings")
    .select("agent_user_id, organization_id")
    .eq("slack_user_id", slackUserId)
    .eq("slack_workspace_id", slackWorkspaceId)
    .eq("is_active", true)
    .maybeSingle();
  let mapping = initialMapping;

  // Fallback: find mapping via any workspace row for the same team_id
  if (!mapping && !error) {
    const { data: workspace } = await supabase
      .from("slack_workspaces")
      .select("team_id")
      .eq("id", slackWorkspaceId)
      .single();

    if (workspace?.team_id) {
      const { data: siblingWorkspaces } = await supabase
        .from("slack_workspaces")
        .select("id")
        .eq("team_id", workspace.team_id)
        .neq("id", slackWorkspaceId);

      for (const sibling of siblingWorkspaces || []) {
        const { data: siblingMapping } = await supabase
          .from("slack_user_mappings")
          .select("agent_user_id, organization_id")
          .eq("slack_user_id", slackUserId)
          .eq("slack_workspace_id", sibling.id)
          .eq("is_active", true)
          .maybeSingle();

        if (siblingMapping) {
          mapping = siblingMapping;
          log.info({ workspaceId: sibling.id }, "Resolved user mapping from sibling workspace");
          break;
        }
      }
    }
  }

  if (error) {
    log.error({ err: error }, "Error fetching user mapping");
    return { userId: null, organizationId: null, error: error.message };
  }

  if (!mapping && botToken) {
    // Auto-link: resolve Slack email → match to profiles → create mapping
    log.info({ slackUserId }, "No mapping found, attempting auto-link");
    try {
      const slackUrl = new URL("https://slack.com/api/users.info");
      slackUrl.searchParams.set("user", slackUserId);
      const slackResp = await fetch(slackUrl.toString(), {
        headers: { Authorization: `Bearer ${botToken}` },
      });
      const slackData = await slackResp.json();

      if (!slackData.ok) {
        log.warn({ error: slackData.error, slackUserId }, "users.info error");
      }

      const slackEmail = slackData.user?.profile?.email;

      if (slackEmail) {
        // Find a Sales Agent profile with this email
        const { data: profile } = await supabase
          .from("profiles")
          .select("user_id")
          .eq("email", slackEmail.toLowerCase())
          .maybeSingle();

        if (profile?.user_id) {
          // Fetch workspace org once (reused for both fallback and verification)
          const { data: workspace } = await supabase
            .from("slack_workspaces")
            .select("organization_id")
            .eq("id", slackWorkspaceId)
            .single();
          const workspaceOrgId = workspace?.organization_id;

          // Resolve org: organization_users → workspace
          const { data: orgUser } = await supabase
            .from("organization_users")
            .select("organization_id")
            .eq("user_id", profile.user_id)
            .order("joined_at", { ascending: true })
            .limit(1)
            .maybeSingle();
          let orgId = orgUser?.organization_id;
          if (!orgId) {
            orgId = workspaceOrgId;
          }

          // Verify the user belongs to the same org as the workspace
          if (orgId && workspaceOrgId && workspaceOrgId !== orgId) {
            log.warn({ userOrg: orgId, workspaceOrg: workspaceOrgId }, "Auto-link org mismatch");
            return { userId: null, organizationId: null, error: "Org mismatch" };
          }

          // Guard: don't create mapping without an org
          if (!orgId) {
            log.warn({ userId: profile.user_id }, "Auto-link failed: could not resolve org for user");
            return { userId: null, organizationId: null, error: "Could not resolve organization" };
          }

          // Create the mapping for future lookups (select-then-insert to avoid PostgREST schema cache issues)
          const { data: existingMapping } = await supabase
            .from("slack_user_mappings")
            .select("id")
            .eq("slack_workspace_id", slackWorkspaceId)
            .eq("slack_user_id", slackUserId)
            .maybeSingle();

          if (existingMapping) {
            await supabase.from("slack_user_mappings")
              .update({
                agent_user_id: profile.user_id,
                organization_id: orgId,
                slack_email: slackEmail,
                is_active: true,
                last_active_at: new Date().toISOString(),
              })
              .eq("id", existingMapping.id);
            log.info({ slackUserId }, "Updated existing slack_user_mapping");
          } else {
            const { error: insertError } = await supabase.from("slack_user_mappings").insert({
              slack_user_id: slackUserId,
              slack_workspace_id: slackWorkspaceId,
              slack_email: slackEmail,
              agent_user_id: profile.user_id,
              organization_id: orgId,
              is_active: true,
              linked_at: new Date().toISOString(),
              last_active_at: new Date().toISOString(),
              metadata: { linked_via: "auto_link_first_message" },
            });
            if (insertError) {
              log.error({ err: insertError }, "Failed to insert slack_user_mapping");
            } else {
              log.info({ slackUserId, agentUserId: profile.user_id }, "Auto-linked Slack user");
            }
          }
          const autoLinked = { userId: profile.user_id, organizationId: orgId };
          // Cache auto-linked result too
          userMappingCache.set(cacheKey, {
            expiresAt: Date.now() + USER_MAPPING_CACHE_TTL_MS,
            value: { userId: autoLinked.userId, organizationId: autoLinked.organizationId },
          });
          return autoLinked;
        } else {
          log.warn({ slackEmail }, "No profile found for Slack email");
        }
      } else {
        log.warn({ slackUserId }, "Could not get email for Slack user");
      }
    } catch (err) {
      log.error({ err }, "Auto-link error");
    }
  }

  if (!mapping) {
    log.warn({ slackUserId }, "No user mapping found for Slack user");
    return { userId: null, organizationId: null, error: "User not linked" };
  }

  // If org not in mapping, fall back to the user's org from organization_users
  let organizationId = mapping.organization_id;
  if (!organizationId && mapping.agent_user_id) {
    const { data: orgUser } = await supabase
      .from("organization_users")
      .select("organization_id")
      .eq("user_id", mapping.agent_user_id)
      .order("joined_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (orgUser?.organization_id) {
      organizationId = orgUser.organization_id;
      log.info({ organizationId }, "Resolved org from organization_users");

      // Backfill slack_user_mappings so future lookups are fast
      await supabase
        .from("slack_user_mappings")
        .update({ organization_id: organizationId })
        .eq("slack_user_id", slackUserId)
        .eq("slack_workspace_id", slackWorkspaceId);
    }
  }

  const result = { userId: mapping.agent_user_id, organizationId };

  // Cache successful lookups for 5 minutes
  if (result.userId) {
    userMappingCache.set(cacheKey, {
      expiresAt: Date.now() + USER_MAPPING_CACHE_TTL_MS,
      value: { userId: result.userId, organizationId: result.organizationId },
    });
  }

  return result;
}

/**
 * Helper: Check org-level permissions for a user.
 *
 * POST-MIGRATION: Looks up the user's role in organization_users using Supabase Auth user IDs.
 * The organization_users table is validated through Supabase Auth and tenant memberships, and user_id is
 * now the Supabase Auth user ID directly (TEXT).
 */
async function checkOrgPermission(
  supabase: any,
  userId: string,
  organizationId: string
): Promise<string | null> {
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
 * Helper: Classify message intent.
 * Returns domainSignals (score map) for the chat agent — these are soft hints
 * fed to the LLM classifier, not hard routing decisions.
 */
/**
 * Detect "send it" / "cancel it" style commands for pending email drafts.
 */
function detectEmailAction(text: string): { action: "approve" | "reject" } | null {
  const t = text.toLowerCase().trim();
  if (/^(send\s*(it|that|the\s*email)?|yes\s*send\s*(it)?|go\s*ahead|fire\s*it\s*off|approved?)[\s!.]*$/i.test(t)) {
    return { action: "approve" };
  }
  if (/^(cancel\s*(it|that|the\s*email)|no[,\s]+(don'?t\s*send|cancel\s*(it|that)?)|don'?t\s*send\s*(it|that|the\s*email)?|discard\s*(it|that|the\s*email)?)[\s!.]*$/i.test(t)) {
    return { action: "reject" };
  }
  return null;
}

function classifyIntent(text: string): {
  intent: "meeting-prep" | "search-docs" | "contact-management" | "chat";
  command?: string;
  domainSignals?: Record<string, number>;
} {
  const lowerText = text.toLowerCase().trim();

  if (lowerText.startsWith("/prep") || lowerText.includes("meeting prep") || lowerText.includes("prepare for meeting")) {
    return { intent: "meeting-prep", command: lowerText, domainSignals: { sales: 3 } };
  }

  if (lowerText.startsWith("/docs") || lowerText.startsWith("/search") || lowerText.includes("search documents")) {
    return { intent: "search-docs", command: lowerText, domainSignals: { knowledge: 3 } };
  }

  if (
    /(?:add|mark|save|remove|delete)\s+.*(?:customer|prospect|partner|vendor)/i.test(lowerText) ||
    /.*(?:is|as)\s+(?:a\s+)?(?:customer|prospect|partner|vendor)/i.test(lowerText)
  ) {
    return { intent: "contact-management", command: lowerText, domainSignals: { sales: 3 } };
  }

  const salesPatterns = [
    /\b(?:deal|pipeline|prospect|follow[- ]?up|proposal)\b/i,
    /\b(?:email|gmail|inbox|reply|respond)\b/i,
    /\b(?:calendar|schedule|meeting)\b/i,
    /\bwhat(?:'s| is) (?:the )?(?:latest|status|update) (?:with|on|from)\b/i,
  ];
  const knowledgePatterns = [
    /\b(?:pricing|price|cost|soc\s*2|security|compliance)\b/i,
    /\b(?:playbook|process|objection|competitor)\b/i,
    /\b(?:doc|document|knowledge\s*base|kb)\b/i,
    /\b(?:how do we|what(?:'s| is) our|do we have)\b/i,
  ];
  const researchPatterns = [
    /\b(?:research|look\s*up|find (?:info|information|out)|who is|tell me about)\b/i,
    /\b(?:linkedin|background|funding|news)\b/i,
  ];

  const domainSignals: Record<string, number> = {
    sales: salesPatterns.filter((p) => p.test(lowerText)).length,
    knowledge: knowledgePatterns.filter((p) => p.test(lowerText)).length,
    research: researchPatterns.filter((p) => p.test(lowerText)).length,
  };

  const hasSignals = Object.values(domainSignals).some((v) => v > 0);
  return { intent: "chat", domainSignals: hasSignals ? domainSignals : undefined };
}

// ─── Types for step.run return values (Vercel Workflow returns unknown) ─────────────

interface ResolvedContext {
  botToken: string;
  workspaceId: string;
  agentUserId: string | null;
  organizationId: string | null;
  emailAction: ReturnType<typeof detectEmailAction>;
  emailShare: ReturnType<typeof detectEmailShareRequest>;
  docShare: ReturnType<typeof detectDocumentShareRequest>;
  classification: ReturnType<typeof classifyIntent>;
  userTimezone: string | null;
  thinkingTs: string | null;
}

interface ChatContext {
  profile: { first_name: string | null; last_name: string | null; email: string | null; company: string | null; timezone: string | null } | null;
  conversationId: string;
  conversationHistory: Array<Record<string, string>>;
  userPreferences: string | null;
}

/**
 * Recovery flow — invoked from any catch block in the chat path. Runs the
 * Tier A backup LLM fallback, updates the thinking message with the result
 * (or a Tier B apology), and writes an error event for developers.
 *
 * NEVER throws — the caller rethrows the original error after this returns,
 * so Vercel Workflow can still retry the function. If a later retry succeeds, the
 * user sees the real response overwriting whatever this flow posted.
 */
async function runRecoveryFlow(params: {
  error: unknown;
  step: string;
  ctx: ResolvedContext;
  chatCtx: ChatContext | null;
  agentState: Record<string, unknown>;
  channelId: string;
  threadTs: string;
  text: string;
  teamId: string;
  slackUserId: string;
  runId: string | null;
  attempt: number | null;
  rawEvent: Record<string, unknown>;
}): Promise<void> {
  let backupOutcome: "not_attempted" | "succeeded" | "failed" = "not_attempted";
  let backupResponse: string | null = null;

  try {
    const history = params.chatCtx?.conversationHistory
      ? params.chatCtx.conversationHistory.map((m) => ({
          role: String(m.role || "user"),
          content: String(m.content || ""),
        }))
      : await fetchSlackThread(params.ctx.botToken, params.channelId, params.threadTs, params.teamId).catch(() => []);

    const backup = await runBackupLLM({
      conversationHistory: history,
      currentMessage: params.text,
    });

    if (backup.success && backup.response) {
      backupOutcome = "succeeded";
      backupResponse = backup.response;
    } else {
      backupOutcome = "failed";
      // Log the backup failure as its own error row so devs can see the cascade
      await writeErrorEvent({
        organizationId: params.ctx.organizationId,
        agentUserId: params.ctx.agentUserId,
        slackUserId: params.slackUserId,
        slackTeamId: params.teamId,
        slackChannelId: params.channelId,
        slackThreadTs: params.threadTs,
        thinkingTs: params.ctx.thinkingTs,
        conversationId: params.chatCtx?.conversationId ?? null,
        workflowRunId: params.runId,
        workflowFunctionId: "handle-slack-message",
        attempt: params.attempt,
        step: "backup-flow",
        error: backup.error ?? new Error("Backup LLM returned no response"),
        userMessage: params.text,
        classifiedIntent: params.ctx.classification?.intent ?? null,
        domainSignals: params.ctx.classification?.domainSignals ?? null,
        agentState: params.agentState,
        rawEventPayload: params.rawEvent,
        backupOutcome: "failed",
        backupResponsePreview: null,
        botToken: params.ctx.botToken,
      });
    }
  } catch (err) {
    backupOutcome = "failed";
    log.error({ err }, "Backup flow threw unexpectedly");
  }

  const requestId = toRequestId(params.runId);
  const errorCategory = classifyError(params.error);
  let finalMessage = backupResponse
    ? backupResponse
    : buildApologyMessage({
        userMessage: params.text,
        requestId,
        category: errorCategory,
      });

  // If the error is integration-related and backup LLM also failed, check
  // whether the integration is actually disconnected (not just temporarily down).
  // When disconnected, replace the generic apology with a connect prompt.
  let connectBlocks: ReturnType<typeof buildConnectBlock>[] | null = null;
  if (!backupResponse && errorCategory.startsWith("integration:")) {
    try {
      const SERVICE_TO_KEY: Record<string, string> = {
        salesforce: "salesforce",
        google_calendar: "google",
        gmail: "google",
        granola: "granola",
        attio: "attio",
      };
      const SERVICE_LABELS: Record<string, string> = {
        salesforce: "Salesforce",
        google_calendar: "Google Calendar",
        gmail: "Google (Gmail & Calendar)",
        granola: "Granola",
        attio: "Attio CRM",
      };
      const serviceName = errorCategory.split(":")[1];
      const integrationKey = SERVICE_TO_KEY[serviceName];
      if (integrationKey && params.ctx.agentUserId) {
        const integrations = await checkUserIntegrations(
          params.ctx.agentUserId,
          params.ctx.organizationId,
        );
        if (!integrations[integrationKey as keyof typeof integrations]) {
          const connectUrl = getConnectUrl();
          const label = SERVICE_LABELS[serviceName] || serviceName;
          finalMessage = `I can't do that yet — ${label} isn't connected. You can set it up here: ${connectUrl}`;
          connectBlocks = [buildConnectBlock(label, connectUrl)];
        }
      }
    } catch (err) {
      log.error({ err }, "Integration check in recovery failed (non-fatal)");
    }
  }

  // Update the thinking message (or post new if none exists) so the user
  // is never left with a dangling "Thinking...". Swallow any Slack error
  // here — telemetry is more important than the last-ditch update.
  try {
    if (connectBlocks) {
      // Post with Block Kit buttons for connect CTA
      const blocks = [
        { type: "section", text: { type: "mrkdwn", text: finalMessage } },
        ...connectBlocks,
      ];
      if (params.ctx.thinkingTs) {
        await updateSlackMessage(params.ctx.botToken, params.channelId, params.ctx.thinkingTs, finalMessage, blocks);
      } else {
        await sendSlackBlockMessage(params.ctx.botToken, params.channelId, finalMessage, blocks, params.threadTs);
      }
    } else if (params.ctx.thinkingTs) {
      await updateSlackMessage(params.ctx.botToken, params.channelId, params.ctx.thinkingTs, finalMessage);
    } else {
      await sendSlackMessage(params.ctx.botToken, params.channelId, finalMessage, params.threadTs);
    }
  } catch (err) {
    log.error({ err }, "Failed to post recovery message to Slack");
  }

  // Write the primary error event
  await writeErrorEvent({
    organizationId: params.ctx.organizationId,
    agentUserId: params.ctx.agentUserId,
    slackUserId: params.slackUserId,
    slackTeamId: params.teamId,
    slackChannelId: params.channelId,
    slackThreadTs: params.threadTs,
    thinkingTs: params.ctx.thinkingTs,
    conversationId: params.chatCtx?.conversationId ?? null,
    workflowRunId: params.runId,
    workflowFunctionId: "handle-slack-message",
    attempt: params.attempt,
    step: params.step,
    error: params.error,
    userMessage: params.text,
    classifiedIntent: params.ctx.classification?.intent ?? null,
    domainSignals: params.ctx.classification?.domainSignals ?? null,
    agentState: params.agentState,
    rawEventPayload: params.rawEvent,
    backupOutcome,
    backupResponsePreview: backupResponse ? backupResponse.slice(0, 500) : null,
    botToken: params.ctx.botToken,
  });
}

/**
 * Slack Message Handler — Primary message processing pipeline.
 *
 * CONCURRENCY MODEL:
 * ──────────────────
 * Messages are serialized PER THREAD (limit: 1 concurrent per channel+thread_ts).
 * This guarantees:
 *   1. Each message sees the full conversation history including prior responses
 *   2. Only one conversation record is created per Slack thread
 *   3. Memory saves (Mem0) never race for the same thread
 *   4. Responses are ordered — no interleaving or context loss
 *
 * Messages across DIFFERENT threads process in parallel (up to global limit: 5).
 * Bump this when the Vercel Workflow plan supports higher concurrency.
 *
 * IDEMPOTENCY:
 * ────────────
 * - Function-level: keyed on event.data.ts (Slack message timestamp, globally unique)
 * - Step-level: post-and-save checks for recent assistant message before posting
 * - DB-level: slack_thread_conversations has UNIQUE constraint on (workspace, channel, thread_ts)
 *
 * SAFETY LAYERS (defense in depth):
 * ──────────────────────────────────
 * Layer 1: Vercel Workflow concurrency limit (per-thread serialization)
 * Layer 2: Vercel Workflow idempotency key (prevents re-execution of same event)
 * Layer 3: DB unique constraint (prevents duplicate thread mappings)
 * Layer 4: Upsert pattern (atomic conversation creation)
 * Layer 5: Step-level dedup (prevents double-posting on retry)
 */
export const handleSlackMessage = workflow.createFunction(
  {
    id: "handle-slack-message",
    retries: 2,
    idempotency: "event.data.ts",
    concurrency: [
      {
        // Serialize messages within the same Slack thread.
        // thread_ts is set for replies; for thread-parent messages, fall back to ts.
        // This prevents race conditions: duplicate conversations, incomplete history,
        // conflicting responses, and concurrent memory saves.
        limit: 1,
        key: "event.data.channel + '-' + (event.data.thread_ts || event.data.ts)",
      },
      {
        // Global cap — prevents system overload from concurrent LLM calls.
        // Each supervisor call takes 3-15s and uses significant memory.
        limit: 5,
      },
    ],
  },
  { event: "slack/message" },
  async ({ event, step, runId, attempt }) => {
        const messageData = event.data;

    log.info({ type: messageData.type, user: messageData.user, channel: messageData.channel, runId, attempt }, "Processing message");

    // Extract key data
    const teamId = messageData.team_id || (typeof messageData.team === "string" ? messageData.team : messageData.team?.id);
    const slackAppId = messageData.slack_app_id || messageData.api_app_id;
    const userId = messageData.user;
    const channelId = messageData.channel;
    const text = messageData.text || "";
    const threadTs = messageData.thread_ts || messageData.ts;

    // Skip bot messages and non-user events
    if (
      messageData.bot_id ||
      messageData.subtype === "bot_message" ||
      messageData.message?.bot_id ||
      messageData.subtype === "message_changed" ||
      messageData.subtype === "message_deleted" ||
      messageData.subtype === "channel_join" ||
      messageData.subtype === "channel_leave" ||
      messageData.subtype === "channel_topic" ||
      messageData.subtype === "channel_purpose"
    ) {
      log.info({ subtype: messageData.subtype || "bot_message" }, "Skipping non-user event");
      return { status: "skipped", reason: messageData.subtype || "bot_message" };
    }

    // ── Shared failure state — used by the top-level safety net to run the
    // backup flow and write a telemetry row when any step throws.
    // ──────────────────────────────────────────────────────────────────────
    const failureState = {
      currentStep: "resolve-context" as string,
      chatCtx: null as ChatContext | null,
      agentState: {} as Record<string, unknown>,
      terminalReached: false,      // once true, onProgress must stop editing thinking
      recoveryAttempted: false,    // prevents double recovery
    };

    // ── Step 1: Resolve all context in a single round-trip ─────────────
    // Workspace, token, user link, org check, fast-path detection, intent
    // classification — all DB reads + regex. Saves ~5 Vercel Workflow step round-trips
    // (~1.5-2s) vs the previous 7 separate steps.
    const ctx = await step.run("resolve-context", async (): Promise<ResolvedContext | null> => {
      const supabase = getSupabaseAdmin();

      // 1a+b. Get workspace + decrypted bot token (cached, 10-min TTL)
      const workspace = await getWorkspaceWithToken(teamId, slackAppId);
      if (!workspace) return null;

      const { botToken } = workspace;

      // 1c. Classify intent + detect fast-paths FIRST (pure regex, zero I/O)
      const emailAction = detectEmailAction(text);
      const emailShare = detectEmailShareRequest(text);
      const docShare = detectDocumentShareRequest(text);
      const classification = classifyIntent(text);
      log.info({ classification }, "Classified intent");

      // 1d-f. Run thinking message, user linking, and timezone fetch in PARALLEL
      // These are independent operations — no data dependencies between them.
      const isChatIntent = (classification.intent === "chat" || classification.intent === "meeting-prep") && !emailShare.isEmailRequest && !docShare.isShareRequest;

      const [thinkingResult, userLink, timezoneResult] = await Promise.all([
        // 1d. Post thinking message for chat intent
        isChatIntent
          ? fetch("https://slack.com/api/chat.postMessage", {
              method: "POST",
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                Authorization: `Bearer ${botToken}`,
              },
              body: JSON.stringify({
                channel: channelId,
                thread_ts: threadTs,
                text: "I'm thinking :thinking_face:",
              }),
            })
              .then(resp => resp.json())
              .then(result => {
                if (!result.ok) log.warn({ error: result.error }, "thinking message failed");
                return result.ok ? (result.ts as string) : null;
              })
              .catch(err => {
                log.warn({ err }, "thinking message error");
                return null;
              })
          : Promise.resolve(null),

        // 1e. Link Slack user to Sales Agent account + resolve org
        linkSlackUserToAgent(supabase, userId, workspace.id, botToken),

        // 1f. Fetch Slack user timezone
        fetch(`https://slack.com/api/users.info?user=${userId}`, {
          headers: { Authorization: `Bearer ${botToken}` },
        })
          .then(resp => resp.json())
          .then(data => {
            if (data?.ok && data.user?.tz) {
              log.info({ timezone: data.user.tz }, "User timezone from Slack");
              return data.user.tz as string;
            }
            return null;
          })
          .catch(err => {
            log.warn({ err }, "Failed to fetch Slack user info");
            return null;
          }),
      ]);

      const thinkingTs = thinkingResult;
      const userTimezone = timezoneResult;

      // 1g. Check org permission (non-blocking, log only)
      // 1h. Sync timezone to profile (best-effort)
      // Run these in parallel — both are fire-and-forget side effects
      const sideEffects: Promise<void>[] = [];

      if (userLink.userId && userLink.organizationId) {
        sideEffects.push(
          checkOrgPermission(supabase, userLink.userId, userLink.organizationId)
            .then(orgRole => {
              if (orgRole) {
                log.info({ userId: userLink.userId, orgId: userLink.organizationId, role: orgRole }, "User org permission verified");
              } else {
                log.warn({ userId: userLink.userId, orgId: userLink.organizationId }, "User not a member of the mapped organization");
              }
            })
            .catch(() => {}),
        );
      }

      if (userTimezone && userLink.userId) {
        sideEffects.push(
          Promise.resolve(
            supabase
              .from("profiles")
              .update({ timezone: userTimezone })
              .eq("user_id", userLink.userId)
          )
            .then(() => {})
            .catch((err: any) => log.warn({ err }, "Failed to update profile timezone")),
        );
      }

      await Promise.all(sideEffects);

      return {
        botToken,
        workspaceId: workspace.id,
        agentUserId: userLink.userId,
        organizationId: userLink.organizationId,
        emailAction,
        emailShare,
        docShare,
        classification,
        userTimezone,
        thinkingTs,
      };
    });

    if (!ctx) {
      return { status: "error", reason: "workspace_not_found" };
    }

    if (!ctx.agentUserId) {
      await step.run("send-error-message", async () => {
              // Clean up the thinking message if one was posted
        if (ctx.thinkingTs) {
          await deleteSlackMessage(ctx.botToken, channelId, ctx.thinkingTs).catch(() => {});
        }

        await sendSlackMessage(
          ctx.botToken,
          channelId,
          "Your Slack account is not linked to a Sales Agent account. Please sign up at https://your-app.example.com and link your account first.",
          threadTs
        );
      });
      return { status: "error", reason: "user_not_linked" };
    }

    // ── Step 2: Route to handler ────────────────────────────────────────

    // Fast path: Email draft approval/rejection via text ("send it" / "cancel it")
    // Scoped to the current Slack thread so it only matches drafts from this conversation.
    if (ctx.emailAction && ctx.agentUserId && threadTs) {
      const draftResult = await step.run("check-pending-draft", async () => {
              const supabase = getSupabaseAdmin();
        const { data: draft } = await supabase
          .from("email_auto_response_drafts")
          .select("*")
          .eq("user_id", ctx.agentUserId!)
          .eq("status", "pending")
          .eq("slack_channel_id", channelId)
          .eq("slack_thread_ts", threadTs)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        return draft;
      });

      if (draftResult) {
        if (ctx.emailAction.action === "approve") {
          // Optimistic lock: atomically claim the draft to prevent double-send
          const claimed = await step.run("claim-draft-for-send", async () => {
                  const supabase = getSupabaseAdmin();
            const { data, error } = await supabase
              .from("email_auto_response_drafts")
              .update({ status: "sent", sent_at: new Date().toISOString() })
              .eq("id", draftResult.id)
              .eq("status", "pending")
              .select("id")
              .maybeSingle();
            if (error) {
              log.error({ err: error }, "claim-draft error");
              return false;
            }
            return !!data;
          });

          if (!claimed) {
            // Another handler already claimed this draft
            log.info({ draftId: draftResult.id }, "Draft already claimed, skipping");
            return { status: "skipped", reason: "already_claimed", draftId: draftResult.id };
          }

          // Send the email
          await step.sendEvent("send-approval-event", {
            name: "email/approval-response",
            data: {
              draftId: draftResult.id,
              action: "approve",
              slackUserId: userId,
            },
          });

          if (!draftResult.incoming_email_id) {
            await step.invoke("send-agent-email", {
              function: sendEmail,
              data: {
                to: draftResult.to_email,
                subject: draftResult.subject,
                body: draftResult.body,
                userId: draftResult.user_id,
              },
            });

          }

          // Update the original approval message to show it was sent
          await step.run("update-approval-message", async () => {
                  if (draftResult.slack_message_ts) {
              await updateSlackMessage(
                ctx.botToken, channelId, draftResult.slack_message_ts,
                `✅ *Email sent!*\n\n*To:* ${escapeMrkdwn(draftResult.to_email)}\n*Subject:* ${escapeMrkdwn(draftResult.subject)}`,
                [
                  {
                    type: "section",
                    text: {
                      type: "mrkdwn",
                      text: `✅ *Email sent!*\n\n*To:* ${escapeMrkdwn(draftResult.to_email)}\n*Subject:* ${escapeMrkdwn(draftResult.subject)}`,
                    },
                  },
                  {
                    type: "context",
                    elements: [
                      {
                        type: "mrkdwn",
                        text: `Sent by <@${userId}> at <!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} {time}|${new Date().toISOString()}>`,
                      },
                    ],
                  },
                ]
              );
            }
          });

          // Clean up thinking message
          if (ctx.thinkingTs) {
            await step.run("cleanup-thinking-approve", async () => {
                    await deleteSlackMessage(ctx.botToken, channelId, ctx.thinkingTs!).catch(() => {});
            });
          }

          if (ctx.organizationId) {
            trackUsageEvent({
              orgId: ctx.organizationId,
              userId: ctx.agentUserId!,
              eventType: 'task',
              eventName: 'email_approve',
            });
          }

          if (ctx.organizationId && ctx.agentUserId) {
            writeFeedbackEvent({
              userId: ctx.agentUserId,
              organizationId: ctx.organizationId,
              domain: "email_draft",
              signalType: "approval",
              agentOutput: { subject: draftResult.subject, body: (draftResult.body || "").slice(0, 1500), to: draftResult.to_email },
              context: { classification: draftResult.classification, confidence: draftResult.confidence_score, recipient: draftResult.to_email },
              sourceRef: { table: "email_auto_response_drafts", id: draftResult.id },
            });
          }

          return { status: "approved", intent: "email-action", draftId: draftResult.id };

        } else {
          // Optimistic lock: atomically claim the draft to prevent double-reject
          const claimed = await step.run("claim-draft-for-reject", async () => {
                  const supabase = getSupabaseAdmin();
            const { data, error } = await supabase
              .from("email_auto_response_drafts")
              .update({ status: "rejected" })
              .eq("id", draftResult.id)
              .eq("status", "pending")
              .select("id")
              .maybeSingle();
            if (error) {
              log.error({ err: error }, "claim-draft-reject error");
              return false;
            }
            return !!data;
          });

          if (!claimed) {
            log.info({ draftId: draftResult.id }, "Draft already claimed (reject), skipping");
            return { status: "skipped", reason: "already_claimed", draftId: draftResult.id };
          }

          // Cancel the draft
          await step.sendEvent("send-rejection-event", {
            name: "email/approval-response",
            data: {
              draftId: draftResult.id,
              action: "reject",
              slackUserId: userId,
            },
          });

          // Update the original approval message to show it was cancelled
          await step.run("update-approval-message-cancelled", async () => {
                  if (draftResult.slack_message_ts) {
              await updateSlackMessage(
                ctx.botToken, channelId, draftResult.slack_message_ts,
                `❌ *Email cancelled*\n\n*To:* ${escapeMrkdwn(draftResult.to_email)}\n*Subject:* ${escapeMrkdwn(draftResult.subject)}`,
                [
                  {
                    type: "section",
                    text: {
                      type: "mrkdwn",
                      text: `❌ *Email cancelled*\n\n*To:* ${escapeMrkdwn(draftResult.to_email)}\n*Subject:* ${escapeMrkdwn(draftResult.subject)}\n\n_Draft discarded._`,
                    },
                  },
                  {
                    type: "context",
                    elements: [
                      {
                        type: "mrkdwn",
                        text: `Cancelled by <@${userId}> at <!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} {time}|${new Date().toISOString()}>`,
                      },
                    ],
                  },
                ]
              );
            }
          });

          if (ctx.organizationId && ctx.agentUserId) {
            writeFeedbackEvent({
              userId: ctx.agentUserId,
              organizationId: ctx.organizationId,
              domain: "email_draft",
              signalType: "rejection",
              agentOutput: { subject: draftResult.subject, body: (draftResult.body || "").slice(0, 1500), to: draftResult.to_email },
              context: { classification: draftResult.classification, confidence: draftResult.confidence_score, recipient: draftResult.to_email },
              sourceRef: { table: "email_auto_response_drafts", id: draftResult.id },
            });
          }

          // Clean up thinking message
          if (ctx.thinkingTs) {
            await step.run("cleanup-thinking-reject", async () => {
                    await deleteSlackMessage(ctx.botToken, channelId, ctx.thinkingTs!).catch(() => {});
            });
          }

          return { status: "rejected", intent: "email-action", draftId: draftResult.id };
        }
      }
      // No pending draft found in this thread — fall through to normal chat handling
    }

    // Fast path: Email share (acknowledge + send + confirm in one step)
    if (ctx.emailShare.isEmailRequest && ctx.emailShare.queries.length > 0 && ctx.emailShare.recipientEmail && ctx.organizationId) {
      const emailResult = await step.run("email-share", async () => {
              const queryDisplay = ctx.emailShare.queries.map((q: string) => `"${q}"`).join(', ');
        await sendSlackMessage(
          ctx.botToken, channelId,
          `Sending ${queryDisplay} to ${ctx.emailShare.recipientEmail}...`,
          threadTs
        );

        const { WebClient } = await import("@slack/web-api");
        const slack = new WebClient(ctx.botToken);
        const result = await sendDocumentViaEmail(
          slack, channelId, threadTs || "",
          ctx.emailShare.queries, ctx.emailShare.recipientEmail!,
          ctx.organizationId!, ctx.agentUserId!,
        );

        if (result.success) {
          const titles = result.documentTitles || [];
          const titleList = titles.map((t: string) => `"${t}"`).join(', ');
          let confirmMsg = `Sent ${titleList} to ${result.recipientEmail}`;
          if (result.notFound && result.notFound.length > 0) {
            confirmMsg += `\n:warning: Could not find: ${result.notFound.map((q: string) => `"${q}"`).join(', ')}`;
          }
          await sendSlackMessage(ctx.botToken, channelId, confirmMsg, threadTs);
        } else {
          await sendSlackMessage(
            ctx.botToken, channelId,
            result.error || "Sorry, I couldn't send that email.",
            threadTs
          );
        }

        // Fire-and-forget usage tracking
        if (ctx.organizationId) {
          trackUsageEvent({
            orgId: ctx.organizationId,
            userId: ctx.agentUserId!,
            eventType: 'task',
            eventName: 'email_share',
            status: result.success ? 'success' : 'fail',
          });
        }

        return result;
      });

      return {
        status: emailResult.success ? "email_shared" : "email_share_failed",
        intent: "email-share",
      };
    }

    // Fast path: Document share (acknowledge + share + error in one step)
    if (ctx.docShare.isShareRequest && ctx.docShare.query && ctx.organizationId) {
      const shareResult = await step.run("document-share", async () => {
              await sendSlackMessage(
          ctx.botToken, channelId,
          `Looking for ${ctx.docShare.query}...`,
          threadTs
        );

        const result = await shareDocumentInWorkflow(
          ctx.botToken, channelId, threadTs,
          ctx.docShare.query!, ctx.organizationId!
        );

        if (!result.success) {
          await sendSlackMessage(
            ctx.botToken, channelId,
            result.error || "Sorry, I couldn't find that document.",
            threadTs
          );
        }

        // Fire-and-forget usage tracking
        if (ctx.organizationId) {
          trackUsageEvent({
            orgId: ctx.organizationId,
            userId: ctx.agentUserId!,
            eventType: 'task',
            eventName: 'document_share',
            status: result.success ? 'success' : 'fail',
          });
        }

        return result;
      });

      return {
        status: shareResult.success ? "document_shared" : "document_not_found",
        intent: "document-share",
        document: shareResult.documentTitle,
      };
    }

    // Route by classified intent
    const { classification } = ctx;

    if (classification.intent === "search-docs") {
      const query = text.replace(/^\/?docs?\s+/i, "").replace(/^\/?search\s+/i, "").trim();

      if (!query) {
        await step.run("send-search-help", async () => {
                await sendSlackMessage(
            ctx.botToken, channelId,
            "To search documents, use: `/docs [your query]` or `search [your query]`",
            threadTs
          );
        });
        return { status: "help_sent", intent: "search-docs" };
      }

      await step.sendEvent("trigger-doc-search", {
        name: "knowledge-base/search",
        data: { query, userId: ctx.agentUserId, limit: 5 },
      });

      await step.run("acknowledge-search", async () => {
              await sendSlackMessage(
          ctx.botToken, channelId,
          `Searching for: "${query}"... I'll send you the results shortly.`,
          threadTs
        );
      });

      // Fire-and-forget usage tracking
      if (ctx.organizationId) {
        trackUsageEvent({
          orgId: ctx.organizationId,
          userId: ctx.agentUserId!,
          eventType: 'task',
          eventName: 'doc_search',
        });
      }

      return { status: "search_triggered", intent: "search-docs", query };

    } else if (classification.intent === "contact-management") {
      await step.run("acknowledge-contact-management", async () => {
              await sendSlackMessage(
          ctx.botToken, channelId,
          "Contact management command received. This feature is coming soon!",
          threadTs
        );
      });
      return { status: "acknowledged", intent: "contact-management" };

    } else {
      // Default: Chat — run the agent pipeline inline to avoid the
      // ~2-3s overhead of a second Vercel Workflow function hop + duplicate
      // context resolution. Bot token stays in-memory (never in event logs).
      //
      // ── Top-level failure safety net ─────────────────────────────────
      // Wraps the entire chat path. On any step failure, runs the backup
      // response flow (Tier A bare LLM → Tier B apology) so the thinking
      // message is always resolved into something useful, then writes a
      // telemetry row and rethrows so Vercel Workflow can retry.
      try {
      failureState.currentStep = "prepare-chat-context";

      // ── Step 2a: Prepare chat context ───────────────────────────────
      const chatCtx = await step.run("prepare-chat-context", async (): Promise<ChatContext> => {
        const supabase = getSupabaseAdmin();
        const agentUserId = ctx.agentUserId!;

        // Parallel fetch: profile, conversation, preferences, and thread history.
        const [profileResult, conversationResult, prefsResult, slackThreadMessages] = await Promise.all([
          // Profile
          supabase
            .from("profiles")
            .select("first_name, last_name, email, company, timezone")
            .eq("user_id", agentUserId)
            .single(),
          // Get or create conversation (thread mapping).
          // Uses upsert pattern — if two requests race (despite per-thread
          // serialization), the DB unique constraint on (workspace, channel,
          // thread_ts) ensures only one mapping is created.
          (async () => {
            const { data: existing } = await supabase
              .from("slack_thread_conversations")
              .select("conversation_id")
              .eq("slack_workspace_id", ctx.workspaceId)
              .eq("slack_channel_id", channelId)
              .eq("slack_thread_ts", threadTs)
              .maybeSingle();

            if (existing) return { conversationId: existing.conversation_id };

            const { data: conv, error: convErr } = await supabase
              .from("conversations")
              .insert({
                user_id: agentUserId,
                title: `Slack: ${text.substring(0, 50)}...`,
                source: "slack",
                organization_id: ctx.organizationId || null,
              })
              .select()
              .single();

            if (convErr || !conv) throw new Error(`Failed to create conversation: ${convErr?.message}`);

            // Upsert: ON CONFLICT returns existing mapping if another request won the race
            const { data: mapping } = await supabase
              .from("slack_thread_conversations")
              .upsert(
                {
                  slack_workspace_id: ctx.workspaceId,
                  slack_channel_id: channelId,
                  slack_thread_ts: threadTs,
                  conversation_id: conv.id,
                  agent_user_id: agentUserId,
                },
                { onConflict: "slack_workspace_id,slack_channel_id,slack_thread_ts" },
              )
              .select("conversation_id")
              .single();

            return { conversationId: mapping?.conversation_id || conv.id };
          })(),
          // User preferences + context
          (async () => {
            try {
              const [{ data: userPrefs }, { data: userCtx }, { data: learnings }] = await Promise.all([
                supabase
                  .from("user_preferences")
                  .select("preference_key, preference_value, confidence_score")
                  .eq("user_id", agentUserId)
                  .gte("confidence_score", 0.6),
                supabase
                  .from("user_context")
                  .select("*")
                  .eq("user_id", agentUserId)
                  .maybeSingle(),
                (() => {
                  let q = supabase
                    .from("user_learnings")
                    .select("learning, domain")
                    .eq("user_id", agentUserId)
                    .eq("status", "active");
                  if (ctx.organizationId) q = q.eq("organization_id", ctx.organizationId);
                  return q.order("updated_at", { ascending: false }).limit(15);
                })(),
              ]);

              if ((userPrefs && userPrefs.length > 0) || userCtx || (learnings && learnings.length > 0)) {
                return buildPreferenceInstructions(userPrefs || [], userCtx || null, null, learnings || []) || null;
              }
            } catch (err) {
              log.warn({ err }, "Failed to load user preferences");
            }
            return null;
          })(),
          // Slack thread history
          fetchSlackThread(ctx.botToken, channelId, threadTs),
        ]);

        const profile = profileResult.data;
        const { conversationId } = conversationResult;
        const userPreferences = prefsResult;

        // Save user message (depends on conversationId)
        await supabase.from("chat_messages").insert({
          conversation_id: conversationId,
          role: "user",
          content: text,
        });

        // Fallback to DB history if thread fetch returned empty
        let conversationHistory: Array<{ role: string; content: string }> = slackThreadMessages;
        if (conversationHistory.length === 0) {
          const { data: historyRows } = await supabase
            .from("chat_messages")
            .select("role, content")
            .eq("conversation_id", conversationId)
            .order("created_at", { ascending: false })
            .limit(20);
          conversationHistory = historyRows ? historyRows.reverse() : [];
        }

        return {
          profile,
          conversationId,
          conversationHistory,
          userPreferences,
        };
      });

      // Expose chatCtx to the outer recovery flow — if a later step fails
      // we want the backup LLM to use the conversation history we just loaded.
      failureState.chatCtx = chatCtx as ChatContext;

      const userName = chatCtx.profile
        ? `${chatCtx.profile.first_name || ""} ${chatCtx.profile.last_name || ""}`.trim() || null
        : null;

      // ── Step 2b: Run LangGraph supervisor agent ─────────────────────
      failureState.currentStep = "run-agent";
      const agentStartTime = Date.now();
      const agentResult = await step.run("run-agent", async () => {
                return await runSupervisor({
            messages: chatCtx.conversationHistory.map(m => ({ role: m.role || "user", content: m.content || "" })),
            currentMessage: text,
            userId: ctx.agentUserId!,
            organizationId: ctx.organizationId || null,
            userName,
            userEmail: chatCtx.profile?.email || null,
            userCompany: chatCtx.profile?.company || null,
            slackContext: { channelId, threadTs, botToken: ctx.botToken },
            domainSignals: classification.domainSignals || null,
            userPreferences: chatCtx.userPreferences,
            userTimezone: ctx.userTimezone || chatCtx.profile?.timezone || null,
            onProgress: ctx.thinkingTs
              ? (status: string) => {
                  // Race fix: once the handler enters its terminal post-and-save
                  // phase (or a recovery flow), stop editing the thinking message
                  // so a late progress write can't overwrite the final answer.
                  if (failureState.terminalReached) return;
                  failureState.agentState.lastProgressStatus = status;
                  updateSlackMessage(ctx.botToken, channelId, ctx.thinkingTs!, status)
                    .catch(err => log.warn({ err }, "progress update failed"));
                }
              : undefined,
          });
        });

      // Fire-and-forget task-level usage tracking
      if (ctx.organizationId) {
        trackUsageEvent({
          orgId: ctx.organizationId,
          userId: ctx.agentUserId!,
          eventType: 'task',
          eventName: 'slack_chat',
          runtimeMs: Date.now() - agentStartTime,
        });
      }

      // ── Step 2c: Post response + save to DB ─────────────────────────
      // Stop the onProgress stream from editing thinking — we're about to
      // overwrite it with the final response.
      failureState.terminalReached = true;
      failureState.currentStep = "post-and-save";

      await step.run("post-and-save", async () => {
              const supabase = getSupabaseAdmin();

        const blocks = formatMessageForSlack(
          agentResult.response,
          agentResult.sources,
          agentResult.confidence,
          agentResult.hasConflicts,
        );

        // Append connect buttons when integrations are missing
        if (agentResult.missingIntegrations?.length) {
          const connectUrl = getConnectUrl();
          for (const mi of agentResult.missingIntegrations) {
            blocks.push(buildConnectBlock(mi.label, connectUrl));
          }
        }

        // Update thinking message in-place, or post new
        if (ctx.thinkingTs) {
          log.info({ thinkingTs: ctx.thinkingTs, responseLength: agentResult.response.length }, "Updating thinking message with response");
          const result = await updateSlackMessage(ctx.botToken, channelId, ctx.thinkingTs, agentResult.response, blocks);
          if (!result.ok) {
            log.error({ result }, "chat.update FAILED");
            await sendSlackBlockMessage(ctx.botToken, channelId, agentResult.response, blocks, threadTs);
          } else {
            log.info({ thinkingTs: ctx.thinkingTs }, "chat.update succeeded");
          }
        } else {
          const result = await sendSlackBlockMessage(ctx.botToken, channelId, agentResult.response, blocks, threadTs);
          if (!result.ok) {
            log.error({ error: result.error }, "Slack API error");
            throw new Error(`Slack API error: ${result.error}`);
          }
        }

        // Save assistant message to DB
        await supabase.from("chat_messages").insert({
          conversation_id: chatCtx.conversationId,
          role: "assistant",
          content: agentResult.response,
        });
      });

      // Memory save is now handled by the supervisor's auto-save (with metadata, category, entity extraction).
      // The legacy chat/save-memory Vercel Workflow event has been removed to avoid double-saving.

      // Success — mark any earlier unresolved error rows for this Vercel Workflow
      // run as resolved so dashboards can distinguish intermittent
      // (self-healed) from terminal failures.
      await markErrorsResolved(runId ?? null);

      return { status: "ok", intent: "chat" };
      } catch (chatError) {
        // Top-level safety net: run the backup flow (Tier A LLM → Tier B
        // apology), update the thinking message, write a telemetry row,
        // then rethrow so Vercel Workflow can retry the function.
        if (!failureState.recoveryAttempted) {
          failureState.recoveryAttempted = true;
          failureState.terminalReached = true;

          log.error(
            { err: chatError, step: failureState.currentStep },
            "Chat path failed",
          );

          await runRecoveryFlow({
            error: chatError,
            step: failureState.currentStep,
            ctx: ctx as ResolvedContext,
            chatCtx: failureState.chatCtx,
            agentState: failureState.agentState,
            channelId,
            threadTs,
            text,
            teamId,
            slackUserId: userId,
            runId: runId ?? null,
            attempt: attempt ?? null,
            rawEvent: messageData as unknown as Record<string, unknown>,
          });
        }
        throw chatError;
      }
    }
  }
);
