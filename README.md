# Slack Sales Agent

A Slack-native, open-source sales agent platform that connects to email, calendars, meeting notes, and CRMs. It prepares meetings, drafts emails, executes approved CRM operations, and learns user preferences over time.

## What ships

- Slack installation, signed Events API ingestion, DMs, mentions, threads, and interactive approvals
- durable Vercel workflow dispatch with retries, delayed work, persisted human approvals, and failure reporting
- a LangGraph supervisor that routes and composes sales skills inside durable Vercel Workflow runs
- Gmail and Google Calendar OAuth, search, drafting, sending, and meeting preparation
- direct Attio and Granola hosted-MCP connections using OAuth discovery and PKCE
- Salesforce accounts, contacts, opportunities, tasks, notes, and approval-gated writes
- explicit and inferred preferences, corrections, feedback provenance, and tenant isolation
- optional autonomous inbound-email qualification and response policies
- a small Supabase Auth configuration UI; Slack remains the primary product surface

```text
Slack → verified event → tenant resolution → Vercel Workflow → supervisor
      → sales skills → approval/autonomous policy → provider action
      → audit, feedback, and preference learning
```

Vercel Workflow and LangGraph have separate responsibilities. Vercel Workflow owns durable execution, retries, schedules, delayed work, and resumable processes. LangGraph runs inside that durable boundary and decides which sales skills and tools should handle a request.

## Context and memory

The platform separates durable knowledge from historical output:

| Category | Purpose | Proactively injected? |
| --- | --- | --- |
| `preference` | Explicit or well-supported user instructions, such as tone and briefing format | Yes, when relevant |
| `relationship_fact` | Structured knowledge about people, companies, accounts, and working relationships | Yes, when relevant |
| `correction` | A user correction linked to its feedback event and source | Yes, when relevant |
| `historical_artifact` | Prior conversations, generated briefs, drafts, and run output | No |

Historical artifacts remain available when a user explicitly asks about a previous conversation or output, but they are never treated as current business state. Date-sensitive calendar questions must query Google Calendar directly. Current email and CRM state should likewise come from the connected provider rather than recalled conversation text.

Sensitive message bodies are not promoted into durable learning by default. Memories retain tenant ownership, source provenance, and category metadata.

## Canonical relationships

People and companies can have canonical, organization-scoped relationship records with lifecycle stages such as `prospect`, `qualified`, `opportunity`, `customer`, `former_customer`, and `partner`.

Consequential changes use an approval proposal rather than silently rewriting context. For example:

```text
Salesforce opportunity becomes Closed Won
→ propose Acme: prospect → customer
→ show evidence and before/after values
→ authorized owner or admin approves
→ verify the canonical record has not changed
→ apply atomically
→ append immutable history and an audit event
```

Stale proposals fail with a conflict instead of overwriting newer information. The authenticated relationship API supports creating canonical records and proposing, approving, or rejecting lifecycle changes. Dedicated Slack buttons for relationship proposals are not yet included.

## Quick start

Requirements: Node.js 22+, pnpm 10+, a Supabase project, Vercel, Slack, Anthropic, and OpenAI. The included high-frequency cron schedules require a Vercel plan that supports them.

```bash
git clone https://github.com/jake-cyrus-ai/slack-sales-agent-harness.git
cd slack-sales-agent-harness
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
```

Create and migrate Supabase:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
pnpm setup:supabase
```

Validate configuration and run locally:

```bash
pnpm check:env
pnpm dev:all
```

Vercel CLI prints the local origin (normally `http://localhost:3000`) and serves the UI, API, callbacks, and workflow runtime together.

For a production bring-your-own-keys walkthrough, callback URL table, Supabase Auth setup, and smoke test, see [Deployment](docs/DEPLOYMENT.md). Provider-specific details are in [Google OAuth](docs/guides/GOOGLE-OAUTH.md) and [Salesforce OAuth](docs/guides/SALESFORCE-ONBOARDING.md).

## Integration ownership

| Integration | Connection model |
| --- | --- |
| Slack | deployer-owned Slack app |
| Gmail and Calendar | deployer-owned Google OAuth app |
| Salesforce | deployer-owned Connected App |
| Attio | direct provider-hosted MCP OAuth |
| Granola | direct provider-hosted MCP OAuth |

Provider tokens are encrypted before persistence and are never included in model prompts, Slack responses, browser payloads, or structured logs. Email sends require approval by default. Autonomous email must be enabled explicitly at the organization level. CRM mutations remain approval-first.

## Validation

```bash
pnpm lint
pnpm exec tsc --noEmit
pnpm build:server:check
pnpm check:workflows
pnpm test:run
pnpm test:workflow
pnpm test:tools
pnpm build
pnpm build:server
pnpm audit --audit-level high
```

Tests use mocked providers and do not require live credentials. GitHub Actions runs type checks, tests, builds, dependency checks, and secret scanning.

## Status

This repository is intended to be deployed by operators who bring their own provider accounts and keys. It does not include hosted OAuth credentials, customer data, production infrastructure, or a managed control plane.

MIT licensed. See [Security](SECURITY.md) and [Contributing](CONTRIBUTING.md).
