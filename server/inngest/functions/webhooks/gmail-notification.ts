/**
 * Gmail Push Notification Handler
 * 
 * Receives Gmail push notifications via Inngest events and processes new emails.
 * This function:
 * 1. Fetches user details from calendar credentials
 * 2. Retrieves new emails using Gmail History API
 * 3. Filters out internal emails (same domain)
 * 4. Fans out to email qualification for external emails
 * 
 * Event: email/notification
 * Triggered by: Gmail Pub/Sub push notifications via /api/webhooks/gmail
 */

import { inngest } from "../../client";
import { getSupabaseAdmin } from "../../utils/supabase";
import { flattenMimeParts } from "../../utils/gmail-mime";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "gmail-notification" });

/**
 * Helper: Refresh Gmail access token
 */
async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<string> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to refresh token: ${error}`);
  }

  const data = await response.json();
  return data.access_token;
}

/**
 * Helper: Extract email address from header like "Name <email@example.com>"
 */
function extractEmailAddress(header: string): string {
  const match = header.match(/<([^>]+)>/) || header.match(/([^\s<]+@[^\s>]+)/);
  return match ? match[1].toLowerCase() : header.toLowerCase();
}

/**
 * Helper: Extract domain from email address
 */
function extractDomain(email: string): string {
  const parts = email.split("@");
  return parts.length === 2 ? parts[1].toLowerCase() : "";
}

/**
 * Helper: Decode base64 string (handles URL-safe base64)
 */
function decodeBase64(str: string): string {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

/**
 * Helper: Fetch Gmail history since last known historyId
 */
async function fetchGmailHistory(
  accessToken: string,
  lastHistoryId: number
): Promise<string[]> {
  const historyUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history");
  historyUrl.searchParams.set("startHistoryId", String(lastHistoryId));
  historyUrl.searchParams.set("historyTypes", "messageAdded");
  historyUrl.searchParams.set("labelId", "INBOX");

  const historyResponse = await fetch(historyUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!historyResponse.ok) {
    if (historyResponse.status === 404) {
      // History too old, need full sync
      log.info("History too old, need full sync");
      return [];
    }
    throw new Error(`Failed to fetch history: ${historyResponse.statusText}`);
  }

  const historyData = await historyResponse.json();

  // Extract new message IDs
  const messageIds: string[] = [];
  for (const historyItem of historyData.history || []) {
    for (const added of historyItem.messagesAdded || []) {
      messageIds.push(added.message.id);
    }
  }

  return messageIds;
}

/**
 * Helper: Fetch full Gmail message details
 */
async function fetchGmailMessage(accessToken: string, messageId: string) {
  const messageResponse = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!messageResponse.ok) {
    throw new Error(`Failed to fetch message ${messageId}: ${messageResponse.statusText}`);
  }

  return await messageResponse.json();
}

/**
 * Helper: Extract email body from Gmail message payload
 */
function extractEmailBody(payload: any): { bodyText: string; bodyHtml: string } {
  let bodyText = "";
  let bodyHtml = "";

  const extractBody = (part: any) => {
    if (part.mimeType === "text/plain" && part.body?.data) {
      bodyText = decodeBase64(part.body.data);
    } else if (part.mimeType === "text/html" && part.body?.data) {
      bodyHtml = decodeBase64(part.body.data);
    } else if (part.parts) {
      for (const subPart of part.parts) {
        extractBody(subPart);
      }
    }
  };

  extractBody(payload);

  return { bodyText, bodyHtml };
}

/**
 * Main Inngest function: Handle Gmail push notifications
 */
export const handleGmailNotification = inngest.createFunction(
  { 
    id: "handle-gmail-notification",
    retries: 3,
  },
  { event: "email/notification" },
  async ({ event, step }) => {
    const { emailAddress, historyId } = event.data;

    log.info({ emailAddress, historyId }, "Processing notification");

    // Step 1: Get user credentials
    const credentials = await step.run("get-user-credentials", async () => {
      const supabase = getSupabaseAdmin();

      const { data: creds, error: credsError } = await supabase
        .from("calendar_credentials")
        .select("user_id, refresh_token_encrypted, calendar_email")
        .eq("calendar_email", emailAddress)
        .eq("sync_status", "active")
        .order("connected_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (credsError || !creds) {
        log.info({ emailAddress }, "No credentials found");
        return null;
      }

      return creds;
    });

    if (!credentials) {
      return { status: "skipped", reason: "no_credentials" };
    }

    // Step 2: Check if email auto-response is enabled
    const featureCheckResult = await step.run("check-feature-enabled", async (): Promise<{ emailAutoResponseEnabled: boolean; organizationId: string | null }> => {
      const supabase = getSupabaseAdmin();

      // Get user's organization (cached in tenant-resolver)
      const { resolveOrgForUser } = await import("../../utils/tenant-resolver");
      const organizationId = await resolveOrgForUser(credentials.user_id);

      if (!organizationId) {
        return { emailAutoResponseEnabled: false, organizationId: null };
      }

      // Check if feature is enabled
      const { data: org } = await supabase
        .from("organizations")
        .select("feature_flags")
        .eq("id", organizationId)
        .maybeSingle();

      const featureFlags = org?.feature_flags || {};
      const emailAutoResponseEnabled = featureFlags.email_auto_response?.enabled || false;
      return { emailAutoResponseEnabled, organizationId };
    });

    if (!featureCheckResult.emailAutoResponseEnabled) {
      log.info({ organizationId: featureCheckResult.organizationId }, "Autonomous email disabled for org");
      return { status: "skipped", reason: "autonomous_email_disabled" };
    }

    // Step 3: Get last processed historyId
    const watchSubscription = await step.run("get-watch-subscription", async () => {
      const supabase = getSupabaseAdmin();

      const { data: watchSub } = await supabase
        .from("gmail_watch_subscriptions")
        .select("history_id")
        .eq("user_id", credentials.user_id)
        .maybeSingle();

      return { lastHistoryId: watchSub?.history_id || 0 };
    });

    // Step 4: Refresh access token and fetch new emails
    const newEmails = await step.run("fetch-new-emails", async () => {
      const googleClientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
      const googleClientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;

      if (!googleClientId || !googleClientSecret) {
        throw new Error("Google OAuth credentials not configured");
      }

      // Decrypt refresh token
      const supabase = getSupabaseAdmin();
      const { data: decrypted, error: decryptError } = await supabase.rpc("decrypt_token", {
        encrypted_token: credentials.refresh_token_encrypted,
      });

      if (decryptError || !decrypted) {
        log.error({ err: decryptError, emailAddress }, "Failed to decrypt refresh token");
        throw new Error("Failed to decrypt refresh token");
      }

      // Refresh access token
      const accessToken = await refreshAccessToken(
        decrypted,
        googleClientId,
        googleClientSecret
      );

      // Fetch history
      const messageIds = await fetchGmailHistory(
        accessToken,
        watchSubscription.lastHistoryId
      );

      log.info({ messageCount: messageIds.length }, "Found new messages");

      // Fetch full message details for each
      const messages = [];
      for (const messageId of messageIds) {
        try {
          const message = await fetchGmailMessage(accessToken, messageId);
          messages.push(message);
        } catch (error) {
          log.error({ err: error, messageId }, "Failed to fetch message");
        }
      }

      return messages;
    });

    // Step 5: Process each new message — returns gmail IDs that were inserted
    const insertedGmailIds = await step.run("process-messages", async () => {
      const supabase = getSupabaseAdmin();
      const userDomain = extractDomain(emailAddress);
      const inserted: string[] = [];

      for (const message of newEmails) {
        try {
          // Check if already processed
          const { data: existing } = await supabase
            .from("incoming_emails")
            .select("id")
            .eq("gmail_message_id", message.id)
            .maybeSingle();

          if (existing) {
            log.info({ messageId: message.id }, "Message already processed");
            continue;
          }

          // Extract headers
          const headers = message.payload?.headers || [];
          const getHeader = (name: string) =>
            headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

          const fromHeader = getHeader("From");
          const subject = getHeader("Subject");
          const date = getHeader("Date");
          const inReplyTo = getHeader("In-Reply-To");
          const messageIdHeader = getHeader("Message-ID");

          const fromEmail = extractEmailAddress(fromHeader);
          const fromDomain = extractDomain(fromEmail);

          // Skip internal emails (same domain)
          if (fromDomain === userDomain) {
            log.info({ fromEmail }, "Skipping internal email");
            continue;
          }

          // Skip emails sent by the user themselves
          if (fromEmail === emailAddress.toLowerCase()) {
            log.info("Skipping email sent by user");
            continue;
          }

          // Extract body
          const { bodyText, bodyHtml } = extractEmailBody(message.payload);

          // Check for attachments (flatten nested MIME parts for multipart messages)
          const allParts = flattenMimeParts(message.payload?.parts || []);
          const hasAttachments = allParts.some(
            (p: any) => p.filename && p.filename.length > 0
          );
          const attachmentCount = allParts.filter(
            (p: any) => p.filename && p.filename.length > 0
          ).length;

          // Queue the email for processing
          const { error: insertError } = await supabase.from("incoming_emails").insert({
            user_id: credentials.user_id,
            organization_id: featureCheckResult.organizationId,
            gmail_message_id: message.id,
            gmail_thread_id: message.threadId,
            gmail_history_id: parseInt(historyId),
            from_email: fromEmail,
            from_name: fromHeader.replace(/<[^>]+>/, "").trim() || fromEmail,
            from_domain: fromDomain,
            to_email: emailAddress,
            subject: subject || "(No Subject)",
            body_text: bodyText,
            body_html: bodyHtml,
            snippet: message.snippet || "",
            received_at: date ? new Date(date).toISOString() : new Date().toISOString(),
            has_attachments: hasAttachments,
            attachment_count: attachmentCount,
            is_reply: !!inReplyTo,
            in_reply_to: inReplyTo || null,
            message_id_header: messageIdHeader || null,
            labels: message.labelIds || [],
            status: "pending",
          });

          if (insertError) {
            log.error({ err: insertError, messageId: message.id }, "Failed to queue message");
          } else {
            log.info({ messageId: message.id, fromEmail }, "Queued message");
            inserted.push(message.id);
          }
        } catch (msgError) {
          log.error({ err: msgError, messageId: message.id }, "Error processing message");
        }
      }

      return inserted;
    });

    // Step 6: Fan out to qualification — only for emails that were actually inserted
    const insertedSet = new Set(insertedGmailIds);
    if (featureCheckResult.emailAutoResponseEnabled && insertedSet.size > 0) {
      const qualifyEvents = newEmails
        .filter(message => insertedSet.has(message.id))
        .map(message => {
          const headers = message.payload?.headers || [];
          const getHeader = (name: string) =>
            headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

          const fromHeader = getHeader("From");
          const subject = getHeader("Subject");
          const fromEmail = extractEmailAddress(fromHeader);
          const userDomain = extractDomain(emailAddress);

          const { bodyText } = extractEmailBody(message.payload);

          return {
            name: "email/qualify" as const,
            data: {
              userId: credentials.user_id,
              messageId: message.id,
              from: fromEmail,
              subject: subject || "(No Subject)",
              body: bodyText,
              userDomain,
              organizationId: featureCheckResult.organizationId,
            },
          };
        });

      if (qualifyEvents.length > 0) {
        await step.sendEvent("trigger-qualification", qualifyEvents);
      }
    }

    // Step 7: Update last processed historyId
    await step.run("update-history-id", async () => {
      const supabase = getSupabaseAdmin();

      await supabase
        .from("gmail_watch_subscriptions")
        .update({
          history_id: parseInt(historyId),
          last_notification_at: new Date().toISOString(),
        })
        .eq("user_id", credentials.user_id);
    });

    return {
      status: "success",
      emailsProcessed: insertedGmailIds.length,
      emailAddress,
      historyId,
    };
  }
);
