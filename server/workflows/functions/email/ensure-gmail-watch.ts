/**
 * Ensure Gmail Watch — Vercel Workflow Function
 *
 * Registers a Gmail push notification watch (users.me.watch) for a user and
 * upserts their `gmail_watch_subscriptions` row so the notification handler
 * can track historyId.
 *
 * Triggered when a user is designated as the Autonomous agent, ensuring their inbox
 * receives push notifications that feed the autonomous email pipeline.
 *
 * Event: email/ensure-gmail-watch
 */

import { FatalError } from "workflow";
import { workflow } from "../../client";
import { getSupabaseAdmin } from "../../utils/supabase";
import { getGoogleTokens } from "../../utils/google/auth-helper";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "ensure-gmail-watch" });

export const ensureGmailWatch = workflow.createFunction(
  {
    id: "ensure-gmail-watch",
    retries: 3,
  },
  { event: "email/ensure-gmail-watch" },
  async ({ event, step }) => {
        const { userId, organizationId } = event.data;

    log.info({ userId, organizationId }, "Ensuring Gmail watch for user");

    // Fail fast on missing config — retrying won't help
    const topicName = process.env.GMAIL_PUBSUB_TOPIC;
    if (!topicName) {
      throw new FatalError(
        "GMAIL_PUBSUB_TOPIC env var is required (e.g. projects/my-project/topics/gmail-notifications)"
      );
    }

    // Step 1: Check if a valid watch already exists
    const existingWatch = await step.run("check-existing-watch", async () => {
            const supabase = getSupabaseAdmin();

      const { data: watchSub } = await supabase
        .from("gmail_watch_subscriptions")
        .select("id, expiration, history_id")
        .eq("user_id", userId)
        .maybeSingle();

      if (!watchSub) return null;

      // If expiration is more than 1 hour from now, the watch is still valid
      const expiresAt = new Date(watchSub.expiration).getTime();
      const oneHourFromNow = Date.now() + 60 * 60 * 1000;

      if (expiresAt > oneHourFromNow) {
        return { valid: true, historyId: watchSub.history_id };
      }

      return { valid: false, historyId: watchSub.history_id };
    });

    if (existingWatch?.valid) {
      log.info({ userId }, "Gmail watch already active and not expiring soon");
      return { status: "already_active", userId };
    }

    // Step 2: Get fresh tokens + register watch in one step
    // (avoids stale access token if there's delay between Vercel Workflow steps)
    const watchResult = await step.run("register-gmail-watch", async () => {
            const supabase = getSupabaseAdmin();
      const googleTokens = await getGoogleTokens(supabase, userId);

      if (!googleTokens) {
        log.warn({ userId }, "No active Google tokens — user may need to re-auth");
        return null;
      }

      const response = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/watch",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${googleTokens.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            topicName,
            labelIds: ["INBOX"],
          }),
          signal: AbortSignal.timeout(15_000),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        log.error(
          { userId, status: response.status, errorText },
          "Gmail watch registration failed"
        );
        throw new Error(
          `Gmail watch registration failed: ${response.status} - ${errorText}`
        );
      }

      const data = await response.json();

      log.info(
        { userId, historyId: data.historyId, expiration: data.expiration },
        "Gmail watch registered successfully"
      );

      return {
        historyId: parseInt(data.historyId, 10),
        expiration: new Date(parseInt(data.expiration, 10)).toISOString(),
      };
    });

    if (!watchResult) {
      return { status: "skipped", reason: "no_google_tokens", userId };
    }

    // Step 3: Upsert gmail_watch_subscriptions row
    await step.run("upsert-watch-subscription", async () => {
            const supabase = getSupabaseAdmin();

      const { error: upsertErr } = await supabase
        .from("gmail_watch_subscriptions")
        .upsert(
          {
            user_id: userId,
            history_id: watchResult.historyId,
            expiration: watchResult.expiration,
            topic_name: topicName,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" }
        );

      if (upsertErr) {
        log.error({ err: upsertErr, userId }, "Failed to upsert gmail_watch_subscriptions");
        throw upsertErr;
      }

      log.info({ userId }, "gmail_watch_subscriptions row upserted");
    });

    return {
      status: "success",
      userId,
      historyId: watchResult.historyId,
      expiration: watchResult.expiration,
    };
  }
);
