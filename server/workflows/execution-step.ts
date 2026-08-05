import type { WorkflowEvent } from "./client.js";

export async function executeEventStep(event: WorkflowEvent) {
  "use step";
  const client = await import("./client.js");
  return client.executeEvent(event);
}

export async function executeScheduledStep(workflowId: string) {
  "use step";
  const client = await import("./client.js");
  return client.executeScheduled(workflowId);
}
