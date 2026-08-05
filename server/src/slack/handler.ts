import { WebClient } from '@slack/web-api';
import { supabase } from '../lib/supabase.js';
import { config } from '../config.js';
import { resolveSlackUser } from './user-mapper.js';
import { formatMessageForSlack } from './formatter.js';
import { runSupervisor } from '../agent/supervisor.js';
import { buildPreferenceInstructions } from '../agent/system-prompt.js';
import { workflow } from '../../workflows/client.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ component: 'slack-handler' });

export interface SlackMessageInput {
  text: string;
  slackUserId: string;
  channelId: string;
  threadTs: string;
  teamId: string;
}

/**
 * In-memory per-thread lock for the direct handler path.
 *
 * The primary path (Vercel Workflow) uses Vercel Workflow's concurrency config for
 * per-thread serialization. This lock covers the direct handler used
 * by tests and the Salesforce Slack bot. Not distributed — only works
 * within a single process. For multi-instance deployments, rely on
 * the DB unique constraint as the safety net.
 */
const threadLocks = new Map<string, Promise<void>>();

/**
 * Main async message processor.
 * Ported from slack-bot-handler processMessageAsync (lines 1658-2057).
 */
export async function processMessage(input: SlackMessageInput): Promise<void> {
  const { text, slackUserId, channelId, threadTs, teamId } = input;

  // Skip if this thread is already being processed (prevents message pile-up).
  // Primary concurrency protection is via Vercel Workflow (limit: 1 per thread).
  // This lock covers the direct handler path (tests, SFDC bot) only.
  const lockKey = `${channelId}:${threadTs}`;
  const existingLock = threadLocks.get(lockKey);
  if (existingLock) {
    log.info({ lockKey }, 'Thread in progress, waiting');
    await existingLock;
  }
  let unlock!: () => void;
  threadLocks.set(lockKey, new Promise<void>((r) => { unlock = r; }));

  try {
    // 1. Look up workspace
    const { data: workspace, error: wsError } = await supabase
      .from('slack_workspaces')
      .select('*')
      .eq('team_id', teamId)
      .single();

    if (wsError || !workspace) {
      log.error({ teamId }, 'Workspace not found for team');
      return;
    }

    // 2. Use bot token from env var (avoids conflict with old Sales Agent bot's DB token)
    const botToken = config.slackBotToken;
    if (!botToken) {
      log.error('SLACK_BOT_TOKEN not set, cannot use direct handler');
      return;
    }

    const slack = new WebClient(botToken);

    // 3. Send thinking reaction
    try {
      await slack.reactions.add({ channel: channelId, name: 'thinking_face', timestamp: threadTs });
    } catch {
      // Ignore if reaction already exists
    }

    // 4. Resolve Slack user → Sales Agent user (agentUserId is the Clerk ID,
    //    organizationId is the internal org UUID).
    const userMapping = await resolveSlackUser(workspace.id, slackUserId);
    if (!userMapping) {
      await slack.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: "👋 I don't recognize your account yet. Please sign up at https://your-app.example.com and link your Slack account, then try again.",
      });
      return;
    }

    const { agentUserId, organizationId } = userMapping;

    // 4b. Fetch user profile + preferences + explicit facts in parallel
    const [{ data: profile }, { data: userPrefs }, { data: userCtx }, { data: userFacts }, { data: learnings }] = await Promise.all([
      supabase
        .from('profiles')
        .select('first_name, last_name, email, company, timezone, title')
        .eq('user_id', agentUserId)
        .single(),
      supabase
        .from('user_preferences')
        .select('preference_key, preference_value, confidence_score')
        .eq('user_id', agentUserId)
        .gte('confidence_score', 0.6),
      supabase
        .from('user_context')
        .select('*')
        .eq('user_id', agentUserId)
        .maybeSingle(),
      supabase
        .from('user_preferences')
        .select('preference_value')
        .eq('user_id', agentUserId)
        .like('preference_key', 'user_fact_%'),
      supabase
        .from('user_learnings')
        .select('learning, domain')
        .eq('user_id', agentUserId)
        .eq('status', 'active')
        .order('updated_at', { ascending: false })
        .limit(15),
    ]);

    const userName = profile
      ? `${profile.first_name || ''} ${profile.last_name || ''}`.trim()
      : null;

    const userPreferences = (userPrefs?.length || userCtx || userFacts?.length || learnings?.length)
      ? buildPreferenceInstructions(userPrefs || [], userCtx || null, userFacts || [], learnings || [])
      : null;
    const userTimezone = profile?.timezone || null;

    // 5. Get or create thread conversation (org-scoped for multi-tenant isolation)
    const conversationId = await getOrCreateConversation(
      workspace.id,
      channelId,
      threadTs,
      agentUserId,
      text,
      organizationId,
    );

    // 6. Save user message
    await supabase.from('chat_messages').insert({
      conversation_id: conversationId,
      role: 'user',
      content: text,
    });

    // 7. Load conversation history
    const { data: historyRows } = await supabase
      .from('chat_messages')
      .select('role, content')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(20);

    const conversationHistory = historyRows ? historyRows.reverse() : [];

    // 8. Run supervisor agent
    const result = await runSupervisor({
      messages: conversationHistory,
      currentMessage: text,
      userId: agentUserId,
      organizationId,
      userName,
      userEmail: profile?.email || null,
      userCompany: profile?.company || null,
      userTitle: profile?.title || null,
      slackContext: { channelId, threadTs, botToken },
      userPreferences,
      userTimezone,
    });

    // 9. Format and post response
    const blocks = formatMessageForSlack(result.response, result.sources);

    await slack.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: result.response, // Fallback for notifications
      blocks,
    });

    // 10. Save assistant message
    await supabase.from('chat_messages').insert({
      conversation_id: conversationId,
      role: 'assistant',
      content: result.response,
    });

    // 11. Remove thinking reaction
    try {
      await slack.reactions.remove({ channel: channelId, name: 'thinking_face', timestamp: threadTs });
    } catch {
      // Ignore
    }

    // 12. Memory save now handled by supervisor (universal, not Slack-only)

    // 13. Queue preference learning (debounced — runs async, skips if analyzed recently)
    workflow.send({
      name: 'learning/analyze-preferences',
      data: { userId: agentUserId },
    }).catch(() => {}); // Non-blocking
  } catch (err) {
    log.error({ err }, 'processMessage error');
  } finally {
    threadLocks.delete(lockKey);
    unlock();
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Get or create a conversation for a Slack thread.
 *
 * CONCURRENCY SAFETY:
 * Uses upsert pattern for thread mapping — if two requests race to create
 * a mapping for the same thread, the DB unique constraint on
 * (slack_workspace_id, slack_channel_id, slack_thread_ts) ensures only one wins.
 * The loser gets back the winner's conversation_id via ON CONFLICT.
 *
 * This is a safety net — the primary protection is Vercel Workflow's per-thread
 * concurrency limit (limit: 1), which serializes all messages within a thread.
 */
async function getOrCreateConversation(
  workspaceId: string,
  channelId: string,
  threadTs: string,
  agentUserId: string,
  messageText: string,
  organizationId: string | null,
): Promise<string> {
  // Fast path: check if thread already has a conversation
  const { data: existing } = await supabase
    .from('slack_thread_conversations')
    .select('conversation_id')
    .eq('slack_workspace_id', workspaceId)
    .eq('slack_channel_id', channelId)
    .eq('slack_thread_ts', threadTs)
    .maybeSingle();

  if (existing) return existing.conversation_id;

  // Create new conversation with org context for multi-tenant isolation
  const { data: conv, error } = await supabase
    .from('conversations')
    .insert({
      user_id: agentUserId,
      title: `Slack: ${messageText.substring(0, 50)}...`,
      source: 'slack',
      organization_id: organizationId,
    })
    .select()
    .single();

  if (error || !conv) throw new Error(`Failed to create conversation: ${error?.message}`);

  // Upsert thread mapping — ON CONFLICT returns existing if another request won the race
  const { data: mapping } = await supabase
    .from('slack_thread_conversations')
    .upsert(
      {
        slack_workspace_id: workspaceId,
        slack_channel_id: channelId,
        slack_thread_ts: threadTs,
        conversation_id: conv.id,
        agent_user_id: agentUserId,
      },
      { onConflict: 'slack_workspace_id,slack_channel_id,slack_thread_ts' },
    )
    .select('conversation_id')
    .single();

  return mapping?.conversation_id || conv.id;
}

