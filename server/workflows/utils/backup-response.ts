/**
 * Backup Response Flow — graceful degradation when the primary agent pipeline
 * fails. Two tiers:
 *
 *  Tier A (runBackupLLM)   — bare LangChain ChatAnthropic call with just the
 *                            conversation history, the user's current message,
 *                            and a minimal system prompt. No tools, no
 *                            classification, no multi-agent routing. This
 *                            catches the majority of failures (tool crashes,
 *                            classifier bugs, integration outages).
 *
 *  Tier B (buildApologyMessage) — context-aware apology used when Tier A also
 *                            fails. Echoes the user's question and includes a
 *                            short request ID for support.
 */

import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { createLLM } from "../../src/lib/llm-retry.js";
import type { ErrorCategory } from "./slack-error-reporter";
import { logger } from "../../lib/logger";

const log = logger.child({ util: "backup-response" });

// ─── Tier A: Bare LLM fallback ───────────────────────────────────────────────

const BACKUP_SYSTEM_PROMPT = `You are Sales Agent, the user's AI assistant. A tool or subsystem failed while answering their latest message.

Do your best to help using ONLY the conversation history and your general knowledge. Do not mention tools, errors, or that anything failed. Do not promise to check external systems. If you genuinely cannot answer without tools, say so plainly and suggest how the user might rephrase or what they could try next.

Keep your response concise and direct.`;

export interface BackupLLMInput {
  conversationHistory: Array<{ role: string; content: string }>;
  currentMessage: string;
  userName?: string | null;
}

export interface BackupLLMResult {
  success: boolean;
  response?: string;
  error?: unknown;
}

/**
 * Run the Tier A bare LLM fallback. Returns a plain string response on
 * success, or an error on failure. Does not throw — callers inspect .success.
 */
export async function runBackupLLM(input: BackupLLMInput): Promise<BackupLLMResult> {
  try {
    const llm = createLLM({ temperature: 0.3, maxTokens: 1024, maxRetries: 2 });

    const messages: Array<SystemMessage | HumanMessage | AIMessage> = [
      new SystemMessage(BACKUP_SYSTEM_PROMPT),
    ];

    // Take the last ~10 turns of history to keep the call fast and cheap.
    const trimmed = input.conversationHistory.slice(-10);
    for (const m of trimmed) {
      const content = (m.content || "").trim();
      if (!content) continue;
      if (m.role === "user") messages.push(new HumanMessage(content));
      else messages.push(new AIMessage(content));
    }

    // Always append the current message as the final human turn if it isn't
    // already the last thing in history.
    const last = messages[messages.length - 1];
    if (!last || last._getType() !== "human" || (last as HumanMessage).content !== input.currentMessage) {
      messages.push(new HumanMessage(input.currentMessage));
    }

    const result = await llm.invoke(messages);
    const text = typeof result.content === "string"
      ? result.content
      : Array.isArray(result.content)
        ? result.content.map((c: any) => (typeof c === "string" ? c : c.text || "")).join("")
        : "";

    if (!text.trim()) {
      return { success: false, error: new Error("Backup LLM returned empty response") };
    }

    return { success: true, response: text.trim() };
  } catch (err) {
    log.error({ err }, "Tier A LLM call failed");
    return { success: false, error: err };
  }
}

// ─── Tier B: Context-aware apology ───────────────────────────────────────────

/**
 * Build a user-facing apology when both the primary pipeline and the Tier A
 * backup have failed. Echoes the user's question and includes a request ID
 * they can reference in support.
 */
export function buildApologyMessage(opts: {
  userMessage: string;
  requestId: string;
  category?: ErrorCategory;
}): string {
  const quoted = opts.userMessage.length > 180
    ? `"${opts.userMessage.slice(0, 177)}..."`
    : `"${opts.userMessage}"`;

  const subsystemNote = opts.category && opts.category.startsWith("integration:")
    ? ` I'm having trouble reaching ${opts.category.split(":")[1].replace(/_/g, " ")} right now.`
    : opts.category === "slack_api"
      ? " I'm having trouble talking to Slack right now."
      : opts.category === "auth"
        ? " Something is off with my credentials on this workspace."
        : "";

  return (
    `Sorry — I tried to answer ${quoted} but something went wrong on my end.${subsystemNote}\n\n` +
    `Mind trying again in a moment? If it keeps failing, reference request ID \`${opts.requestId}\` when you reach out.`
  );
}
