# Architecture

This repository has two layers: a reusable Slack agent runtime and the bundled sales skill pack.

```text
Slack events and interactions
  -> signature verification and event deduplication
  -> workspace and user resolution
  -> Inngest durable workflow queue
  -> LangGraph supervisor and skill composition
  -> Gmail / Calendar / Granola MCP / Salesforce / Attio MCP
  -> approval policy or autonomous-email policy
  -> Slack response or approved action
  -> preferences, feedback, learning, and audit events
```

## Runtime

`server/index.ts` exposes Slack event, Slack interaction, OAuth, settings, health, and Inngest endpoints. Slack requests are signature-checked before acknowledgement. Inngest provides durable steps, retry, concurrency controls, delayed work, and approval waits. The supervisor in `server/src/agent` routes and composes the skills in `server/src/skills`.

Workspace installation records, Slack-user mappings, and organization membership establish tenant context. Application checks and PostgreSQL row-level security prevent cross-organization and cross-user access.

## Integrations

- Google OAuth provides Gmail and Google Calendar access.
- Salesforce uses a Connected App and refresh-token OAuth.
- Attio connects directly to Attio's hosted MCP server using OAuth 2.1 dynamic client registration and PKCE.
- Granola connects directly to Granola's hosted MCP server using OAuth 2.1 discovery and PKCE.

Provider credentials are encrypted before persistence. Tokens are decrypted only inside provider clients and are never included in prompts, Slack messages, frontend responses, or structured logs.

## Consequential actions

Email sends and CRM mutations create durable, idempotent action records. The default policy requires an authorized Slack approval. Autonomous email is retained as an explicit organization policy: it must be enabled deliberately and remains constrained by classification, qualification, confidence, safety, audit, and idempotency checks. CRM writes remain approval-first.

## Data and learning

The sanitized baseline migration contains organizations, users, Slack installations and mappings, provider connections, conversations, runs, approvals, preferences, learning and feedback events, audits, and idempotency state. Explicit preferences are distinct from inferred learnings; inferred records carry evidence and confidence and are scoped to the relevant user and organization.

## Configuration UI

The React application is intentionally small. It is a configuration and onboarding surface; Slack is the product interface. OAuth initiation/status endpoints and settings APIs are ready for a deployer to connect to their preferred authenticated UI.
