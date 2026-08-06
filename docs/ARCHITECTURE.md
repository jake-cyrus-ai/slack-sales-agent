# Architecture

```text
Slack
  -> signed event and interaction routes
  -> workspace and user resolution
  -> Vercel durable workflow
  -> supervisor
  -> composable sales skills
       Gmail / Calendar / Granola / Salesforce / Attio
       meeting prep / email / CRM operations / preferences
  -> approval policy
  -> Slack response or approved provider action
  -> audit, feedback, and preference learning
```

## Runtime

`server/index.ts` exports the Express application used by `api/index.ts`. It owns Slack installation and request verification, OAuth callbacks, onboarding/settings endpoints, connection health, and Vercel Cron entry points. Events are acknowledged quickly and handed to the durable dispatcher in `server/workflows`.

Vercel Workflow provides durable dispatch and retries. The compatibility layer in `server/workflows/client.ts` exposes a small event/step contract to the sales workflows. Approval proposals are persisted before the workflow yields; verified Slack interactions resume the business process as new idempotent workflow events. This keeps days-long human waits out of function compute while retaining an auditable approval boundary.

## Sales skill pack

The supervisor in `server/src/agent` selects and composes skills registered in `server/src/skills`. Integration-dependent skills register only when the current user or organization has the required healthy connection. Provider credentials are resolved inside adapters and never placed in prompts, Slack messages, client payloads, or logs.

Attio and Granola are direct hosted-MCP connections. Google and Salesforce use first-party OAuth adapters. Consequential email and CRM writes produce an approval proposal with tenant, actor, target, idempotency, and before/after data before execution.

## Storage and isolation

The sanitized Supabase baseline contains organizations, users, Slack mappings, encrypted connections, conversations, runs, approvals, preferences, learning/feedback/audit events, and idempotency keys. RLS and application checks enforce organization and user boundaries. Durable workflows revalidate tenant claims before provider or model operations.

## Deployment boundary

Vercel is the reference compute and workflow platform; Supabase provides the state and authentication layers. The React UI is intentionally limited to installation, connections, health, approval policy, preferences, disconnect/deletion, and onboarding confirmation.
