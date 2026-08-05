/**
 * Workflow Lifecycle Tracking
 *
 * Helpers to create, step, escalate, and complete workflow runs.
 * All writes go through the service-role Supabase client (bypasses RLS).
 * Step/escalation events are inserted into usage_events with a
 * workflow_run_id so the DB trigger keeps workflow_runs counters in sync.
 */

import { supabase } from './supabase.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ component: 'workflow-tracking' });
import { trackUsageEvent } from './usage-tracking.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type WorkflowKind =
  | 'meeting_prep'
  | 'deep_research'
  | 'deal_followup'
  | 'knowledge_query'
  | 'security_review'
  | 'doc_generation'
  | 'salesforce_query'
  | 'meeting_followup'
  | 'other';

export type WorkflowStatus = 'started' | 'succeeded' | 'failed' | 'cancelled';

export interface StartWorkflowRunParams {
  orgId: string;
  userId?: string | null;
  dealId?: string | null;
  workflowKind: WorkflowKind;
  metadata?: Record<string, unknown>;
}

export interface LogWorkflowStepParams {
  workflowRunId: string;
  orgId: string;
  userId?: string | null;
  dealId?: string | null;
  stepName: string;
  status?: 'success' | 'fail';
  runtimeMs?: number;
  metadata?: Record<string, unknown>;
}

export interface LogEscalationParams {
  workflowRunId: string;
  orgId: string;
  userId?: string | null;
  dealId?: string | null;
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface CompleteWorkflowRunParams {
  workflowRunId: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  errorCode?: string;
  errorMessage?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Create a new workflow run row and return its id.
 */
export async function startWorkflowRun(
  params: StartWorkflowRunParams,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('workflow_runs')
      .insert({
        org_id:        params.orgId,
        user_id:       params.userId ?? null,
        deal_id:       params.dealId ?? null,
        workflow_kind: params.workflowKind,
        status:        'started',
        metadata:      params.metadata ?? {},
      })
      .select('id')
      .single();

    if (error) {
      log.error({ err: error }, 'startWorkflowRun failed');
      return null;
    }

    return data.id;
  } catch (err) {
    log.error({ err }, 'startWorkflowRun error');
    return null;
  }
}

/**
 * Log a workflow step. Inserts a usage_events row with event_type = 'workflow_step'.
 * The DB trigger increments workflow_runs.steps_count automatically.
 */
export async function logWorkflowStep(params: LogWorkflowStepParams): Promise<void> {
  await trackUsageEvent({
    orgId:         params.orgId,
    userId:        params.userId,
    dealId:        params.dealId,
    eventType:     'workflow_step',
    eventName:     params.stepName,
    status:        params.status ?? 'success',
    workflowRunId: params.workflowRunId,
    runtimeMs:     params.runtimeMs,
    metadata:      params.metadata,
  });
}

/**
 * Log an escalation (handoff to human / ask for help).
 * The DB trigger increments workflow_runs.escalations_count.
 */
export async function logEscalation(params: LogEscalationParams): Promise<void> {
  await trackUsageEvent({
    orgId:         params.orgId,
    userId:        params.userId,
    dealId:        params.dealId,
    eventType:     'escalation',
    eventName:     params.reason,
    workflowRunId: params.workflowRunId,
    metadata:      params.metadata,
  });
}

/**
 * Mark a workflow run as completed/failed/cancelled.
 * Also emits a usage_events row with event_type = 'workflow' so
 * the rollup backfill can count completed workflows.
 */
export async function completeWorkflowRun(
  params: CompleteWorkflowRunParams,
): Promise<void> {
  try {
    const now = new Date().toISOString();

    // Fetch started_at to compute runtime_ms
    const { data: run } = await supabase
      .from('workflow_runs')
      .select('org_id, user_id, deal_id, workflow_kind, started_at')
      .eq('id', params.workflowRunId)
      .single();

    if (!run) {
      log.error({ workflowRunId: params.workflowRunId }, 'completeWorkflowRun: run not found');
      return;
    }

    const runtimeMs = run.started_at
      ? Date.now() - new Date(run.started_at).getTime()
      : null;

    const { error } = await supabase
      .from('workflow_runs')
      .update({
        status:        params.status,
        ended_at:      now,
        runtime_ms:    runtimeMs,
        error_code:    params.errorCode ?? null,
        error_message: params.errorMessage ?? null,
      })
      .eq('id', params.workflowRunId);

    if (error) {
      log.error({ err: error }, 'completeWorkflowRun update failed');
    }

    // Emit a summary usage_event so rollup backfill can count workflows
    await trackUsageEvent({
      orgId:         run.org_id,
      userId:        run.user_id,
      dealId:        run.deal_id,
      eventType:     'workflow',
      eventName:     run.workflow_kind,
      status:        params.status === 'succeeded' ? 'success' : 'fail',
      workflowRunId: params.workflowRunId,
      runtimeMs:     runtimeMs,
      errorCode:     params.errorCode,
      errorMessage:  params.errorMessage,
    });
  } catch (err) {
    log.error({ err }, 'completeWorkflowRun error');
  }
}
