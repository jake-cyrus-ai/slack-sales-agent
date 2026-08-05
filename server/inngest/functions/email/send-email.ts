/**
 * Send Email Inngest Function
 * 
 * Sends emails via Gmail API using OAuth credentials.
 * Supports sending as user or as Sales Agent (organization email).
 * Migrated from Supabase Edge Functions to Inngest.
 */

import { inngest } from "../../client";
import { getSupabaseAdmin, getSupabaseForUser, refreshAccessToken } from "../../utils";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "send-email" });

export const sendEmail = inngest.createFunction(
  { 
    id: "send-email",
    retries: 2,
  },
  { event: "email/send" },
  async ({ event, step }) => {
    const {
      to,
      subject,
      body,
      userId,
      replyToMessageId,
      threadId,
      previousReferences,
      sendAs = "user",
      replyToEmail,
      gmailMessageId,
      cc,
      htmlBody,
      skipSignature,
    } = event.data;

    // Validate inputs
    if (!to || !subject || !body) {
      throw new Error("Missing required fields: to, subject, body");
    }

    if (!["user", "agent"].includes(sendAs)) {
      throw new Error("Invalid sendAs value. Must be 'user' or 'agent'");
    }

    log.info({ to, userId, sendAs }, "Sending email");

    // Step 1: Get sender credentials
    const senderInfo = await step.run("get-sender-credentials", async () => {
      const userSupabase = getSupabaseForUser(userId); // RLS-enforced for user/org data
      const adminSupabase = getSupabaseAdmin(); // only for agent_email_credentials (service-role-only)
      let refreshToken: string;
      let senderEmail: string;
      let senderName: string | undefined;
      let replyToHeader: string | undefined;

      // Fetch profile and signature preferences for all send modes
      const { data: profile } = await userSupabase
        .from("profiles")
        .select("first_name, last_name, title, email")
        .eq("user_id", userId)
        .single();

      const { data: userCtx } = await userSupabase
        .from("user_context")
        .select("signature_preferences")
        .eq("user_id", userId)
        .single();

      const sigPrefs = userCtx?.signature_preferences as {
        sign_off?: string;
        use_first_name?: boolean;
        include_title?: boolean;
      } | null;

      if (sendAs === "agent") {
        // Get user's organization — user can read their own org membership via RLS
        const { data: orgUser, error: orgError } = await userSupabase
          .from("organization_users")
          .select("organization_id")
          .eq("user_id", userId)
          .single();

        if (orgError || !orgUser) {
          throw new Error("User not associated with an organization");
        }

        // Check if this user IS the Autonomous agent (use calendar_credentials for OAuth)
        const { data: org } = await adminSupabase
          .from("organizations")
          .select("autonomous_agent_user_id")
          .eq("id", orgUser.organization_id)
          .single();

        // Get Sales Agent display name from agent_email_credentials
        const { data: agentDisplayCreds } = await adminSupabase
          .from("agent_email_credentials")
          .select("display_name")
          .eq("organization_id", orgUser.organization_id)
          .maybeSingle();

        if (org?.autonomous_agent_user_id === userId) {
          // Autonomous agent: use adminSupabase — the calling user may be a different
          // rep, so RLS on userSupabase won't have access to the agent's creds.
          const { data: credentials } = await adminSupabase
            .from("calendar_credentials")
            .select("refresh_token_encrypted, calendar_email, sync_status")
            .eq("user_id", userId)
            .order("connected_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (!credentials || credentials.sync_status === "expired") {
            throw new Error("Autonomous agent Gmail credentials expired");
          }
          const { data: decryptedRefreshToken } = await adminSupabase.rpc(
            "decrypt_token",
            { encrypted_token: credentials.refresh_token_encrypted }
          );
          if (!decryptedRefreshToken) throw new Error("Failed to decrypt Autonomous agent credentials");

          refreshToken = decryptedRefreshToken;
          senderEmail = credentials.calendar_email;
          senderName = agentDisplayCreds?.display_name || "Sales Agent";
          replyToHeader = replyToEmail || profile?.email || undefined;

          log.info({ senderEmail, replyToHeader }, "Sending as Sales Agent (Autonomous agent path)");
        } else {
          // Legacy Sales Agent path: use agent_email_credentials with decrypt_slack_token
          const { data: agentCredentials, error: agentError } = await adminSupabase
            .from("agent_email_credentials")
            .select("email_address, refresh_token, display_name, is_active")
            .eq("organization_id", orgUser.organization_id)
            .single();

          if (agentError || !agentCredentials) {
            throw new Error("Sales Agent email not configured for this organization");
          }

          if (!agentCredentials.is_active) {
            throw new Error("Sales Agent email is inactive");
          }

          // Guard against Autonomous sentinel token leaking into legacy path
          if (agentCredentials.refresh_token === "__autonomous_agent__") {
            throw new Error(
              "Org uses Autonomous agent path — legacy Sales Agent send not available. Designate the Autonomous agent user or configure separate agent_email_credentials."
            );
          }

          // Decrypt refresh token if encrypted (SECURITY DEFINER RPC, works with admin client)
          const encryptionKey = process.env.SLACK_TOKEN_ENCRYPTION_KEY;
          let decryptedRefreshToken = agentCredentials.refresh_token;

          if (encryptionKey && !agentCredentials.refresh_token.startsWith("1//")) {
            const { data: decrypted } = await adminSupabase.rpc("decrypt_slack_token", {
              encrypted_token: agentCredentials.refresh_token,
              encryption_key: encryptionKey,
            });
            if (decrypted) {
              decryptedRefreshToken = decrypted;
            }
          }

          refreshToken = decryptedRefreshToken;
          senderEmail = agentCredentials.email_address;
          senderName = agentCredentials.display_name || "Sales Agent";

          // Set Reply-To header
          if (replyToEmail) {
            replyToHeader = replyToEmail;
          } else {
            replyToHeader = profile?.email || undefined;
          }

          log.info({ senderEmail, replyToHeader }, "Sending as Sales Agent (legacy path)");
        }
      } else {
        // Get user's calendar credentials — user can read their own via RLS
        const { data: credentials, error: credsError } = await userSupabase
          .from("calendar_credentials")
          .select("refresh_token_encrypted, calendar_email, sync_status")
          .eq("user_id", userId)
          .single();

        if (credsError || !credentials) {
          throw new Error("Gmail not connected");
        }

        if (credentials.sync_status === "expired") {
          throw new Error("Google credentials expired");
        }

        // Decrypt refresh token (SECURITY DEFINER RPC, works with user client)
        const { data: decryptedRefreshToken, error: decryptError } = await userSupabase.rpc(
          "decrypt_token",
          { encrypted_token: credentials.refresh_token_encrypted }
        );

        if (decryptError || !decryptedRefreshToken) {
          throw new Error("Failed to decrypt Google credentials");
        }

        refreshToken = decryptedRefreshToken;
        senderEmail = credentials.calendar_email;
        senderName = profile
          ? `${profile.first_name || ""} ${profile.last_name || ""}`.trim()
          : undefined;

        log.info({ senderEmail }, "Sending as user");
      }

      // Build email signature from user preferences
      let emailSignature = "";
      const fullName = profile
        ? `${profile.first_name || ""} ${profile.last_name || ""}`.trim()
        : undefined;

      if (sigPrefs || fullName) {
        const signOff = sigPrefs?.sign_off || "Best";
        const useFirstName = sigPrefs?.use_first_name ?? true;
        const includeTitle = sigPrefs?.include_title ?? false;

        const sigName = useFirstName
          ? (profile?.first_name || fullName || "")
          : (fullName || "");
        const sigTitle = includeTitle && profile?.title ? profile.title : "";

        emailSignature = `\n\n${signOff},\n${sigName}`;
        if (sigTitle) {
          emailSignature += `\n${sigTitle}`;
        }
      }

      return { refreshToken, senderEmail, senderName, replyToHeader, emailSignature };
    });

    // Step 2: Get fresh access token
    const accessToken = await step.run("refresh-access-token", async () => {
      return await refreshAccessToken(senderInfo.refreshToken);
    });

    // Step 3: Look up thread ID if needed
    const actualThreadId = await step.run("lookup-thread", async () => {
      if (gmailMessageId && accessToken) {
        try {
          const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailMessageId}?format=minimal`;
          const msgResponse = await fetch(msgUrl, {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(15_000),
          });

          if (msgResponse.ok) {
            const msgData = await msgResponse.json();
            log.info({ threadId: msgData.threadId }, "Found thread from Gmail API");
            return msgData.threadId;
          }
        } catch (error) {
          log.error({ err: error }, "Thread lookup failed");
        }
      }
      return threadId;
    });

    // Step 4: Send email via Gmail API
    const result = await step.run("send-via-gmail", async () => {
      // Prepare subject with Re: prefix for replies
      let finalSubject = subject;
      if (replyToMessageId && !subject.toLowerCase().startsWith("re:")) {
        finalSubject = `Re: ${subject}`;
      }

      // RFC 2047 encoded-word for non-ASCII subjects — without this, chars
      // like "↔" mojibake in the recipient's client.
      // eslint-disable-next-line no-control-regex
      const encodedSubject = /^[\x00-\x7F]*$/.test(finalSubject)
        ? finalSubject
        : `=?UTF-8?B?${Buffer.from(finalSubject, "utf-8").toString("base64")}?=`;

      // Agent-voiced emails (handoff intros/debriefs) sign themselves off as
      // Sales Agent — skipSignature suppresses the sender's personal profile sig.
      const signature = skipSignature ? "" : (senderInfo.emailSignature || "");
      const plainBody = body + signature;

      // Build email headers
      const emailHeaders = [
        `From: ${senderInfo.senderName ? `${senderInfo.senderName} <${senderInfo.senderEmail}>` : senderInfo.senderEmail}`,
        `To: ${to}`,
        `Subject: ${encodedSubject}`,
        `MIME-Version: 1.0`,
      ];

      // Optional CC (used for handoff intros: To=rep, Cc=customer).
      if (cc && cc.length > 0) {
        emailHeaders.splice(2, 0, `Cc: ${cc.join(", ")}`);
      }

      // Add Reply-To header for Sales Agent mode
      if (senderInfo.replyToHeader) {
        emailHeaders.push(`Reply-To: ${senderInfo.replyToHeader}`);
      }

      // Add threading headers
      if (replyToMessageId) {
        const normalizedMsgId = replyToMessageId.replace(/^<|>$/g, "");
        emailHeaders.push(`In-Reply-To: <${normalizedMsgId}>`);
        emailHeaders.push(`References: <${normalizedMsgId}>`);

        log.info({ inReplyTo: normalizedMsgId, threadId: actualThreadId }, "Threading headers added");
      }

      // Body: multipart/alternative when an HTML part is provided (plain-text
      // fallback + HTML), otherwise plain text.
      let rawMessage: string;
      if (htmlBody) {
        const boundary = `agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
        emailHeaders.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
        rawMessage = [
          ...emailHeaders,
          "",
          `--${boundary}`,
          `Content-Type: text/plain; charset=utf-8`,
          "",
          plainBody,
          `--${boundary}`,
          `Content-Type: text/html; charset=utf-8`,
          "",
          htmlBody,
          `--${boundary}--`,
        ].join("\r\n");
      } else {
        emailHeaders.push(`Content-Type: text/plain; charset=utf-8`);
        rawMessage = [...emailHeaders, "", plainBody].join("\r\n");
      }

      // Base64url encode
      const encodedMessage = Buffer.from(rawMessage)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      // Send via Gmail API
      const requestBody: any = { raw: encodedMessage };
      if (actualThreadId) {
        requestBody.threadId = actualThreadId;
        log.info({ threadId: actualThreadId }, "Including threadId in request");
      }

      const gmailResponse = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(15_000),
        }
      );

      if (!gmailResponse.ok) {
        const errorText = await gmailResponse.text();
        log.error({ errorText }, "Gmail API error");
        
        let errorMessage = `Gmail API error: ${gmailResponse.status}`;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error?.message || errorMessage;
        } catch { /* ignore JSON parse errors, fall through with default message */ }

        throw new Error(errorMessage);
      }

      const gmailResult = await gmailResponse.json();

      log.info({ messageId: gmailResult.id, threadId: gmailResult.threadId, labelIds: gmailResult.labelIds }, "Gmail API response");

      // Check threading result
      if (replyToMessageId) {
        if (gmailResult.threadId === gmailResult.id) {
          log.warn("Gmail created NEW thread instead of threading reply");
        } else {
          log.info("Gmail threaded the reply successfully");
        }
      }

      return {
        success: true,
        messageId: gmailResult.id,
        threadId: gmailResult.threadId,
        from: senderInfo.senderEmail,
        to,
        subject: finalSubject,
        sendAs,
        replyTo: senderInfo.replyToHeader,
      };
    });

    return result;
  }
);
