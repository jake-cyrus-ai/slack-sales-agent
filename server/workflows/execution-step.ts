import type { WorkflowEvent } from "./client";

export async function executeEventStep(event: WorkflowEvent) {
  "use step";
  const client = await import("./client");
  return client.executeEvent(event);
}

export async function executeScheduledStep(workflowId: string) {
  "use step";
  const client = await import("./client");
  return client.executeScheduled(workflowId);
}
