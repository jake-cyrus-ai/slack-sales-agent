import type { WorkflowEvent } from "./client";
import { executeEventStep, executeScheduledStep } from "./execution-step";

export async function dispatchWorkflowEvent(event: WorkflowEvent) {
  "use workflow";

  return executeEventStep(event);
}

export async function dispatchScheduledWorkflow(workflowId: string) {
  "use workflow";

  return executeScheduledStep(workflowId);
}
