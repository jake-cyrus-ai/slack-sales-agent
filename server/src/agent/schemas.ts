/**
 * Strict agent output schemas — every sub-agent returns typed JSON
 * conforming to AgentOutput<T> with confidence + citations.
 */

// ─── Shared types ───────────────────────────────────────────────────────────

export interface Citation {
  source: string;
  title: string;
  url?: string;
  snippet?: string;
}

export type PendingActionType =
  | 'crm_stage_update'
  | 'crm_create_task'
  | 'crm_log_activity'
  | 'email_send'
  | 'calendar_propose'
  | 'calendar_delete';

export type PendingActionStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface PendingAction {
  id: string;
  type: PendingActionType;
  payload: Record<string, unknown>;
  rationale: string;
  evidence: Citation[];
  status: PendingActionStatus;
}

/**
 * Every sub-agent returns this wrapper.
 * `data` is agent-specific; the wrapper is uniform.
 */
export interface AgentOutput<T = unknown> {
  agent: string;
  data: T;
  confidence: number;
  citations: Citation[];
  pending_actions: PendingAction[];
  errors: string[];
}

// ─── Validation helpers ─────────────────────────────────────────────────────

/**
 * Validate that an agent output has the required wrapper fields.
 * Returns the parsed output or throws with a descriptive error.
 */
export function validateAgentOutput(raw: unknown): AgentOutput {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Agent output must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.agent !== 'string') {
    throw new Error('Agent output missing "agent" field');
  }
  if (typeof obj.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1) {
    throw new Error('Agent output "confidence" must be a number between 0 and 1');
  }
  if (!Array.isArray(obj.citations)) {
    throw new Error('Agent output missing "citations" array');
  }

  return {
    agent: obj.agent as string,
    data: obj.data ?? {},
    confidence: obj.confidence as number,
    citations: (obj.citations as Citation[]) || [],
    pending_actions: (obj.pending_actions as PendingAction[]) || [],
    errors: (obj.errors as string[]) || [],
  };
}

/**
 * Attempt to parse a raw LLM text response as AgentOutput JSON.
 * Extracts JSON from markdown code blocks if present.
 */
export function parseAgentOutput(text: string): AgentOutput {
  // Strip markdown code fences if present
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
  if (!jsonMatch?.[1]) {
    throw new Error('No JSON found in agent response');
  }

  const parsed = JSON.parse(jsonMatch[1].trim());
  return validateAgentOutput(parsed);
}
