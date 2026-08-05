import { start } from "workflow/api";
import { logger } from "../lib/logger.js";

export type WorkflowEvent<T = Record<string, unknown>> = {
  id?: string;
  name: string;
  data: T;
  ts?: number;
};

export type WorkflowDefinition = {
  id: string;
  trigger: { event?: string; cron?: string } | Array<{ event?: string; cron?: string }>;
  handler: (context: any) => Promise<any>;
  retries?: number;
  [key: string]: unknown;
};

const durationToMs = (value: string): number => {
  const match = /^(\d+)\s*(s|m|h|d)$/i.exec(value.trim());
  if (!match) throw new Error(`Unsupported workflow duration: ${value}`);
  const unit = match[2].toLowerCase();
  return Number(match[1]) * ({ s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1);
};

class AwaitingExternalApproval extends Error {
  constructor(readonly eventName: string) {
    super(`Awaiting external approval: ${eventName}`);
  }
}

const createStepAdapter = () => ({
  run: async (_name: string, operation: () => Promise<any>) => operation(),
  sendEvent: async (_name: string, event: WorkflowEvent | WorkflowEvent[]) => workflow.send(event),
  invoke: async (_name: string, options: { function: WorkflowDefinition; data: Record<string, unknown> }) =>
    options.function.handler({
      event: { name: `invoke/${options.function.id}`, data: options.data },
      step: createStepAdapter(),
      runId: crypto.randomUUID(),
      attempt: 0,
      logger,
    }),
  sleep: async (_name: string, duration: string) =>
    new Promise((resolve) => setTimeout(resolve, durationToMs(duration))),
  sleepUntil: async (_name: string, until: string | Date) => {
    const date = until instanceof Date ? until : new Date(until);
    const remaining = Math.max(0, date.getTime() - Date.now());
    return new Promise((resolve) => setTimeout(resolve, remaining));
  },
  waitForEvent: async (
    _name: string,
    options: { event: string; timeout?: string; if?: string },
  ) => {
    // Approval actions are resumed by Slack interaction workflows, which
    // revalidate the actor and execute the idempotent provider action. Ending
    // this run leaves the persisted approval request pending without holding
    // compute for days.
    logger.info({ event: options.event, filter: options.if }, "Workflow paused for external approval");
    throw new AwaitingExternalApproval(options.event);
  },
});

export const executeDefinition = async (
  definition: WorkflowDefinition,
  event: WorkflowEvent,
) => {
  const { validateWorkflowEvent } = await import("./middleware/org-validation.js");
  await validateWorkflowEvent(event);
  try {
    return await definition.handler({
      event,
      step: createStepAdapter(),
      runId: event.id ?? crypto.randomUUID(),
      attempt: 0,
      logger,
    });
  } catch (error) {
    if (error instanceof AwaitingExternalApproval) {
      return { status: "awaiting_approval", event: error.eventName };
    }
    throw error;
  }
};

const eventNames = (trigger: WorkflowDefinition["trigger"]): string[] => {
  const triggers = Array.isArray(trigger) ? trigger : [trigger];
  return triggers.flatMap((item) => item.event ? [item.event] : []);
};

export async function executeEvent(event: WorkflowEvent) {
  const { functions } = await import("./functions/index.js");
  const matches = functions.filter((definition) => eventNames(definition.trigger).includes(event.name));
  if (!matches.length) throw new Error(`No workflow registered for event ${event.name}`);
  return Promise.all(matches.map((definition) => executeDefinition(definition, event)));
}

export async function executeScheduled(workflowId: string) {
  const { functions } = await import("./functions/index.js");
  const definition = functions.find((candidate) => {
    if (candidate.id !== workflowId) return false;
    const triggers = Array.isArray(candidate.trigger) ? candidate.trigger : [candidate.trigger];
    return triggers.some((trigger) => Boolean(trigger.cron));
  });
  if (!definition) throw new Error(`No scheduled workflow registered as ${workflowId}`);
  return executeDefinition(definition, {
    id: `cron:${workflowId}:${new Date().toISOString()}`,
    name: `cron/${workflowId}`,
    data: {},
  });
}

export const workflow = {
  createFunction(
    config: { id: string; retries?: number; [key: string]: unknown },
    trigger: WorkflowDefinition["trigger"],
    handler: WorkflowDefinition["handler"],
  ): WorkflowDefinition {
    return { ...config, id: config.id, retries: config.retries, trigger, handler };
  },

  async send(eventOrEvents: WorkflowEvent | WorkflowEvent[]) {
    const events = Array.isArray(eventOrEvents) ? eventOrEvents : [eventOrEvents];
    const ids: string[] = [];
    const { dispatchWorkflowEvent } = await import("./dispatcher.js");
    for (const event of events) {
      if (event.name === "email/approval-response") {
        ids.push(`approval:${event.name}`);
        continue;
      }
      const run = await start(dispatchWorkflowEvent, [event]);
      ids.push(run.runId);
    }
    return { ids };
  },

  async startScheduled(workflowId: string) {
    const { dispatchScheduledWorkflow } = await import("./dispatcher.js");
    const run = await start(dispatchScheduledWorkflow, [workflowId]);
    return { runId: run.runId };
  },
};

export const dispatchWorkflowEvent = (event: WorkflowEvent) => workflow.send(event);
