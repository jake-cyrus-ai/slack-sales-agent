import { Router } from 'express';
import { verifySlackSignature } from '../middleware/slack-verify.js';
import { processMessage } from '../slack/handler.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ component: 'slack-events' });

export const slackEventsRouter = Router();

// All Slack event routes require signature verification
slackEventsRouter.use(verifySlackSignature);

/**
 * POST /slack/events — Slack Events API webhook receiver.
 * Handles url_verification challenge and event_callback payloads.
 */
slackEventsRouter.post('/events', (req, res) => {
  const body = req.body;

  // URL verification challenge (Slack setup)
  if (body.type === 'url_verification') {
    res.json({ challenge: body.challenge });
    return;
  }

  // Event callback
  if (body.type === 'event_callback') {
    // Respond 200 immediately so Slack doesn't retry
    res.status(200).json({ ok: true });

    const event = body.event;
    if (!event) return;

    // Only handle app_mention and DM messages
    const isAppMention = event.type === 'app_mention';
    const isDM = event.type === 'message' && event.channel_type === 'im';

    if (!isAppMention && !isDM) return;

    // Ignore bot messages to prevent loops
    if (event.bot_id || event.subtype === 'bot_message') return;

    // Ignore message_changed / message_deleted subtypes
    if (event.subtype) return;

    const text = event.text || '';
    const slackUserId = event.user;
    const channelId = event.channel;
    // For threaded messages, use thread_ts; otherwise use the message ts
    const threadTs = event.thread_ts || event.ts;
    const teamId = body.team_id;

    // Process asynchronously
    processMessage({
      text,
      slackUserId,
      channelId,
      threadTs,
      teamId,
    }).catch((err) => {
      log.error({ err }, 'Async processing error');
    });

    return;
  }

  // Unknown event type
  res.status(200).json({ ok: true });
});
