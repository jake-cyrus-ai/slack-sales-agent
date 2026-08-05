/**
 * Prospect chat message log helpers.
 *
 * Mirrors OpenAI chat completion shape for replay simplicity. All writes go
 * through the service-role client because the prospect is anonymous (no JWT).
 */

import { getSupabaseAdmin } from "../supabase";
import { logger } from "../logger";

const log = logger.child({ component: "prospect-context-messages" });

export type ProspectRole = "user" | "assistant" | "system" | "tool";

export interface ProspectDemoPayload {
  demoId: string;
  name: string;
  videoUrl: string;
}

export interface ProspectMessage {
  id: string;
  sessionId: string;
  role: ProspectRole;
  content: string | null;
  toolCalls: unknown | null;
  toolName: string | null;
  metadata: Record<string, unknown>;
  demoPayload: ProspectDemoPayload | null;
  suggestions: string[] | null;
  createdAt: string;
}

interface ProspectMessageRow {
  id: string;
  session_id: string;
  role: ProspectRole;
  content: string | null;
  tool_calls: unknown | null;
  tool_name: string | null;
  metadata: Record<string, unknown> | null;
  demo_payload: { demo_id?: string; name?: string; video_url?: string } | null;
  suggestions: unknown | null;
  created_at: string;
}

function rowToMessage(row: ProspectMessageRow): ProspectMessage {
  let demoPayload: ProspectDemoPayload | null = null;
  if (
    row.demo_payload &&
    typeof row.demo_payload.demo_id === "string" &&
    typeof row.demo_payload.name === "string" &&
    typeof row.demo_payload.video_url === "string"
  ) {
    demoPayload = {
      demoId: row.demo_payload.demo_id,
      name: row.demo_payload.name,
      videoUrl: row.demo_payload.video_url,
    };
  }

  let suggestions: string[] | null = null;
  if (Array.isArray(row.suggestions)) {
    suggestions = row.suggestions.filter((q): q is string => typeof q === "string");
    if (suggestions.length === 0) suggestions = null;
  }

  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    toolCalls: row.tool_calls,
    toolName: row.tool_name,
    metadata: row.metadata ?? {},
    demoPayload,
    suggestions,
    createdAt: row.created_at,
  };
}

interface AppendOptions {
  sessionId: string;
  role: ProspectRole;
  content?: string | null;
  toolCalls?: unknown;
  toolName?: string;
  metadata?: Record<string, unknown>;
  demoPayload?: ProspectDemoPayload | null;
  suggestions?: string[] | null;
}

export async function appendProspectMessage(opts: AppendOptions): Promise<ProspectMessage> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("prospect_messages")
    .insert({
      session_id: opts.sessionId,
      role: opts.role,
      content: opts.content ?? null,
      tool_calls: opts.toolCalls ?? null,
      tool_name: opts.toolName ?? null,
      metadata: opts.metadata ?? {},
      demo_payload: opts.demoPayload
        ? {
            demo_id: opts.demoPayload.demoId,
            name: opts.demoPayload.name,
            video_url: opts.demoPayload.videoUrl,
          }
        : null,
      suggestions: opts.suggestions && opts.suggestions.length > 0 ? opts.suggestions : null,
    })
    .select()
    .single();

  if (error || !data) {
    log.error({ err: error, sessionId: opts.sessionId, role: opts.role }, "Failed to append prospect message");
    throw error ?? new Error("Failed to append prospect message");
  }
  return rowToMessage(data);
}

export async function listProspectMessages(
  sessionId: string,
  limit = 100
): Promise<ProspectMessage[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("prospect_messages")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error || !data) {
    log.error({ err: error, sessionId }, "Failed to list prospect messages");
    return [];
  }
  return data.map(rowToMessage);
}
