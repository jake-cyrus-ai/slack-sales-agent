/**
 * Webhook Signature Verification Utilities
 * 
 * Provides secure verification for Gmail (Google Pub/Sub) and Slack webhooks
 */

import crypto from "crypto";
import type { Request } from "express";
import { OAuth2Client } from "google-auth-library";
import { logger } from "./lib/logger";

const googleAuthClient = new OAuth2Client();

/**
 * Verify Slack webhook signature
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackSignature(req: Request, rawBody?: string): boolean {
  try {
    const signature = req.headers['x-slack-signature'] as string;
    const timestamp = req.headers['x-slack-request-timestamp'] as string;
    const signingSecret = process.env.SLACK_SIGNING_SECRET;

    if (!signature || !timestamp || !signingSecret) {
      logger.warn('[webhook-verify] Missing Slack signature headers or secret');
      return false;
    }

    // Prevent replay attacks - reject requests older than 5 minutes
    const currentTime = Math.floor(Date.now() / 1000);
    if (Math.abs(currentTime - parseInt(timestamp)) > 300) {
      logger.warn('[webhook-verify] Slack request timestamp too old');
      return false;
    }

    // Compute signature
    // For interactivity payloads (form-encoded), use the raw body if provided
    // Otherwise, stringify the JSON body
    const bodyString = rawBody || JSON.stringify(req.body);
    const sigBasestring = `v0:${timestamp}:${bodyString}`;
    const hmac = crypto.createHmac('sha256', signingSecret);
    hmac.update(sigBasestring);
    const computedSignature = `v0=${hmac.digest('hex')}`;

    // Use timing-safe comparison to prevent timing attacks
    const isValid = crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(computedSignature)
    );

    if (!isValid) {
      logger.warn('[webhook-verify] Slack signature verification failed');
    }

    return isValid;
  } catch (error) {
    logger.error({ err: error }, "[webhook-verify] Slack signature verification error");
    return false;
  }
}

/**
 * Verify Google Pub/Sub webhook signature (JWT token)
 * https://cloud.google.com/pubsub/docs/push#authentication_and_authorization
 *
 * Uses google-auth-library to verify the JWT against Google's public keys,
 * validate the issuer, audience, and expiration.
 */
export async function verifyGmailSignature(req: Request): Promise<boolean> {
  try {
    const authHeader = req.headers['authorization'] as string;

    // In development, allow requests without an auth header
    if (!authHeader) {
      if (process.env.NODE_ENV === 'development') {
        logger.warn('[webhook-verify] Gmail webhook: No authorization header (dev mode, allowing)');
        return true;
      }
      logger.warn('[webhook-verify] Gmail webhook: No authorization header');
      return false;
    }

    // Extract JWT token from "Bearer <token>"
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    // Expected audience — typically the service account email that Google Pub/Sub
    // uses to sign push-notification JWTs. If not configured, skip audience check.
    const expectedAudience = process.env.GOOGLE_PUBSUB_AUDIENCE || undefined;

    // verifyIdToken fetches Google's public keys, verifies the signature,
    // checks expiration, and optionally validates the audience claim.
    const ticket = await googleAuthClient.verifyIdToken({
      idToken: token,
      audience: expectedAudience,
    });

    const payload = ticket.getPayload();
    if (!payload) {
      logger.warn('[webhook-verify] Gmail webhook: Empty token payload after verification');
      return false;
    }

    // Verify issuer
    if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
      logger.warn({ iss: payload.iss }, '[webhook-verify] Gmail webhook: Invalid issuer');
      return false;
    }

    return true;
  } catch (error) {
    logger.error({ err: error }, '[webhook-verify] Gmail signature verification error');
    return false;
  }
}

/**
 * Validate Gmail webhook payload structure
 */
export function validateGmailPayload(body: any): boolean {
  if (!body || typeof body !== 'object') {
    return false;
  }

  // Check for required fields
  if (!body.message || !body.message.data) {
    logger.warn('[webhook-verify] Gmail payload missing message.data');
    return false;
  }

  // Validate base64 encoding
  try {
    const decoded = Buffer.from(body.message.data, 'base64').toString();
    const message = JSON.parse(decoded);
    
    if (!message.emailAddress || !message.historyId) {
      logger.warn('[webhook-verify] Gmail message missing required fields');
      return false;
    }
    
    return true;
  } catch (error) {
    logger.warn('[webhook-verify] Invalid Gmail payload format');
    return false;
  }
}

/**
 * Validate Slack webhook payload structure
 */
export function validateSlackPayload(body: any): boolean {
  if (!body || typeof body !== 'object') {
    return false;
  }

  // Check for required fields based on event type
  if (!body.type) {
    logger.warn('[webhook-verify] Slack payload missing type');
    return false;
  }

  // URL verification has challenge
  if (body.type === 'url_verification' && !body.challenge) {
    logger.warn('[webhook-verify] Slack url_verification missing challenge');
    return false;
  }

  return true;
}
