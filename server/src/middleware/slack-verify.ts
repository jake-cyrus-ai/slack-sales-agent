import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ component: 'slack-verify' });

/**
 * Express middleware that verifies Slack request signatures (HMAC-SHA256).
 * Ported from slack-bot-handler/index.ts:889-913.
 */
export function verifySlackSignature(req: Request, res: Response, next: NextFunction) {
  const timestamp = req.headers['x-slack-request-timestamp'] as string | undefined;
  const signature = req.headers['x-slack-signature'] as string | undefined;
  const rawBody: string | undefined = (req as any).rawBody;

  if (!timestamp || !signature || !rawBody) {
    res.status(401).json({ error: 'Missing Slack signature headers' });
    return;
  }

  // Reject requests older than 5 minutes (replay attack prevention)
  const requestTime = parseInt(timestamp, 10);
  const currentTime = Math.floor(Date.now() / 1000);
  if (Math.abs(currentTime - requestTime) > 300) {
    log.warn('Request timestamp too old');
    res.status(401).json({ error: 'Request too old' });
    return;
  }

  // Fail closed: a missing signing secret must never be treated as a valid
  // (empty-key) HMAC — an empty key still produces a deterministic digest that
  // an attacker who knows the secret is unset could forge. Reject instead.
  if (!config.slackSigningSecret) {
    log.error('SLACK_SIGNING_SECRET is not configured — rejecting Slack request');
    res.status(500).json({ error: 'Slack signing secret not configured' });
    return;
  }

  // Compute HMAC-SHA256
  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac('sha256', config.slackSigningSecret);
  hmac.update(sigBasestring);
  const computedSignature = `v0=${hmac.digest('hex')}`;

  // Timing-safe comparison
  if (
    computedSignature.length !== signature.length ||
    !crypto.timingSafeEqual(Buffer.from(computedSignature), Buffer.from(signature))
  ) {
    log.warn('Invalid signature');
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  next();
}
