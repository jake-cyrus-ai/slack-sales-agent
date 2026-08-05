# Slack Sales Agent

A Slack-native, open-source sales agent platform that connects to email, calendars, meeting notes, and CRMs. It prepares meetings, drafts and sends approved emails, executes approved CRM operations, learns user preferences, and can run explicitly configured autonomous email workflows.

## Architecture

```text
Slack
  → signed event and interaction ingestion
  → workspace and user resolution
  → Inngest durable workflows
  → LangGraph supervisor and composed sales skills
  → Gmail / Google Calendar / Granola / Salesforce / Attio
  → approval policy or configured autonomous-email policy
  → Slack response or provider action
  → preferences, feedback, learning, and audit events
```

The repository contains two layers:

- `server/src/agent`, `server/src/skills`, and the Slack/Inngest runtime provide the reusable agent harness.
- The sales skill pack provides email, calendar, transcript, meeting-prep, Salesforce, Attio, preference, and feedback workflows.

## Retained capabilities

- Slack installation, signed events, DMs, mentions, threads, and interactive approvals
- Durable Inngest workflows with retries and failure reporting
- LangGraph supervisor and composable skill manifests
- Gmail and Google Calendar OAuth and operations
- Direct, user-scoped Granola and Attio hosted-MCP integrations
- Salesforce OAuth and CRM tools
- Cross-source meeting preparation
- Email drafting, editing, approval, rejection, and sending
- CRM reads and approval-gated writes
- Explicit and inferred preferences with feedback provenance
- Multi-user and multi-organization isolation through Clerk, Supabase, and RLS
- Optional autonomous inbound-email qualification and response workflows

## Autonomous email policy

Autonomous email is disabled unless an organization explicitly configures it. The workflow classifies inbound messages, gathers account and prospect context, drafts a response, applies configured risk rules, and records its outcome. Deployers should default consequential or ambiguous messages to Slack approval and use the autonomous path only for narrowly defined categories.

The implementation lives in `server/inngest/functions/agents/autonomous-email-agent.ts`. Supporting context helpers live under `server/lib/prospect-context`; they are backend workflow infrastructure, not a prospect-facing chat product.

## Integrations

| Integration | Connection model | Primary use |
| --- | --- | --- |
| Slack | Workspace OAuth | Agent interface and approvals |
| Gmail | User OAuth | Search, drafts, sends, inbound notifications |
| Google Calendar | User OAuth | Events and meeting preparation |
| Granola | Provider-hosted MCP + OAuth 2.1/PKCE | Meeting notes and transcripts |
| Salesforce | Connected App OAuth | Accounts, contacts, opportunities, and tasks |
| Attio | Provider-hosted MCP + OAuth 2.1/PKCE | People, companies, deals, notes, and tasks |

Provider credentials are tenant-scoped and encrypted at rest. Tokens must never enter prompts, Slack messages, browser responses, or logs.

Attio and Granola use provider-hosted OAuth discovery and dynamic client registration, so deployers do not configure a separate Attio or Granola client ID. Their callback URLs still require a publicly reachable `SERVER_BASE_URL`. Google and Salesforce use deployer-owned OAuth applications.

## Local development

Requirements:

- Node.js 22+
- pnpm 9+
- Supabase/Postgres
- Clerk
- Inngest Cloud or the local Inngest development server
- Anthropic API access

```bash
git clone https://github.com/jake-cyrus-ai/slack-sales-agent.git
cd slack-sales-agent
pnpm install --frozen-lockfile
cp .env.example .env
pnpm run dev:all
```

The configuration UI runs on `http://localhost:5173`, the Express API on `http://localhost:3001`, and the local Inngest UI on `http://localhost:8288`.

Create a Slack app from `examples/slack-app-manifest.example.json`. Configure exact HTTPS callback URLs from `.env.example`; never use wildcard redirects.

## Validation

```bash
pnpm run lint
pnpm run build
pnpm run build:server
pnpm run build:server:check
pnpm run test:run
pnpm run test:inngest
```

Tests mock providers and must not require production credentials.

## Production checklist

- Replace all example origins and identifiers.
- Configure a production Supabase project and apply the sanitized baseline migration.
- Configure Clerk, Inngest, Slack, Google, Salesforce, Attio, and Granola applications.
- Store encryption keys and service credentials in a managed secret store.
- Review autonomous-email categories, approval requirements, timeouts, and kill switches.
- Verify tenant isolation and deletion procedures.
- Configure logs, traces, alerts, and dead-letter handling.
- Run tests, builds, dependency audit, and secret scanning before deployment.

## License and security

Licensed under MIT. See `SECURITY.md` for vulnerability reporting and security boundaries.
