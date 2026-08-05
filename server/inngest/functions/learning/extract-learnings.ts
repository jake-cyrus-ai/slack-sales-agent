/**
 * Feedback Learning Pipeline
 *
 * Two functions:
 * 1. scanFeedbackLearnings — hourly cron, finds users with unprocessed feedback, fans out
 * 2. extractLearnings — per-user, LLM reviews feedback events and manages learnings
 *
 * The LLM sees existing learnings + new feedback events and decides what to
 * add, update, or remove. No weights or confidence scores — the LLM makes
 * the judgment call each time it runs.
 */

import { inngest } from "../../client";
import { getSupabaseAdmin } from "../../utils/supabase";
import { ChatAnthropic } from "@langchain/anthropic";
import { trackUsageEvent } from "../../../src/lib/usage-tracking";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "extract-learnings" });

const MAX_EVENTS_PER_RUN = 30;
const MAX_BODY_SAMPLE = 800; // truncate long text in event payloads

// ── Cron scanner: find users with unprocessed feedback ──────────────────────

export const scanFeedbackLearnings = inngest.createFunction(
  {
    id: "scan-feedback-learnings",
    retries: 1,
  },
  { cron: "0 * * * *" }, // every hour
  async ({ step }) => {
    const supabase = getSupabaseAdmin();

    // Find distinct users with unprocessed events
    const users = await step.run("find-users-with-feedback", async () => {
      const { data, error } = await supabase
        .from("feedback_events")
        .select("user_id, organization_id")
        .eq("processed", false)
        .limit(200);

      if (error) {
        log.error({ err: error }, "query error");
        return [];
      }

      // Deduplicate by user_id
      const seen = new Map<string, string>();
      for (const row of data || []) {
        if (!seen.has(row.user_id)) {
          seen.set(row.user_id, row.organization_id);
        }
      }
      return Array.from(seen.entries()).map(([userId, orgId]) => ({
        userId,
        organizationId: orgId,
      }));
    });

    if (users.length === 0) {
      return { status: "no_pending_feedback" };
    }

    // Fan out per user
    await step.sendEvent(
      "fan-out-learning-extraction",
      users.map((u) => ({
        name: "feedback/extract-learnings" as const,
        data: {
          userId: u.userId,
          organizationId: u.organizationId,
        },
      })),
    );

    return { status: "dispatched", userCount: users.length };
  },
);

// ── Per-user learning extraction ────────────────────────────────────────────

export const extractLearnings = inngest.createFunction(
  {
    id: "extract-learnings",
    concurrency: [
      { limit: 5 },                          // global cap
      { key: "event.data.userId", limit: 1 }, // one run per user at a time
    ],
    retries: 1,
  },
  { event: "feedback/extract-learnings" },
  async ({ event, step }) => {
    const { userId, organizationId } = event.data as {
      userId: string;
      organizationId: string;
    };
    const supabase = getSupabaseAdmin();

    // Step 1: Fetch existing learnings + unprocessed events
    const { existingLearnings, feedbackEvents } = await step.run(
      "fetch-data",
      async () => {
        const [learningsResult, eventsResult] = await Promise.all([
          supabase
            .from("user_learnings")
            .select("id, domain, learning")
            .eq("user_id", userId)
            .eq("organization_id", organizationId)
            .eq("status", "active")
            .order("updated_at", { ascending: false })
            .limit(30),
          supabase
            .from("feedback_events")
            .select("id, domain, signal_type, agent_output, user_action, delta, context, created_at")
            .eq("user_id", userId)
            .eq("organization_id", organizationId)
            .eq("processed", false)
            .order("created_at", { ascending: false })
            .limit(MAX_EVENTS_PER_RUN),
        ]);

        return {
          existingLearnings: learningsResult.data || [],
          feedbackEvents: eventsResult.data || [],
        };
      },
    );

    if (feedbackEvents.length === 0) {
      return { status: "no_events" };
    }

    // Step 2: LLM analysis
    const llmResult = await step.run("llm-extract", async () => {
      const llm = new ChatAnthropic({
        model: "claude-haiku-4-5-20251001",
        anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
        temperature: 0.3,
      });

      const existingBlock = existingLearnings.length > 0
        ? existingLearnings
            .map((l, i) => `${i + 1}. [${l.id}] (${l.domain}) "${l.learning}"`)
            .join("\n")
        : "(none yet)";

      const eventsBlock = feedbackEvents
        .map((e, i) => {
          const parts = [`Event ${i + 1} (${e.domain}, ${e.signal_type}, ${e.created_at}):`];
          if (e.agent_output) {
            parts.push(`  Agent output: ${truncate(JSON.stringify(e.agent_output))}`);
          }
          if (e.user_action) {
            parts.push(`  User action: ${truncate(JSON.stringify(e.user_action))}`);
          }
          if (e.delta) {
            parts.push(`  Delta: ${truncate(JSON.stringify(e.delta))}`);
          }
          if (e.context) {
            parts.push(`  Context: ${truncate(JSON.stringify(e.context))}`);
          }
          return parts.join("\n");
        })
        .join("\n\n");

      const response = await llm.invoke([
        {
          role: "system",
          content: `You review how a user interacted with an AI sales assistant's outputs.
Your job is to extract persistent behavioral preferences — things the user consistently wants or doesn't want.

EXISTING LEARNINGS (things we already know about this user):
${existingBlock}

Return ONLY valid JSON (no markdown, no explanation):
{
  "learnings": [
    { "id": "existing-uuid", "action": "keep" },
    { "id": "existing-uuid", "action": "update", "text": "updated learning text", "domain": "email" },
    { "id": null, "action": "add", "text": "new learning text", "domain": "email" }
  ],
  "removed": [
    { "id": "existing-uuid", "reason": "contradicted by recent behavior" }
  ],
  "activity_summary": "Brief summary of what changed for the activity feed (1-2 sentences)"
}

Rules:
- Only add a learning if you see a clear, repeatable pattern (not one-off behavior)
- Explicit corrections (signal_type: "correction") are strong signals — a single one can create a learning
- Edits and rejections need 2+ instances to establish a pattern
- Approvals without edits are weak signals — note them but don't create learnings from approvals alone
- If a new event contradicts an existing learning, move it to "removed" with a reason
- If a new event refines an existing learning, use "update" with improved text
- Keep learnings concise and actionable (one sentence each)
- Domain should be: email, calendar, deal, meeting_prep, or general
- Include ALL existing learnings in your response (keep, update, or remove each one)`,
        },
        {
          role: "user",
          content: `Review these ${feedbackEvents.length} new feedback events:\n\n${eventsBlock}`,
        },
      ]);

      const text = typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

      // Strip markdown fences if present
      const jsonText = text.replace(/^```json?\s*\n?|\n?```$/g, "").trim();
      try {
        return JSON.parse(jsonText) as {
          learnings: Array<{ id: string | null; action: string; text?: string; domain?: string }>;
          removed: Array<{ id: string; reason: string }>;
          activity_summary: string;
        };
      } catch {
        log.error({ responsePreview: text.slice(0, 500) }, "Failed to parse LLM response");
        return null;
      }
    });

    if (!llmResult) {
      // Mark events as processed to prevent infinite retry loop
      await step.run("mark-processed-on-error", async () => {
        const eventIds = feedbackEvents.map((e) => e.id);
        await supabase
          .from("feedback_events")
          .update({ processed: true })
          .in("id", eventIds);
      });
      return { status: "parse_error", eventsMarkedProcessed: feedbackEvents.length };
    }

    // Step 3: Apply changes
    const applied = await step.run("apply-changes", async () => {
      let added = 0;
      let updated = 0;
      let removed = 0;
      const newLearningIds: string[] = [];

      const eventIds = feedbackEvents.map((e) => e.id);

      // Process additions and updates
      for (const item of llmResult.learnings) {
        if (item.action === "add" && item.text) {
          const { data, error } = await supabase
            .from("user_learnings")
            .insert({
              user_id: userId,
              organization_id: organizationId,
              domain: item.domain || "general",
              learning: item.text,
              source_event_ids: eventIds,
            })
            .select("id")
            .single();

          if (!error && data) {
            newLearningIds.push(data.id);
            added++;
          }
        } else if (item.action === "update" && item.id && item.text) {
          // Append new event IDs to existing source_event_ids (preserve history)
          const { data: existing } = await supabase
            .from("user_learnings")
            .select("source_event_ids")
            .eq("id", item.id)
            .eq("user_id", userId)
            .maybeSingle();

          const merged = [...new Set([...(existing?.source_event_ids || []), ...eventIds])];

          const { error } = await supabase
            .from("user_learnings")
            .update({
              learning: item.text,
              domain: item.domain || undefined,
              source_event_ids: merged,
              updated_at: new Date().toISOString(),
            })
            .eq("id", item.id)
            .eq("user_id", userId);

          if (!error) updated++;
        }
      }

      // Process removals
      for (const item of llmResult.removed || []) {
        const { error } = await supabase
          .from("user_learnings")
          .update({
            status: "removed",
            removed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", item.id)
          .eq("user_id", userId);

        if (!error) removed++;
      }

      // Mark feedback events as processed
      await supabase
        .from("feedback_events")
        .update({ processed: true })
        .in("id", eventIds);

      return { added, updated, removed, newLearningIds };
    });

    // Step 4: Write to activity feed
    if (applied.added > 0 || applied.updated > 0 || applied.removed > 0) {
      await step.run("track-activity", async () => {
        await trackUsageEvent({
          orgId: organizationId,
          userId,
          eventType: "task",
          eventName: llmResult.activity_summary || "Updated preferences from feedback",
          metadata: {
            type: "feedback_learning",
            added: applied.added,
            updated: applied.updated,
            removed: applied.removed,
            learningIds: applied.newLearningIds,
            sourceEventCount: feedbackEvents.length,
            sourceEventIds: feedbackEvents.map((e) => e.id),
          },
        });
      });
    }

    log.info({ userId, eventsProcessed: feedbackEvents.length, added: applied.added, updated: applied.updated, removed: applied.removed }, "Processed feedback events");

    return {
      status: "ok",
      eventsProcessed: feedbackEvents.length,
      ...applied,
    };
  },
);

// ── Helpers ─────────────────────────────────────────────────────────────────

function truncate(text: string): string {
  return text.length > MAX_BODY_SAMPLE
    ? text.slice(0, MAX_BODY_SAMPLE) + "..."
    : text;
}
