/**
 * Global Vercel Workflow Failure Handler
 *
 * Listens for the `workflow/function.failed` system event to provide centralized
 * alerting when any Vercel Workflow function fails after exhausting all retries.
 *
 * Alerts are sent to:
 * - Slack #engineering channel (if SLACK_ENGINEERING_WEBHOOK_URL is configured)
 * - PagerDuty (if PAGERDUTY_ROUTING_KEY is configured)
 * - Console logs (always)
 */

import { workflow } from "../../client";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "handle-function-failure" });

interface FunctionFailedEventData {
  error: {
    __serialized?: boolean;
    error?: string;
    message: string;
    name: string;
    stack?: string;
  };
  event: {
    data: Record<string, unknown>;
    id: string;
    name: string;
    ts: number;
    user?: Record<string, unknown>;
  };
  function_id: string;
  run_id: string;
}

const SLACK_ENGINEERING_WEBHOOK_URL =
  process.env.SLACK_ENGINEERING_WEBHOOK_URL;

const PAGERDUTY_ROUTING_KEY = process.env.PAGERDUTY_ROUTING_KEY;

const PAGERDUTY_EVENTS_API_URL =
  "https://events.pagerduty.com/v2/enqueue";

const formatErrorForSlack = (
  functionId: string,
  runId: string,
  error: FunctionFailedEventData["error"],
  originalEvent: FunctionFailedEventData["event"]
): object => {
  const timestamp = new Date().toISOString();
  const eventDataPreview = JSON.stringify(originalEvent.data, null, 2).slice(
    0,
    500
  );

  return {
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🚨 Vercel Workflow Function Failed",
          emoji: true,
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Function:*\n\`${functionId}\``,
          },
          {
            type: "mrkdwn",
            text: `*Run ID:*\n\`${runId}\``,
          },
        ],
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Error Type:*\n${error.name}`,
          },
          {
            type: "mrkdwn",
            text: `*Time:*\n${timestamp}`,
          },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Error Message:*\n\`\`\`${error.message}\`\`\``,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Original Event:*\n\`${originalEvent.name}\` (ID: \`${originalEvent.id}\`)`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Event Data Preview:*\n\`\`\`${eventDataPreview}${eventDataPreview.length >= 500 ? "..." : ""}\`\`\``,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `<https://app.workflow.com/env/production/functions/${encodeURIComponent(functionId)}/logs/${runId}|View in Vercel Workflow Dashboard>`,
          },
        ],
      },
      {
        type: "divider",
      },
    ],
  };
};

interface PagerDutyPayload {
  routing_key: string;
  event_action: "trigger";
  dedup_key: string;
  payload: {
    summary: string;
    severity: "critical" | "error" | "warning" | "info";
    source: string;
    timestamp: string;
    custom_details: Record<string, unknown>;
  };
  links?: Array<{ href: string; text: string }>;
}

const formatErrorForPagerDuty = (
  functionId: string,
  runId: string,
  error: FunctionFailedEventData["error"],
  originalEvent: FunctionFailedEventData["event"]
): PagerDutyPayload => {
  const timestamp = new Date().toISOString();

  return {
    routing_key: PAGERDUTY_ROUTING_KEY!,
    event_action: "trigger",
    dedup_key: `workflow-failure-${functionId}-${runId}`,
    payload: {
      summary: `Vercel Workflow function "${functionId}" failed: ${error.message.slice(0, 200)}`,
      severity: "error",
      source: "workflow",
      timestamp,
      custom_details: {
        function_id: functionId,
        run_id: runId,
        error_name: error.name,
        error_message: error.message,
        error_stack: error.stack?.slice(0, 1000),
        original_event_name: originalEvent.name,
        original_event_id: originalEvent.id,
        original_event_data: JSON.stringify(originalEvent.data).slice(0, 500),
      },
    },
    links: [
      {
        href: `https://app.workflow.com/env/production/functions/${encodeURIComponent(functionId)}/logs/${runId}`,
        text: "View in Vercel Workflow Dashboard",
      },
    ],
  };
};

export const handleFunctionFailure = workflow.createFunction(
  {
    id: "handle-function-failure",
    retries: 3,
  },
  { event: "workflow/function.failed" },
  async ({ event, step }) => {
        const data = event.data as unknown as FunctionFailedEventData;
    const { error, event: originalEvent, function_id, run_id } = data;

    // Skip self-referential failures to prevent infinite loops
    if (function_id === "handle-function-failure") {
      log.warn("Skipping alert for self-failure to prevent infinite loop");
      return { status: "skipped", reason: "self-referential failure" };
    }

    // handle-slack-message has its own forensic telemetry in slack_error_events.
    // Every caught error during Slack chat handling is already captured there
    // with the user's message, thread permalink, agent state, and replayable
    // event payload — so we intentionally do NOT page #engineering here.
    // Developers query slack_error_events on their own schedule.
    if (function_id === "handle-slack-message") {
      log.info(
        { run_id },
        "Skipping Slack alert for handle-slack-message — telemetry lives in slack_error_events",
      );
      return { status: "skipped", reason: "handled by slack_error_events" };
    }

    // Log the failure
    log.error({ functionId: function_id, runId: run_id, errorName: error.name, errorMessage: error.message, originalEventName: originalEvent.name, originalEventId: originalEvent.id }, "Function permanently failed");

    // Send Slack alert if webhook URL is configured
    if (SLACK_ENGINEERING_WEBHOOK_URL) {
      await step.run("send-slack-alert", async () => {
              const slackPayload = formatErrorForSlack(
          function_id,
          run_id,
          error,
          originalEvent
        );

        const response = await fetch(SLACK_ENGINEERING_WEBHOOK_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(slackPayload),
        });

        if (!response.ok) {
          const responseText = await response.text();
          log.error({ status: response.status, body: responseText }, "Failed to send Slack alert");
          throw new Error(
            `Slack webhook failed: ${response.status} - ${responseText}`
          );
        }

        log.info({ functionId: function_id }, "Slack alert sent successfully");
        return { sent: true };
      });
    } else {
      log.warn("SLACK_ENGINEERING_WEBHOOK_URL not configured, skipping Slack alert");
    }

    // Send PagerDuty alert if routing key is configured
    if (PAGERDUTY_ROUTING_KEY) {
      await step.run("send-pagerduty-alert", async () => {
              const pagerDutyPayload = formatErrorForPagerDuty(
          function_id,
          run_id,
          error,
          originalEvent
        );

        const response = await fetch(PAGERDUTY_EVENTS_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(pagerDutyPayload),
        });

        if (!response.ok) {
          const responseText = await response.text();
          log.error({ status: response.status, body: responseText }, "Failed to send PagerDuty alert");
          throw new Error(
            `PagerDuty Events API failed: ${response.status} - ${responseText}`
          );
        }

        const result = await response.json();
        log.info({ functionId: function_id, dedup_key: result.dedup_key }, "PagerDuty alert sent successfully");
        return { sent: true, dedup_key: result.dedup_key };
      });
    } else {
      log.warn("PAGERDUTY_ROUTING_KEY not configured, skipping PagerDuty alert");
    }

    return {
      status: "alerted",
      functionId: function_id,
      runId: run_id,
      slackAlertSent: !!SLACK_ENGINEERING_WEBHOOK_URL,
      pagerDutyAlertSent: !!PAGERDUTY_ROUTING_KEY,
    };
  }
);
