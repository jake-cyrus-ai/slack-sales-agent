/**
 * Usage Event Tracking
 *
 * Fire-and-forget helper that inserts rows into usage_events via the
 * service-role Supabase client (bypasses RLS).
 *
 * Errors are logged, never thrown — callers should not await this if
 * they don't need confirmation.
 */

import { logger } from '../../lib/logger.js';

const log = logger.child({ component: 'usage-tracking' });

import { supabase } from './supabase.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type UsageEventType =
  | 'task'
  | 'workflow'
  | 'prompt'
  | 'workflow_step'
  | 'escalation'
  | 'external_event';

export interface TrackUsageEventParams {
  orgId: string;
  userId?: string | null;
  dealId?: string | null;
  eventType: UsageEventType;
  eventName: string;
  status?: 'success' | 'fail';
  provider?: string | null;
  model?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  workflowRunId?: string | null;
  runtimeMs?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
}

// ── Cost estimation ────────────────────────────────────────────────────────

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic (per 1M tokens)
  'claude-opus-4-5-20251101':    { input: 15.0,  output: 75.0  },
  'claude-opus-4-6':             { input: 15.0,  output: 75.0  },
  'claude-sonnet-4-20250514':    { input: 3.0,   output: 15.0  },
  'claude-sonnet-4-6':           { input: 3.0,   output: 15.0  },
  'claude-haiku-4-5-20251001':   { input: 1.0,   output: 5.0   },
  // OpenAI (per 1M tokens)
  'gpt-4o':                      { input: 2.5,   output: 10.0  },
  'gpt-4o-mini':                 { input: 0.15,  output: 0.6   },
  'gpt-4-turbo':                 { input: 10.0,  output: 30.0  },
  'o1-preview':                  { input: 15.0,  output: 60.0  },
  'o1-mini':                     { input: 3.0,   output: 12.0  },
};

export function estimateCost(
  model: string | null | undefined,
  tokensIn: number,
  tokensOut: number,
): number {
  if (!model) return 0;
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return (tokensIn * pricing.input + tokensOut * pricing.output) / 1_000_000;
}

// ── Main tracker ───────────────────────────────────────────────────────────

export async function trackUsageEvent(params: TrackUsageEventParams): Promise<void> {
  try {
    const costUsd =
      params.costUsd ??
      estimateCost(params.model, params.tokensIn ?? 0, params.tokensOut ?? 0);

    const { error } = await supabase.from('usage_events').insert({
      org_id:          params.orgId,
      user_id:         params.userId ?? null,
      deal_id:         params.dealId ?? null,
      event_type:      params.eventType,
      event_name:      params.eventName,
      status:          params.status ?? 'success',
      provider:        params.provider ?? null,
      model:           params.model ?? null,
      tokens_in:       params.tokensIn ?? 0,
      tokens_out:      params.tokensOut ?? 0,
      cost_usd:        costUsd,
      workflow_run_id: params.workflowRunId ?? null,
      runtime_ms:      params.runtimeMs ?? null,
      error_code:      params.errorCode ?? null,
      error_message:   params.errorMessage ?? null,
      metadata:        params.metadata ?? {},
    });

    if (error) {
      log.error({ err: error }, 'Insert failed');
    }
  } catch (err) {
    log.error({ err }, 'Unexpected error');
  }
}
