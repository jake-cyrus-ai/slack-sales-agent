# Bring-your-own-keys deployment

The reference deployment runs the web UI, Express API, Slack webhooks, OAuth callbacks, schedules, and durable workflows on Vercel. Supabase provides Postgres and storage; Clerk secures the configuration UI. Slack remains the product interface.

## Requirements

- Node.js 22 and pnpm 10
- a Vercel project on Pro or higher (the included frequent cron schedules and extended function duration exceed Hobby limits)
- Supabase and Clerk projects
- a Slack app created from `examples/slack-app-manifest.example.json`
- Anthropic and OpenAI API keys
- optional Google and Salesforce OAuth applications

Attio and Granola use their provider-hosted MCP servers. They perform OAuth discovery and PKCE, so deployers do not create Attio or Granola client applications.

## Database

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
cp .env.example .env
openssl rand -base64 32 # use this as CREDENTIAL_ENCRYPTION_KEY
pnpm setup:supabase
```

The bootstrap stores an encrypted installation secret, creates the private documents bucket, and verifies encryption. Retain `CREDENTIAL_ENCRYPTION_KEY` in your secret manager. The server uses `SUPABASE_JWT_SECRET` for short-lived RLS-bound worker tokens; never expose it to the browser.

## Authentication

Enable Organizations in Clerk. In Supabase Authentication > Third-Party Auth, add Clerk and configure the Clerk session token with `role: "authenticated"`. Send Clerk organization, membership, and user create/update/delete webhooks to:

```text
https://YOUR_DOMAIN/api/webhooks/clerk
```

Set the endpoint's signing secret as `CLERK_WEBHOOK_SIGNING_SECRET`.

## Vercel

Import the repository into Vercel, leave the build settings from `vercel.json` in place, and add the server-side variables documented in `.env.example`. At minimum, production requires Slack, Supabase, Clerk, model, credential-encryption, workflow, and `CRON_SECRET` configuration.

Validate the same values locally before deploying:

```bash
pnpm check:env:production
pnpm run check:workflows
```

Vercel automatically discovers functions compiled by the Workflow package. `vercel.json` routes API and OAuth requests to Express and registers the durable scheduled jobs. Vercel Cron authenticates those routes using `CRON_SECRET`.

Deploy with the dashboard or CLI:

```bash
pnpm dlx vercel@latest
pnpm dlx vercel@latest --prod
```

For local callback testing, run `pnpm dev:vercel` and expose it through a temporary HTTPS tunnel. Provider redirect URLs must use that tunnel origin.

## Provider callbacks

For `https://agent.example.com`, register exactly:

| Provider | URL |
| --- | --- |
| Slack OAuth | `https://agent.example.com/api/oauth/slack/callback` |
| Slack Events | `https://agent.example.com/api/webhooks/slack/events` |
| Slack Interactivity | `https://agent.example.com/api/webhooks/slack/interactivity` |
| Google | `https://agent.example.com/email/callback` |
| Salesforce | `https://agent.example.com/api/salesforce/oauth/callback` |
| Attio MCP | `https://agent.example.com/api/oauth/attio/callback` |
| Granola MCP | `https://agent.example.com/api/oauth/granola/callback` |

Production requires HTTPS and exact redirect URI matching. Update `SERVER_BASE_URL`, `FRONTEND_URL`, and `ALLOWED_ORIGINS` before connecting providers.

## Smoke test

1. Sign in, create or select an organization, and install Slack.
2. Connect Google and either Salesforce or Attio; optionally connect Granola.
3. Verify each integration reports healthy.
4. DM the Slack app and request an account summary and meeting brief.
5. Draft an email, approve it in Slack, and confirm the provider outcome is audited.
6. Propose a CRM mutation and confirm an authorized user must approve it.
7. Correct a response and confirm feedback and preference provenance are recorded.

Use `/health` for liveness. Protect `/health/deep` with `HEALTH_CHECK_SECRET` on public deployments.
