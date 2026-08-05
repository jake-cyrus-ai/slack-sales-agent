/**
 * Poll Gmail Inboxes - Scheduled Vercel Workflow Function
 * 
 * Polls Gmail for new emails as a fallback when push notifications aren't working.
 * Runs every 5 minutes via Vercel Workflow cron trigger.
 * 
 * Migrated from: supabase/functions/gmail-poll-inbox
 */

import { workflow } from "../../client";
import { getSupabaseAdmin, getSupabaseForUser } from "../../utils";
import { flattenMimeParts } from "../../utils/gmail-mime";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "poll-gmail-inboxes" });

export const pollGmailInboxes = workflow.createFunction(
  { 
    id: "poll-gmail-inboxes",
    retries: 2,
  },
  { cron: "*/5 * * * *" }, // Every 5 minutes
  async ({ step }) => {
        log.info("Starting scheduled Gmail polling");

    // Step 1: Get users without active watch subscriptions or with expired watches
    const users = await step.run("get-users-to-poll", async () => {
            const supabase = getSupabaseAdmin();

      // Get users with active calendar credentials
      const { data: creds, error: credsError } = await supabase
        .from("calendar_credentials")
        .select("user_id, refresh_token_encrypted, calendar_email")
        .eq("sync_status", "active");

      if (credsError || !creds?.length) {
        log.info("No users with active credentials");
        return [];
      }

      const userIds = creds.map(c => c.user_id);

      // User-level flags (autonomous_emails lives on the profile)
      const { data: profiles } = await supabase
        .from("profiles")
        .select("user_id, feature_flags")
        .in("user_id", userIds);

      // Source of truth for (user → orgs) is organization_users. A user may belong
      // to N orgs; we poll once per user and let downstream handlers attribute
      // each ingested email via resolveOrgForUser + per-handler flag checks.
      const { data: memberships } = await supabase
        .from("organization_users")
        .select("user_id, organization_id")
        .in("user_id", userIds);

      const orgIds = [...new Set((memberships ?? []).map(m => m.organization_id).filter(Boolean) as string[])];
      const { data: orgs } = orgIds.length > 0
        ? await supabase.from("organizations").select("id, feature_flags").in("id", orgIds)
        : { data: [] };

      // Poll if the user has autonomous_emails enabled at profile level,
      // OR if ANY of their org memberships has an email-related flag enabled.
      // This is a gating decision only — downstream per-email handlers re-check
      // the flag for the attributed org before taking side effects.
      const EMAIL_ORG_FLAGS = ["email_auto_response"] as const;
      const orgFlagById = new Map<string, Record<string, any>>(
        (orgs ?? []).map(o => [o.id as string, ((o.feature_flags as any) ?? {})])
      );
      const orgsByUser = new Map<string, string[]>();
      for (const m of memberships ?? []) {
        if (!m.user_id || !m.organization_id) continue;
        const list = orgsByUser.get(m.user_id) ?? [];
        list.push(m.organization_id);
        orgsByUser.set(m.user_id, list);
      }

      const usersToProcess = creds
        .filter(c => orgsByUser.has(c.user_id))
        .map(c => ({
          userId: c.user_id,
          refreshToken: c.refresh_token_encrypted,
          calendarEmail: c.calendar_email,
          profile: profiles?.find(p => p.user_id === c.user_id),
        }))
        .filter(u => {
          const userFlags = (u.profile?.feature_flags as any) ?? {};
          if (userFlags?.autonomous_emails?.enabled === true) return true;

          const memberOrgs = orgsByUser.get(u.userId) ?? [];
          for (const orgId of memberOrgs) {
            const flags = orgFlagById.get(orgId) ?? {};
            if (EMAIL_ORG_FLAGS.some(k => flags?.[k]?.enabled === true)) return true;
          }
          return false;
        });

      log.info({ count: usersToProcess.length }, "Found users to poll");
      return usersToProcess;
    });

    if (users.length === 0) {
      return { processed: 0, message: "No users to poll" };
    }

    // Step 2: Fan out to individual polling jobs for each user.
    // organizationId is intentionally null here — pollUserInbox calls
    // resolveOrgForUser to attribute each ingested email, and each per-email
    // handler re-checks the relevant feature flag for the resolved org.
    await step.sendEvent("trigger-individual-polls", users.map(user => ({
      name: "email/poll-inbox",
      data: {
        userId: user.userId,
        organizationId: null,
      },
    })));

    return { 
      usersQueued: users.length,
      message: `Queued ${users.length} users for inbox polling`,
    };
  }
);

/**
 * Poll individual user's Gmail inbox
 * Triggered by the main polling function above
 */
export const pollUserInbox = workflow.createFunction(
  { 
    id: "poll-user-inbox",
    concurrency: 5,
    retries: 1, // Reduced retries since OAuth errors won't resolve on retry
  },
  { event: "email/poll-inbox" },
  async ({ event, step }) => {
        const { userId } = event.data;

    log.info({ userId }, "Polling inbox for user");

    try {
      // Step 1: Get user credentials and decrypt tokens
      const credentials = await step.run("get-user-credentials", async () => {
              const supabase = getSupabaseForUser(userId); // RLS-enforced; user can read own credentials

        const { data: creds, error } = await supabase
          .from("calendar_credentials")
          .select("refresh_token_encrypted, calendar_email, user_id")
          .eq("user_id", userId)
          .eq("sync_status", "active")
          .order("connected_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!creds) {
          log.info({ userId }, "No active credentials for user (likely disconnected), skipping");
          return null;
        }
        if (error) {
          log.error({ userId, err: error }, "Credential query error for user");
          throw new Error(`Credential query failed for ${userId}: ${error.message}`);
        }

        // Decrypt refresh token
        const { data: decryptedToken, error: decryptError } = await supabase.rpc(
          "decrypt_token",
          { encrypted_token: creds.refresh_token_encrypted }
        );

        if (decryptError || !decryptedToken) {
          throw new Error(`Failed to decrypt token: ${decryptError?.message}`);
        }

        return {
          refreshToken: decryptedToken,
          calendarEmail: creds.calendar_email,
        };
      });

      if (!credentials) {
        return { status: 'skipped', reason: 'no_credentials', userId };
      }

      // Step 2: Get organization ID (cached in tenant-resolver)
      const organizationId = await step.run("get-organization", async () => {
              const { resolveOrgForUser } = await import("../../utils/tenant-resolver");
        return resolveOrgForUser(userId);
      });

      // Step 3: Refresh access token
      const accessToken = await step.run("refresh-access-token", async () => {
              const clientId = process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CALENDAR_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CALENDAR_CLIENT_SECRET;

        if (!clientId || !clientSecret) {
          throw new Error("Missing Google OAuth credentials");
        }

        log.info({ userId, clientIdPrefix: clientId?.substring(0, 20) }, "Refreshing token for user");

        const response = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: credentials.refreshToken,
            grant_type: "refresh_token",
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          let errorJson;
          try {
            errorJson = JSON.parse(errorText);
          } catch {
            errorJson = { error: errorText };
          }

          log.error({ userId, status: response.status, error: errorJson, clientIdUsed: clientId?.substring(0, 20) + '...' }, "Token refresh failed for user");

          // Check if it's an invalid_client error
          if (errorJson.error === 'invalid_client') {
            throw new Error(
              `OAuth client credentials are invalid or don't match the refresh token. ` +
              `This usually means the refresh token was issued with different OAuth credentials. ` +
              `User ${userId} needs to re-authenticate with Gmail. Error: ${errorText}`
            );
          }

          throw new Error(`Failed to refresh token for user ${userId}: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        log.info({ userId }, "Successfully refreshed token for user");
        return data.access_token;
      });

      // Step 4: Get last poll timestamp
      const lastPollData = await step.run("get-last-poll-state", async () => {
              const supabase = getSupabaseForUser(userId); // RLS-enforced; user can read own poll state
        const { data: pollState } = await supabase
          .from("gmail_poll_state")
          .select("last_history_id, last_poll_at")
          .eq("user_id", userId)
          .single();

        return pollState;
      });

      // Step 5: Fetch recent messages from Gmail
      const messages = await step.run("fetch-gmail-messages", async () => {
              const sinceTime = lastPollData?.last_poll_at
          ? new Date(lastPollData.last_poll_at).getTime() / 1000
          : Date.now() / 1000 - 600; // 10 minutes ago

        const query = `in:inbox after:${Math.floor(sinceTime)}`;
        const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=10`;

        const listResponse = await fetch(listUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!listResponse.ok) {
          throw new Error(`Failed to list messages: ${listResponse.status}`);
        }

        const listData = await listResponse.json();
        return listData.messages || [];
      });

      log.info({ userId, count: messages.length }, "Found messages for user");

      // Step 6: Process each message
      const processedEmails = await step.run("process-messages", async () => {
              const supabase = getSupabaseForUser(userId); // RLS-enforced; user can read/write own emails
        const processed: Array<{
          emailId: string;
          from: string;
          subject: string;
          body: string;
          userDomain: string;
          pdfAttachments: Array<{ filename: string; mimeType: string; attachmentId: string; size: number }>;
          gmailMessageId: string;
        }> = [];

        const extractEmailAddress = (header: string): string => {
          const match = header.match(/<([^>]+)>/) || header.match(/([^\s<]+@[^\s>]+)/);
          return match ? match[1].toLowerCase() : header.toLowerCase();
        };

        const extractDomain = (email: string): string => {
          const parts = email.split("@");
          return parts.length === 2 ? parts[1].toLowerCase() : "";
        };

        const decodeBase64 = (str: string): string => {
          const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
          return Buffer.from(base64, "base64").toString("utf-8");
        };

        const userDomain = extractDomain(credentials.calendarEmail);

        // --- Batch deduplication: single query for all message IDs ---
        const allMessageIds = messages.map((m: any) => m.id);
        const { data: existingRows } = await supabase
          .from("incoming_emails")
          .select("gmail_message_id")
          .in("gmail_message_id", allMessageIds);

        const alreadySeen = new Set(
          (existingRows ?? []).map((r: any) => r.gmail_message_id)
        );
        const newMessages = messages.filter((m: any) => !alreadySeen.has(m.id));

        log.info(
          { userId, total: messages.length, alreadySeen: alreadySeen.size, toFetch: newMessages.length },
          "Dedup complete, fetching new messages"
        );

        // --- Parallel Gmail API calls for full message content ---
        const fetchResults = await Promise.allSettled(
          newMessages.map(async (msg: any) => {
            const messageResponse = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            if (!messageResponse.ok) {
              throw new Error(`Gmail fetch failed for ${msg.id}: ${messageResponse.status}`);
            }
            return { msgId: msg.id, message: await messageResponse.json() };
          })
        );

        // Collect successfully fetched messages
        const fetchedMessages: Array<{ msgId: string; message: any }> = [];
        for (const result of fetchResults) {
          if (result.status === "fulfilled") {
            fetchedMessages.push(result.value);
          } else {
            log.warn({ err: result.reason }, "Failed to fetch individual Gmail message");
          }
        }

        // --- Sequential inserts (preserves per-row error handling) ---
        for (const { msgId, message } of fetchedMessages) {
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

          // Skip internal emails
          if (fromDomain === userDomain || fromEmail === credentials.calendarEmail.toLowerCase()) {
            continue;
          }

          // Extract body
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
          extractBody(message.payload);

          // Insert incoming email
          const { data: insertedEmail, error: insertError } = await supabase
            .from("incoming_emails")
            .insert({
              user_id: userId,
              organization_id: organizationId,
              gmail_message_id: msgId,
              gmail_thread_id: message.threadId,
              from_email: fromEmail,
              from_name: fromHeader.replace(/<[^>]+>/, "").trim() || fromEmail,
              from_domain: fromDomain,
              to_email: credentials.calendarEmail,
              subject: subject || "(No Subject)",
              body_text: bodyText,
              body_html: bodyHtml,
              snippet: message.snippet || "",
              received_at: date ? new Date(date).toISOString() : new Date().toISOString(),
              has_attachments: (message.payload?.parts || []).some((p: any) => p.filename?.length > 0),
              is_reply: !!inReplyTo,
              in_reply_to: inReplyTo || null,
              message_id_header: messageIdHeader || null,
              labels: message.labelIds || [],
              status: "pending",
            })
            .select()
            .single();

          if (insertError) {
            log.error({ err: insertError }, "Failed to insert email");
            continue;
          }

          const allParts = flattenMimeParts(message.payload?.parts || []);
          const pdfAttachments = allParts
            .filter((p: any) => p.filename?.toLowerCase().endsWith('.pdf') && p.body?.attachmentId)
            .map((p: any) => ({
              filename: p.filename,
              mimeType: p.mimeType || 'application/pdf',
              attachmentId: p.body.attachmentId,
              size: p.body.size || 0,
            }));

          processed.push({
            emailId: insertedEmail.id,
            from: fromEmail,
            subject: subject || "(No Subject)",
            body: bodyText || bodyHtml || message.snippet || "",
            userDomain,
            pdfAttachments,
            gmailMessageId: msgId,
          });
        }

        return processed;
      });

      // Step 7: Auto-triage — label and prioritize emails before qualification
      const triageResults = await step.run("auto-triage-emails", async () => {
              if (processedEmails.length === 0) return { triaged: 0 };

        const supabase = getSupabaseForUser(userId); // RLS-enforced for user/org data

        // Check org feature flags for auto-triage
        let autoTriageEnabled = false;
        if (organizationId) {
          const { data: org } = await supabase
            .from("organizations")
            .select("feature_flags")
            .eq("id", organizationId)
            .single();

          const flags = (org?.feature_flags as any)?.email_auto_response;
          autoTriageEnabled = flags?.auto_triage_enabled === true;
        }

        if (!autoTriageEnabled) {
          return { triaged: 0, reason: "auto_triage_not_enabled" };
        }

        // Fast heuristic triage — assign priority and labels without LLM
        let triaged = 0;
        for (const email of processedEmails) {
          const subjectLower = email.subject.toLowerCase();
          const bodyLower = email.body.substring(0, 500).toLowerCase();
          const combined = `${subjectLower} ${bodyLower}`;

          let priority: "high" | "medium" | "low" = "medium";
          const labels: string[] = [];

          // High priority signals
          if (/\b(urgent|asap|immediately|critical|deadline)\b/.test(combined)) {
            priority = "high";
            labels.push("urgent");
          }
          if (/\b(pricing|quote|proposal|contract|invoice)\b/.test(combined)) {
            priority = "high";
            labels.push("deal_related");
          }
          if (/\b(demo|trial|sign up|onboard)\b/.test(combined)) {
            priority = "high";
            labels.push("new_opportunity");
          }

          // Low priority signals
          if (/\b(newsletter|unsubscribe|digest|weekly update)\b/.test(combined)) {
            priority = "low";
            labels.push("newsletter");
          }
          if (/\b(no-?reply|noreply|do-?not-?reply)\b/.test(email.from)) {
            priority = "low";
            labels.push("automated");
          }
          if (/\b(out of office|ooo|auto-?reply|automatic reply)\b/.test(combined)) {
            priority = "low";
            labels.push("auto_reply");
          }

          // Meeting-related
          if (/\b(meeting|calendar|invite|schedule|reschedule)\b/.test(combined)) {
            labels.push("meeting_related");
          }

          // Update the incoming email with triage data
          await supabase
            .from("incoming_emails")
            .update({
              priority,
              triage_labels: labels,
              triaged_at: new Date().toISOString(),
            })
            .eq("id", email.emailId);

          triaged++;
        }

        return { triaged, reason: "auto_triaged" };
      });

      log.info({ userId, triaged: triageResults.triaged }, "Auto-triaged emails for user");

      // Step 8: Trigger qualification for processed emails
      if (processedEmails.length > 0) {
        await step.sendEvent("trigger-qualification", processedEmails.map(email => ({
          name: "email/qualify",
          data: {
            userId,
            // Must be the Gmail message ID — email-response-agent looks the
            // row up via incoming_emails.gmail_message_id. email.emailId is
            // the Postgres UUID and would 404 the lookup.
            messageId: email.gmailMessageId,
            from: email.from,
            subject: email.subject,
            body: email.body,
            userDomain: email.userDomain,
            organizationId,
          },
        })));
      }

      // Step 9: Update poll state
      await step.run("update-poll-state", async () => {
              const supabase = getSupabaseForUser(userId); // RLS-enforced
        await supabase
          .from("gmail_poll_state")
          .upsert({
            user_id: userId,
            last_poll_at: new Date().toISOString(),
          }, { onConflict: "user_id" });
      });

      return { 
        processed: processedEmails.length,
        userId,
        status: 'success',
      };
    } catch (error: any) {
      log.error({ userId, err: error }, "Error polling inbox for user");

      // Handle OAuth errors by marking credentials as needing reauth
      if (error.message?.includes('invalid_client') || error.message?.includes('invalid_grant')) {
        await step.run("mark-credentials-invalid", async () => {
                const supabase = getSupabaseForUser(userId); // RLS-enforced; user can update own credentials

          // Update credential status to indicate reauth needed
          await supabase
            .from("calendar_credentials")
            .update({ 
              sync_status: "auth_required",
              last_error: error.message,
              last_error_at: new Date().toISOString(),
            })
            .eq("user_id", userId);

          log.info({ userId }, "Marked credentials as requiring re-authentication for user");
        });

        return {
          status: 'auth_required',
          userId,
          error: 'User needs to re-authenticate with Gmail',
        };
      }

      // For other errors, throw to trigger retry
      throw error;
    }
  }
);
