/**
 * Qualify Email Agent V2 — Inngest Function
 *
 * Qualifies incoming emails before processing to filter out spam,
 * internal emails, newsletters, cold outreach TO you, and non-sales emails.
 *
 * V2 improvements:
 * - 80+ heuristic patterns (from LangGraph qualification workflow)
 * - CRM fast-track: known contacts skip LLM classification
 * - Context-aware: checks email history and sender domain
 * - Comprehensive LLM prompt with 9 categories
 *
 * Three-stage qualification:
 * 1. Fast heuristic checks (sender patterns, subject patterns, domain)
 * 2. CRM fast-track (known contacts get auto-qualified)
 * 3. LLM classification for ambiguous cases
 */

import { inngest } from "../../client";
import { getSupabaseAdmin } from "../../utils/supabase";
import { resolveOrgForUser } from "../../utils/tenant-resolver";
import { generateClaudeMessage, parseJSONResponse } from "../../utils/llm/clients";
import { isAutonomousModeEnabled } from "../../utils/feature-flags";

// =============================================================================
// Heuristic Pattern Sets (ported from LangGraph qualification workflow)
// =============================================================================

/** Sender patterns to skip — automated systems, no-reply, marketing */
const SKIP_SENDER_PATTERNS: RegExp[] = [
  /^noreply@/i, /^no-reply@/i, /^donotreply@/i, /^do-not-reply@/i,
  /^mailer-daemon@/i, /^postmaster@/i, /^bounce@/i, /^bounces@/i,
  /^notifications?@/i, /^notify@/i, /^alerts?@/i,
  /^support@/i, /^help@/i, /^helpdesk@/i,
  /^marketing@/i, /^newsletter@/i, /^news@/i, /^updates?@/i,
  /^info@.*\.(io|com|org)$/i,
  /^billing@/i, /^invoices?@/i, /^receipts?@/i,
  /^feedback@/i, /^survey@/i,
  /^team@/i, /^hello@/i,
  /@(googlegroups|groups)\./i,
  /@.*\.calendar-notification/i,
  /^calendar-notification@/i, /^calendar@/i,
  /@(jira|atlassian|asana|linear|notion|slack|github|gitlab)\./i,
  /@(hubspot|salesforce|mailchimp|sendgrid|intercom|zendesk)\./i,
  /@(stripe|paypal|square|braintree)\./i,
  /@(aws|azure|gcp|google|cloud)\./i,
];

/** Subject patterns to skip — automated, transactional, out-of-office */
const SKIP_SUBJECT_PATTERNS: RegExp[] = [
  /out of office/i, /ooo/i, /auto.?reply/i, /automatic reply/i,
  /away from (the )?office/i, /vacation responder/i,
  /delivery (status|failure|failed)/i, /undeliverable/i, /returned mail/i,
  /mail delivery (failed|subsystem)/i, /failure notice/i,
  /\bunsubscribe\b/i, /\bopt.?out\b/i,
  /password reset/i, /verify your (email|account)/i, /confirm your/i,
  /security alert/i, /sign.?in attempt/i, /two.?factor/i,
  /invoice #?\d/i, /receipt for/i, /payment (confirmation|received)/i,
  /order (confirmation|shipped|delivered)/i, /tracking (number|update)/i,
  /newsletter/i, /weekly digest/i, /daily digest/i, /monthly update/i,
  /invitation to (edit|comment|view)/i, /shared .* with you/i,
  /^\[jira\]/i, /^\[github\]/i, /^\[gitlab\]/i, /^\[linear\]/i,
  /build (failed|succeeded|passed)/i, /deploy(ment)? (failed|succeeded)/i,
  /pull request/i, /merge request/i,
  /calendar (event|invitation|update|reminder)/i,
  /meeting (cancelled|rescheduled|reminder)/i,
  /\bwebinar\b/i, /\bseminar\b/i, /\bworkshop\b/i,
  /your (subscription|trial|plan)/i,
  /action required/i, /immediate attention/i, /urgent.*account/i,
];

/** Patterns indicating someone is selling TO you (cold outreach to skip) */
const COLD_OUTREACH_PATTERNS: RegExp[] = [
  /\bi (noticed|saw|came across) (your|that)\b/i,
  /\bI('d| would) (love|like) to (help|show|share|offer|give|introduce)\b/i,
  /\bquick (question|call|chat|demo)\b/i,
  /\b(book|schedule|grab) (a |some )?time\b/i,
  /\bare you the (right|best) person\b/i,
  /\b(saw|noticed) you('re| are) (using|looking|hiring|growing)\b/i,
  /\bfellow (founder|ceo|cto|vp)\b/i,
  /\bhave you considered\b/i,
  /\bwe (help|work with|specialize|partner)\b/i,
  /\b(companies|teams|businesses) like yours\b/i,
  /\bno obligation\b/i,
  /\b(free|complimentary) (trial|demo|consultation|audit)\b/i,
  /\bspecial (offer|discount|pricing)\b/i,
  /\blimited (time|spots|availability)\b/i,
  /\broi of \d/i,
  /\bcase study/i,
  /\bI'm reaching out/i,
  /\bjust wanted to reach out/i,
  /\bwanted to (introduce|connect|share)\b/i,
  /\bI'm with \w+ (at|from)/i,
];

/** Patterns indicating recruiting */
const RECRUITING_PATTERNS: RegExp[] = [
  /\b(exciting|great|amazing) opportunity\b/i,
  /\b(open|new) (role|position|opportunity)\b/i,
  /\b(hiring|recruit|talent|headhunt)\b/i,
  /\b(your|the) (resume|cv|linkedin|profile|background|experience)\b/i,
  /\bcompensation (package|range)\b/i,
  /\b(salary|comp) range\b/i,
  /\bjob (description|opening|posting)\b/i,
  /\bwe('re| are) (looking|searching) for\b/i,
  /\bperfect (fit|match|candidate)\b/i,
  /\b(interested in|open to) (new|hearing about)\b/i,
  /\b(senior|staff|principal|lead|director|vp|head of)\b.*\b(engineer|developer|designer|product|marketing|sales)\b/i,
  /\breferred by\b/i,
  /\byour network\b/i,
];

/** Consumer/free email domains (useful for B2B vs B2C signal) */
const CONSUMER_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com",
  "icloud.com", "mail.com", "protonmail.com", "zoho.com", "yandex.com",
  "live.com", "msn.com", "me.com", "mac.com", "fastmail.com",
]);

// =============================================================================
// Helpers
// =============================================================================

function extractDomain(email: string): string {
  const parts = email.split("@");
  return parts.length === 2 ? parts[1].toLowerCase() : "";
}

interface HeuristicResult {
  shouldProcess: boolean | null;
  reason?: string;
  category?: string;
  confidence?: number;
}

/**
 * Fast heuristic checks for obvious cases.
 * Returns shouldProcess=false for definite skips, null for "needs LLM".
 */
/**
 * Strip quoted reply text from email body.
 * Returns only the new message content (before "On ... wrote:" or "> " lines).
 */
function stripQuotedText(body: string): string {
  // Match "On <date> <sender> wrote:" pattern (Gmail, Apple Mail)
  const onWroteIdx = body.search(/\r?\nOn .{10,80} wrote:\s*\r?\n/i);
  if (onWroteIdx > 0) return body.substring(0, onWroteIdx);

  // Match "-----Original Message-----" (Outlook)
  const origMsgIdx = body.indexOf("-----Original Message-----");
  if (origMsgIdx > 0) return body.substring(0, origMsgIdx);

  // Match leading ">" quote lines — find first block of them
  const lines = body.split(/\r?\n/);
  const firstQuoteLine = lines.findIndex((l) => /^>/.test(l.trim()));
  if (firstQuoteLine > 0) {
    return lines.slice(0, firstQuoteLine).join("\n");
  }

  return body;
}

function checkHeuristics(emailData: {
  fromEmail: string;
  subject: string;
  body: string;
  userDomain: string;
}): HeuristicResult {
  const fromDomain = extractDomain(emailData.fromEmail);
  const lowerSubject = emailData.subject.toLowerCase();
  const lowerFrom = emailData.fromEmail.toLowerCase();
  // Use only the new message content (strip quoted replies) for pattern matching
  const newBody = stripQuotedText(emailData.body);
  const bodyPrefix = newBody.substring(0, 1500).toLowerCase();

  // 1. Internal email
  if (fromDomain === emailData.userDomain) {
    return { shouldProcess: false, reason: "internal_email", category: "internal", confidence: 1.0 };
  }

  // 2. Skip sender patterns (automated systems)
  if (SKIP_SENDER_PATTERNS.some((p) => p.test(lowerFrom))) {
    return { shouldProcess: false, reason: "automated_sender", category: "automated", confidence: 0.95 };
  }

  // 3. Skip subject patterns (OOO, delivery failures, etc.)
  if (SKIP_SUBJECT_PATTERNS.some((p) => p.test(lowerSubject))) {
    return { shouldProcess: false, reason: "automated_subject", category: "automated", confidence: 0.95 };
  }

  // 4. Cold outreach TO you (someone selling to you)
  // Skip for replies — a prospect replying to YOUR outreach isn't cold outreach
  const isReply = /^re:\s/i.test(emailData.subject);
  if (!isReply) {
    const outreachMatches = COLD_OUTREACH_PATTERNS.filter((p) => p.test(bodyPrefix));
    if (outreachMatches.length >= 2) {
      return { shouldProcess: false, reason: "cold_outreach_to_you", category: "cold_outreach", confidence: 0.9 };
    }
  }

  // 5. Recruiting
  const recruitMatches = RECRUITING_PATTERNS.filter((p) => p.test(bodyPrefix));
  if (recruitMatches.length >= 2) {
    return { shouldProcess: false, reason: "recruiting", category: "recruiting", confidence: 0.9 };
  }

  // Needs LLM classification
  return { shouldProcess: null };
}

// =============================================================================
// Main Inngest Function
// =============================================================================

export const qualifyEmailAgent = inngest.createFunction(
  {
    id: "qualify-email-agent",
    retries: 2,
  },
  { event: "email/qualify" },
  async ({ event, step }) => {
    const { userId, messageId, from, subject, body, userDomain, organizationId } = event.data;

    // Step 1: Fast heuristic checks (80+ patterns)
    const heuristicResult = await step.run("check-heuristics", async () => {
      return checkHeuristics({
        fromEmail: from,
        subject,
        body,
        userDomain,
      });
    });

    // Get user's organization for multi-tenant isolation
    const actualOrgId = await step.run("get-organization", async () => {
      if (organizationId) return organizationId;
      return resolveOrgForUser(userId);
    });

    // If heuristics determined a skip, save and return
    if (heuristicResult.shouldProcess === false) {
      await step.run("save-quick-classification", async () => {
        const supabase = getSupabaseAdmin();

        return await supabase.from("email_classifications").insert({
          message_id: messageId,
          user_id: userId,
          organization_id: actualOrgId,
          classification: heuristicResult.category || heuristicResult.reason || "unknown",
          confidence: heuristicResult.confidence || 1.0,
          should_process: false,
          classification_method: "heuristic",
          reasoning: heuristicResult.reason,
        });
      });

      return {
        shouldProcess: false,
        category: heuristicResult.category || heuristicResult.reason || "unknown",
        confidence: heuristicResult.confidence || 1.0,
        reasoning: `Heuristic check: ${heuristicResult.reason}`,
      };
    }

    // Step 2: CRM fast-track — known contacts skip LLM
    const crmFastTrack = await step.run("crm-fast-track", async () => {
      const supabase = getSupabaseAdmin();
      const senderEmail = from.toLowerCase();
      const senderDomain = extractDomain(from);

      // Check for existing contact
      const { data: contact } = await supabase
        .from("contacts")
        .select("id, full_name, relationship_type, relationship_strength, company_name")
        .eq("user_id", userId)
        .eq("email", senderEmail)
        .maybeSingle();

      if (contact) {
        const isQualified = contact.relationship_type === "prospect"
          || contact.relationship_type === "customer"
          || contact.relationship_type === "partner";

        return {
          fastTracked: true as const,
          shouldProcess: isQualified,
          contact,
          category: isQualified
            ? (contact.relationship_type === "customer" ? "customer_existing" : "customer_prospect")
            : "other",
          confidence: 0.98,
          reasoning: `Known CRM contact: ${contact.full_name} (${contact.relationship_type})`,
        };
      }

      // Check for email history (not in CRM but has emailed before)
      const { data: priorEmails, count } = await supabase
        .from("incoming_emails")
        .select("id", { count: "exact" })
        .eq("user_id", userId)
        .eq("from_email", senderEmail)
        .neq("id", messageId)
        .limit(1);

      if (count && count > 0) {
        return {
          fastTracked: true as const,
          shouldProcess: true,
          contact: null,
          category: "customer_prospect",
          confidence: 0.9,
          reasoning: `Returning sender: ${count} prior email(s) from ${senderEmail}`,
        };
      }

      return { fastTracked: false as const, shouldProcess: undefined, category: undefined, confidence: undefined, reasoning: undefined };
    });

    if (crmFastTrack.fastTracked) {
      // Save classification
      await step.run("save-crm-classification", async () => {
        const supabase = getSupabaseAdmin();
        return await supabase.from("email_classifications").insert({
          message_id: messageId,
          user_id: userId,
          organization_id: actualOrgId,
          classification: crmFastTrack.category,
          confidence: crmFastTrack.confidence,
          should_process: crmFastTrack.shouldProcess,
          classification_method: "crm_fast_track",
          reasoning: crmFastTrack.reasoning,
        });
      });

      // Route if qualified
      if (crmFastTrack.shouldProcess) {
        const sendMode = await step.run("check-autonomous-enabled", async () => {
          // (Note: the Autonomous-agent-as-real-user override was reverted on 2026-05-06
          // along with the rest of the dedicated-Sales Agent-account feature; this
          // branch falls through to the standard autonomous-mode flag check.)
          if (!(await isAutonomousModeEnabled(actualOrgId))) return "approval";

          // Per-user opt-out
          const supabase = getSupabaseAdmin();
          const { data: profile } = await supabase
            .from("profiles").select("feature_flags").eq("user_id", userId).maybeSingle();
          if ((profile?.feature_flags as any)?.autonomous_emails?.enabled === false) return "approval";

          // Autonomous mode enabled — always route to autonomous pipeline
          return "autonomous";
        });

        if (sendMode === "autonomous") {
          await step.sendEvent("trigger-autonomous-processing", {
            name: "email/autonomous-process",
            data: {
              userId,
              messageId,
              from,
              subject,
              body,
              organizationId: actualOrgId,
              qualificationConfidence: crmFastTrack.confidence,
              qualificationCategory: crmFastTrack.category,
            },
          });
        } else {
          await step.sendEvent("trigger-email-processing", {
            name: "email/process",
            data: { userId, messageId, from, subject, body, organizationId: actualOrgId },
          });
        }
      }

      return {
        shouldProcess: crmFastTrack.shouldProcess,
        category: crmFastTrack.category || "unknown",
        confidence: crmFastTrack.confidence || 0,
        reasoning: crmFastTrack.reasoning || "",
      };
    }

    // Step 3: LLM classification for ambiguous cases (comprehensive prompt)
    const senderDomain = extractDomain(from);
    const isConsumerDomain = CONSUMER_DOMAINS.has(senderDomain);

    const classification = await step.run("llm-classify", async () => {
      const prompt = `You are classifying an incoming email for a B2B sales team.

CLASSIFY into exactly one category:

1. customer_prospect — Someone interested in buying from us, asking about our product/service, requesting info, a demo, or pricing. This is the MOST IMPORTANT category — when in doubt, choose this.
2. customer_existing — An email from a known customer with questions, requests, or follow-ups about a product they already use.
3. support_request — Technical support, bug reports, or help requests from existing users.
4. partnership_inquiry — Business development, integration partnership, or co-marketing proposals from another company.
5. cold_outreach — Someone selling THEIR product/service TO us. Vendors, agencies, consultants pitching their services.
6. recruiting — Recruiters, job offers, talent acquisition emails.
7. spam_marketing — Spam, phishing, mass marketing emails, newsletters you didn't subscribe to.
8. automated — System notifications, calendar invites, delivery receipts, CI/CD alerts.
9. unknown — Cannot determine the category.

EMAIL:
From: ${from}${isConsumerDomain ? " (consumer email domain)" : " (business domain)"}
Subject: ${subject}
Body (first 1200 chars): ${body.substring(0, 1200)}

IMPORTANT RULES:
- Default to "customer_prospect" when uncertain — it's better to process a borderline email than miss a real lead.
- "shouldProcess" = true for: customer_prospect, customer_existing, support_request, partnership_inquiry
- "shouldProcess" = false for: cold_outreach, recruiting, spam_marketing, automated, unknown
- A short, casual email asking a question is likely a prospect, not spam.
- Someone from a business domain asking about your product → customer_prospect.
- Someone pitching THEIR product to you → cold_outreach (shouldProcess = false).

Return JSON only:
{
  "category": "category_name",
  "confidence": 0.0-1.0,
  "shouldProcess": true/false,
  "reasoning": "brief 1-2 sentence explanation"
}`;

      const response = await generateClaudeMessage(
        [{ role: "user", content: prompt }],
        {
          model: "claude-haiku-4-5-20251001",
          temperature: 0.1,
          maxTokens: 500,
        }
      );

      const content = response.content[0];
      if (content.type !== "text") {
        throw new Error("Expected text response from LLM");
      }

      return parseJSONResponse<{
        category: string;
        confidence: number;
        shouldProcess: boolean;
        reasoning: string;
      }>(content.text);
    });

    // Step 4: Store classification
    await step.run("save-classification", async () => {
      const supabase = getSupabaseAdmin();

      return await supabase.from("email_classifications").insert({
        message_id: messageId,
        user_id: userId,
        organization_id: actualOrgId,
        classification: classification.category,
        confidence: classification.confidence,
        should_process: classification.shouldProcess,
        classification_method: "llm",
        reasoning: classification.reasoning,
      });
    });

    // Step 5: Route to appropriate processing if qualified
    if (classification.shouldProcess) {
      const sendMode = await step.run("check-autonomous-enabled", async () => {
        // (Note: the Autonomous-agent-as-real-user override was reverted on 2026-05-06
        // along with the rest of the dedicated-Sales Agent-account feature; this
        // branch falls through to the standard autonomous-mode flag check.)
        if (!(await isAutonomousModeEnabled(actualOrgId))) return "approval";

        // Per-user opt-out
        const supabase = getSupabaseAdmin();
        const { data: profile } = await supabase
          .from("profiles").select("feature_flags").eq("user_id", userId).maybeSingle();
        if ((profile?.feature_flags as any)?.autonomous_emails?.enabled === false) return "approval";

        // Autonomous mode enabled — always route to autonomous pipeline
        return "autonomous";
      });

      if (sendMode === "autonomous") {
        await step.sendEvent("trigger-autonomous-processing", {
          name: "email/autonomous-process",
          data: {
            userId,
            messageId,
            from,
            subject,
            body,
            organizationId: actualOrgId,
            qualificationConfidence: classification.confidence,
            qualificationCategory: classification.category,
          },
        });
      } else {
        await step.sendEvent("trigger-email-processing", {
          name: "email/process",
          data: { userId, messageId, from, subject, body, organizationId: actualOrgId },
        });
      }
    }

    return {
      shouldProcess: classification.shouldProcess,
      category: classification.category,
      confidence: classification.confidence,
      reasoning: classification.reasoning,
    };
  }
);
