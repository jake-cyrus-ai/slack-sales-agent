/**
 * Prospect dossier → Slack delivery.
 *
 * New post type that lives alongside the existing per-step Slack agent stream.
 * Does NOT modify the existing slack-helpers wiring; consumes its primitives
 * (sendSlackBlockMessage / updateSlackMessage / sendSlackMessage).
 *
 * Behaviour:
 *   - First time we deliver a dossier for a session → chat.postMessage,
 *     persist (channel_id, message_ts) on prospect_dossiers.
 *   - Subsequent updates → chat.update on the original message AND a
 *     threaded reply ("dossier updated — fit X, …") so sellers get the
 *     change ping without losing the canonical card.
 *
 * Channel selection (per org):
 *   1. organizations.settings.prospect_dossier_slack_channel_id  (preferred)
 *   2. organization_slack_settings.default_channel_id            (fallback)
 *
 * Workspace selection: slack_workspaces.organization_id (single active row).
 */

import { getSupabaseAdmin } from "../supabase";
import { logger } from "../logger";
import {
  decryptBotToken,
  sendSlackBlockMessage,
  sendSlackMessage,
  updateSlackMessage,
} from "../../inngest/utils/slack-helpers";
import {
  recordDossierSlackPost,
  type ProspectDossier,
} from "./dossier";

const log = logger.child({ component: "prospect-context-slack-post" });

export interface SlackTarget {
  botToken: string;
  channelId: string;
  teamId: string;
}

// ---------------------------------------------------------------------------
// Notification destination types — org-configurable via
// organizations.settings.prospect_notification_destination
// ---------------------------------------------------------------------------

export type NotificationDestination =
  | { type: "channel"; channelId: string } // post to specific channel
  | { type: "dm_to_rep" }; // DM the assigned rep

function isValidNotificationDestination(v: unknown): v is NotificationDestination {
  if (typeof v !== "object" || v === null || !("type" in v)) return false;
  const obj = v as Record<string, unknown>;
  if (obj.type === "channel" && typeof obj.channelId === "string" && obj.channelId.length > 0) return true;
  if (obj.type === "dm_to_rep") return true;
  return false;
}

const SLACK_API_TIMEOUT_MS = 10_000;

/**
 * Resolve workspace credentials (bot token + team ID) for an org.
 * Shared by both target-resolution paths.
 */
async function resolveWorkspace(
  organizationId: string,
): Promise<{ botToken: string; teamId: string } | null> {
  const supabase = getSupabaseAdmin();

  const { data: workspace, error: wsErr } = await supabase
    .from("slack_workspaces")
    .select("team_id, bot_token, is_active")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .maybeSingle();
  if (wsErr || !workspace) {
    log.warn({ err: wsErr, organizationId }, "No active Slack workspace for organization; skipping Slack post");
    return null;
  }

  let botToken: string;
  try {
    botToken = await decryptBotToken(workspace.bot_token);
  } catch (err) {
    log.error({ err, organizationId }, "Failed to decrypt Slack bot token");
    return null;
  }

  return { botToken, teamId: workspace.team_id };
}

/**
 * Open a Slack DM channel with a Sales Agent user via their slack_user_mappings row.
 * Returns the DM channel ID or null on failure.
 */
async function openDmChannelForUser(
  botToken: string,
  agentUserId: string,
  organizationId: string,
): Promise<string | null> {
  const supabase = getSupabaseAdmin();

  const { data: mapping, error: mappingErr } = await supabase
    .from("slack_user_mappings")
    .select("slack_user_id")
    .eq("agent_user_id", agentUserId)
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (mappingErr || !mapping?.slack_user_id) {
    log.warn({ err: mappingErr, agentUserId, organizationId }, "No Slack user mapping for rep; cannot open DM");
    return null;
  }

  try {
    const resp = await fetch("https://slack.com/api/conversations.open", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({ users: mapping.slack_user_id }),
      signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
    });
    const data = (await resp.json()) as { ok: boolean; channel?: { id: string }; error?: string };
    if (!data.ok || !data.channel?.id) {
      log.error({ slackUserId: mapping.slack_user_id, error: data.error }, "conversations.open failed for DM-to-rep");
      return null;
    }
    return data.channel.id;
  } catch (err) {
    log.error({ err, agentUserId }, "conversations.open timed out or threw for DM-to-rep");
    return null;
  }
}

/**
 * Resolve the Slack channel for prospect notifications using the
 * org-configurable destination setting.
 *
 * Priority:
 *   1. organizations.settings.prospect_notification_destination
 *      - { type: "channel", channelId } → use that channel
 *      - { type: "dm_to_rep" } → look up assigned rep, open DM
 *   2. organizations.settings.prospect_dossier_slack_channel_id (legacy)
 *   3. organization_slack_settings.default_channel_id (legacy fallback)
 *   4. null → skip
 *
 * @param assignedRepUserId - Sales Agent user ID of the assigned rep (needed for dm_to_rep)
 */
export async function resolveNotificationTarget(
  organizationId: string,
  assignedRepUserId?: string | null,
): Promise<SlackTarget | null> {
  const supabase = getSupabaseAdmin();

  const { data: org, error: orgErr } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();
  if (orgErr) {
    log.error({ err: orgErr, organizationId }, "Failed to load organization for Slack target");
    return null;
  }

  const settings = (org?.settings ?? {}) as Record<string, unknown>;

  // Check for the new unified destination setting first
  const rawDestination = settings.prospect_notification_destination;
  const destination: NotificationDestination | undefined =
    isValidNotificationDestination(rawDestination) ? rawDestination : undefined;

  if (rawDestination && !destination) {
    log.warn(
      { organizationId, prospect_notification_destination: rawDestination },
      "Invalid prospect_notification_destination setting; falling back to legacy channel resolution",
    );
  }

  // Resolve workspace once — reused by both destination-type and legacy paths.
  const ws = await resolveWorkspace(organizationId);
  if (!ws) return null;

  if (destination) {
    if (destination.type === "channel" && destination.channelId) {
      return { botToken: ws.botToken, channelId: destination.channelId, teamId: ws.teamId };
    }

    if (destination.type === "dm_to_rep") {
      if (!assignedRepUserId) {
        log.info({ organizationId }, "dm_to_rep destination configured but no assigned rep; falling back to channel");
        // Fall through to legacy channel resolution below
      } else {
        const dmChannel = await openDmChannelForUser(ws.botToken, assignedRepUserId, organizationId);
        if (dmChannel) {
          return { botToken: ws.botToken, channelId: dmChannel, teamId: ws.teamId };
        }
        log.warn({ organizationId, assignedRepUserId }, "dm_to_rep: could not open DM; falling back to channel");
        // Fall through to legacy channel resolution
      }
    }
  }

  // Legacy resolution: prospect_dossier_slack_channel_id → default_channel_id
  let channelId = typeof settings.prospect_dossier_slack_channel_id === "string"
    ? (settings.prospect_dossier_slack_channel_id as string)
    : null;

  if (!channelId) {
    const { data: orgSlack } = await supabase
      .from("organization_slack_settings")
      .select("default_channel_id")
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (orgSlack?.default_channel_id) channelId = orgSlack.default_channel_id;
  }

  if (!channelId) {
    log.info({ organizationId }, "No Slack channel configured for prospect notification delivery; skipping post");
    return null;
  }

  return { botToken: ws.botToken, channelId, teamId: ws.teamId };
}

/**
 * Legacy wrapper — resolves the Slack target without rep-DM support.
 * Used by callers that don't have an assigned rep context.
 */
async function resolveSlackTarget(organizationId: string): Promise<SlackTarget | null> {
  return resolveNotificationTarget(organizationId);
}

function fitScoreEmoji(score: number | null, band: string | null): string {
  if (score === null) return "❔";
  if (band === "high") return "🟢";
  if (band === "low") return "🔴";
  return "🟡";
}

function buildBlocks(dossier: ProspectDossier): {
  text: string;
  blocks: Record<string, unknown>[];
} {
  const headline = dossier.contactName
    ? `New prospect — *${dossier.contactName}*${dossier.contactCompany ? ` (${dossier.contactCompany})` : ""}`
    : "New prospect dossier";
  const fitLine = dossier.fitScore !== null
    ? `${fitScoreEmoji(dossier.fitScore, dossier.fitBand)} *Fit:* ${dossier.fitScore}/100 (${dossier.fitBand ?? "—"})`
    : "Fit: pending";

  const contactBits: string[] = [];
  if (dossier.contactEmail) contactBits.push(`📧 ${dossier.contactEmail}`);
  if (dossier.contactRole) contactBits.push(`🪪 ${dossier.contactRole}`);

  const blocks: Record<string, unknown>[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "Autonomous Prospect Dossier", emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `${headline}\n${fitLine}` },
    },
  ];

  if (contactBits.length > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: contactBits.join("  •  ") }],
    });
  }

  if (dossier.strengths.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Strengths*\n${dossier.strengths.map((s) => `• ${s}`).join("\n")}`,
      },
    });
  }

  if (dossier.gaps.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Gaps*\n${dossier.gaps.map((g) => `• ${g}`).join("\n")}`,
      },
    });
  }

  if (dossier.currentState) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Current State*\n${dossier.currentState}`,
      },
    });
  }

  if (dossier.crmDealUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: `Open in ${dossier.crmProvider ?? "CRM"}`, emoji: true },
          url: dossier.crmDealUrl,
        },
      ],
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `_v${dossier.version} • ${new Date(dossier.updatedAt).toISOString()}_`,
      },
    ],
  });

  // Fallback text for notifications / accessibility.
  const text = `Prospect dossier: ${dossier.contactName ?? "(unknown)"} — ${
    dossier.fitScore !== null ? `fit ${dossier.fitScore}/100` : "fit pending"
  }`;

  return { text, blocks };
}

/**
 * Deliver a dossier to Slack. Idempotent: if the dossier already has a
 * recorded message_ts, updates in place + posts a threaded "updated" reply.
 *
 * @param assignedRepUserId - optional Sales Agent user ID; used when the org's
 *   notification destination is set to `dm_to_rep`.
 */
export async function sendDossierToSlack(
  dossier: ProspectDossier,
  assignedRepUserId?: string | null,
  isHandoff?: boolean,
): Promise<void> {
  const target = await resolveNotificationTarget(dossier.organizationId, assignedRepUserId);
  if (!target) return;

  const { text, blocks } = buildBlocks(dossier);

  // Handoff alert: prepend an urgent banner when the prospect asked for a human
  if (isHandoff) {
    blocks.unshift({
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":rotating_light: *Human handoff requested* — prospect asked to speak with a rep. Please follow up directly.",
      },
    } as any);
  }

  // Update path
  if (dossier.slackMessageTs && dossier.slackChannelId) {
    const updated = await updateSlackMessage(
      target.botToken,
      dossier.slackChannelId,
      dossier.slackMessageTs,
      text,
      blocks,
      target.teamId,
    );
    if (!updated.ok) {
      log.warn({ dossierId: dossier.id, error: updated.error }, "Slack chat.update failed for dossier");
    }
    // Post a small threaded ping so sellers see the change.
    const ping = await sendSlackMessage(
      target.botToken,
      dossier.slackChannelId,
      `:pencil2: Dossier updated — v${dossier.version}${
        dossier.fitScore !== null ? ` • fit ${dossier.fitScore}/100` : ""
      }`,
      dossier.slackMessageTs,
      target.teamId,
    );
    if (!ping.ok) {
      log.warn({ dossierId: dossier.id, error: ping.error }, "Slack threaded update reply failed");
    }
    return;
  }

  // First post. If the buyer already triggered an "email shared"
  // notification on this session (the lean 📩 message that fires from
  // /submit or capture_identity), thread this qualified dossier
  // underneath it so the seller sees the full buyer journey in one
  // Slack thread instead of two top-level messages. When there's no
  // anchor (rare — would require a dossier finalize without any email
  // capture), fall back to a top-level post.
  const anchor = await getEmailSharedThreadAnchor(dossier.sessionId);
  const threadChannel = anchor?.channelId ?? target.channelId;
  const threadTs = anchor?.ts;

  const posted = await sendSlackBlockMessage(
    target.botToken,
    threadChannel,
    text,
    blocks,
    threadTs,
    target.teamId,
  );

  if (!posted.ok || !posted.ts || !posted.channel) {
    log.error({ dossierId: dossier.id, error: posted.error }, "Slack chat.postMessage failed for dossier");
    return;
  }

  await recordDossierSlackPost(dossier.id, posted.channel, posted.ts);
}

// ---------------------------------------------------------------------------
// Email-shared notification
//
// Fires the moment a buyer hands over their email — either through the
// /demo form's /submit, or the chat agent's `capture_identity` tool. Lean
// "📩 New prospect email" message in the org's #prospects channel, with
// just enough context for a seller to know who walked in. The full
// qualified dossier (strengths / gaps / fit) lands later when the chat
// agent calls `finalize_dossier` — that post threads under THIS one via
// the message_ts we record on prospect_sessions.
//
// Idempotency: stamps `prospect_sessions.email_notified_at` after a
// successful post. Re-triggers (resumed sessions, capture_identity calls
// that don't change the email) are no-ops.
// ---------------------------------------------------------------------------

const APP_BASE_URL =
  process.env.FRONTEND_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "https://your-app.example.com";

interface EmailSharedSessionRow {
  id: string;
  organization_id: string;
  captured_email: string | null;
  captured_name: string | null;
  captured_company: string | null;
  captured_role: string | null;
  enrichment: Record<string, unknown> | null;
  intent: string | null;
  assigned_rep_email: string | null;
  assigned_rep_user_id: string | null;
  email_notified_at: string | null;
}

function buildEmailSharedBlocks(args: {
  email: string;
  name: string | null;
  company: string | null;
  industry: string | null;
  size: string | null;
  role: string | null;
  intent: string | null;
  assignedRepEmail: string | null;
  sessionId: string;
}): { text: string; blocks: Record<string, unknown>[] } {
  const headlineCompanyBits: string[] = [];
  if (args.company) headlineCompanyBits.push(args.company);
  if (args.industry) headlineCompanyBits.push(args.industry);
  if (args.size) headlineCompanyBits.push(args.size);

  // Build a single sub-line of "Acme · FinTech · 11-50" — only the bits
  // we have, joined with middle-dots so the message reads cleanly even
  // when enrichment was thin.
  const companyLine =
    headlineCompanyBits.length > 0 ? headlineCompanyBits.join(" · ") : null;

  const headline = args.name
    ? `*${args.name}* just shared their email`
    : `New prospect email`;

  const bodyLines: string[] = [`📧 ${args.email}`];
  if (companyLine) bodyLines.push(`🏢 ${companyLine}`);
  if (args.role) bodyLines.push(`🪪 ${args.role}`);
  if (args.assignedRepEmail) bodyLines.push(`🎯 Assigned to ${args.assignedRepEmail}`);

  const blocks: Record<string, unknown>[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `📩 ${headline}\n${bodyLines.join("\n")}` },
    },
  ];

  if (args.intent) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*What they typed*\n_${args.intent.replace(/\n+/g, " ").slice(0, 280)}_`,
      },
    });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Open transcript", emoji: true },
        url: `${APP_BASE_URL}/automation?prospect_session=${args.sessionId}`,
      },
    ],
  });

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "_The qualified dossier will thread under this message once the agent has enough._",
      },
    ],
  });

  // Fallback text shows up in notifications and accessibility tooling.
  const text = args.name
    ? `📩 ${args.name} just shared their email — ${args.email}${companyLine ? ` · ${companyLine}` : ""}`
    : `📩 New prospect email — ${args.email}${companyLine ? ` · ${companyLine}` : ""}`;

  return { text, blocks };
}

export async function sendEmailSharedToSlack(args: {
  sessionId: string;
}): Promise<void> {
  const supabase = getSupabaseAdmin();

  const { data: row, error: rowErr } = (await supabase
    .from("prospect_sessions")
    .select(
      "id, organization_id, captured_email, captured_name, captured_company, captured_role, enrichment, intent, assigned_rep_email, assigned_rep_user_id, email_notified_at",
    )
    .eq("id", args.sessionId)
    .maybeSingle()) as {
    data: EmailSharedSessionRow | null;
    error: { message: string } | null;
  };

  if (rowErr || !row) {
    log.warn(
      { err: rowErr, sessionId: args.sessionId },
      "Email-shared post: session not found",
    );
    return;
  }

  if (!row.captured_email) {
    log.info(
      { sessionId: args.sessionId },
      "Email-shared post: skipped (no captured_email yet)",
    );
    return;
  }

  if (row.email_notified_at) {
    log.info(
      { sessionId: args.sessionId, notifiedAt: row.email_notified_at },
      "Email-shared post: already sent for this session — skipping",
    );
    return;
  }

  const target = await resolveNotificationTarget(row.organization_id, row.assigned_rep_user_id);
  if (!target) return;

  // Pull industry/size out of the cached enrichment payload — same
  // shape the dossier post reads, but we don't depend on a dossier row
  // existing yet (the lean post fires BEFORE full qualification).
  const enrichment = (row.enrichment ?? {}) as {
    company?: { industry?: string | null; size?: string | null } | null;
  };

  const { text, blocks } = buildEmailSharedBlocks({
    email: row.captured_email,
    name: row.captured_name,
    company: row.captured_company,
    industry: enrichment.company?.industry ?? null,
    size: enrichment.company?.size ?? null,
    role: row.captured_role,
    intent: row.intent,
    assignedRepEmail: row.assigned_rep_email,
    sessionId: row.id,
  });

  const posted = await sendSlackBlockMessage(
    target.botToken,
    target.channelId,
    text,
    blocks,
    undefined,
    target.teamId,
  );

  if (!posted.ok || !posted.ts || !posted.channel) {
    log.error(
      {
        sessionId: args.sessionId,
        organizationId: row.organization_id,
        error: posted.error,
      },
      "Slack chat.postMessage failed for email-shared notification",
    );
    return;
  }

  // Stamp success on the session row. Two reasons:
  //   1. Idempotency — second-trigger calls (e.g. capture_identity
  //      firing on an already-form-submitted session) skip.
  //   2. The qualified-dossier post later reads (channel_id, ts) and
  //      uses them as thread_ts so both messages live in one thread.
  const { error: stampErr } = await supabase
    .from("prospect_sessions")
    .update({
      email_notified_at: new Date().toISOString(),
      email_slack_channel_id: posted.channel,
      email_slack_message_ts: posted.ts,
    })
    .eq("id", args.sessionId);

  if (stampErr) {
    log.warn(
      { err: stampErr, sessionId: args.sessionId },
      "Email-shared post: failed to stamp idempotency markers (post landed; future calls may duplicate)",
    );
  }
}

/**
 * Read the email-shared message coordinates back from a session so the
 * qualified-dossier post can thread under the original notification.
 * Returns null if no email-shared post was ever sent (rare — would
 * mean dossier finalize ran without an email capture, which is
 * impossible given the chat agent's tool gating).
 */
export async function getEmailSharedThreadAnchor(
  sessionId: string,
): Promise<{ channelId: string; ts: string } | null> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("prospect_sessions")
    .select("email_slack_channel_id, email_slack_message_ts")
    .eq("id", sessionId)
    .maybeSingle();
  if (!data?.email_slack_channel_id || !data?.email_slack_message_ts) {
    return null;
  }
  return {
    channelId: data.email_slack_channel_id,
    ts: data.email_slack_message_ts,
  };
}

// ---------------------------------------------------------------------------
// Unified prospect notification — single entry point for both chat-dossier
// and email-agent post-send notifications.
//
// Resolves the org-configured destination (channel vs DM-to-rep), threads
// under any existing email-shared anchor if a prospect session exists, and
// posts the notification blocks.
// ---------------------------------------------------------------------------

export interface PostProspectNotificationArgs {
  organizationId: string;
  /** Sales Agent user ID of the rep (used for dm_to_rep resolution) */
  repUserId?: string | null;
  /** Prospect session ID — used to thread under an existing email-shared notification */
  sessionId?: string | null;
  /** Fallback text for notifications / accessibility */
  text: string;
  /** Slack Block Kit blocks */
  blocks: Record<string, unknown>[];
}

/**
 * Post a prospect-related notification through the unified delivery path.
 *
 * Used by both the chat dossier and the email agent so that all prospect
 * notifications honour the org-configured destination and thread together
 * under the email-shared anchor when one exists.
 *
 * Returns the posted message coordinates or null on failure/skip.
 */
export async function postProspectNotification(
  args: PostProspectNotificationArgs,
): Promise<{ channelId: string; ts: string } | null> {
  const target = await resolveNotificationTarget(args.organizationId, args.repUserId);
  if (!target) return null;

  // Thread under email-shared notification if a session exists
  let threadChannel = target.channelId;
  let threadTs: string | undefined;

  if (args.sessionId) {
    const anchor = await getEmailSharedThreadAnchor(args.sessionId);
    if (anchor) {
      threadChannel = anchor.channelId;
      threadTs = anchor.ts;
    }
  }

  const posted = await sendSlackBlockMessage(
    target.botToken,
    threadChannel,
    args.text,
    args.blocks,
    threadTs,
    target.teamId,
  );

  if (!posted.ok || !posted.ts || !posted.channel) {
    log.error(
      { organizationId: args.organizationId, error: posted.error },
      "postProspectNotification: Slack chat.postMessage failed",
    );
    return null;
  }

  return { channelId: posted.channel, ts: posted.ts };
}

/**
 * Post a thread reply on the dossier card when the prospect clicks accept on
 * a click-through ToS / MSA. Best-effort — silently no-ops if the dossier
 * has no Slack post yet (acceptance happened before the dossier was finalized,
 * which would be unusual but not impossible).
 */
export async function postTermsAcceptanceToSlack(
  dossier: ProspectDossier,
  termsVersion: string,
): Promise<void> {
  if (!dossier.slackChannelId || !dossier.slackMessageTs) {
    log.info(
      { dossierId: dossier.id },
      "Skipping Slack terms-acceptance post — no dossier slack ts to thread under",
    );
    return;
  }
  const ws = await resolveWorkspace(dossier.organizationId);
  if (!ws) return;

  const text = `:white_check_mark: Prospect accepted terms (v${termsVersion}) — ${
    dossier.contactName ?? dossier.contactEmail ?? "prospect"
  }`;

  try {
    await sendSlackMessage(
      ws.botToken,
      dossier.slackChannelId,
      text,
      dossier.slackMessageTs,
      ws.teamId,
    );
  } catch (err) {
    log.warn({ err, dossierId: dossier.id }, "Slack terms-acceptance post failed");
  }
}
