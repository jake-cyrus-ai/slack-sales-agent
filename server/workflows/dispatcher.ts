import type { WorkflowEvent } from "./client.js";
import { executeEventStep, executeScheduledStep } from "./execution-step.js";

export async function dispatchWorkflowEvent(event: WorkflowEvent) {
  "use workflow";

  return executeEventStep(event);
}

export async function dispatchScheduledWorkflow(workflowId: string) {
  "use workflow";

  return executeScheduledStep(workflowId);
}
