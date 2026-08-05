# Bring-your-own-keys deployment

The production topology is one Node container plus managed Supabase, Clerk, and Inngest projects. The Node container serves the configuration UI, API, Slack webhooks, OAuth callbacks, and Inngest handler from one HTTPS origin.

## 1. Create the external projects

Create:

- a Supabase project;
- a Clerk application with Organizations enabled;
- an Inngest application;
- a Slack application from `examples/slack-app-manifest.example.json`;
- an Anthropic API key and an OpenAI API key;
- optional Google and Salesforce OAuth applications.

Attio and Granola do not need deployer-created client IDs. Their hosted MCP servers use OAuth discovery, dynamic client registration, and PKCE.

## 2. Create the database

Install the Supabase CLI, then run:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

Copy `.env.example` to `.env`, fill the Supabase URL and keys, generate a credential key, then bootstrap:

```bash
openssl rand -base64 32
pnpm setup:supabase
```

The bootstrap command stores the installation-specific credential key in the RLS-protected `app_secrets` table, creates the private `documents` bucket, and verifies an encrypt/decrypt round trip. Keep the original `CREDENTIAL_ENCRYPTION_KEY` in your secret manager for disaster recovery.

This release uses a short-lived worker JWT signed with `SUPABASE_JWT_SECRET` to make background jobs obey RLS. Keep the project's legacy JWT secret available until the worker-token implementation is migrated to an imported signing key. Do not expose it to the browser.

## 3. Connect Clerk and Supabase

In Clerk, enable Organizations. In Supabase Authentication → Third-Party Auth, add the Clerk integration. Configure the Clerk session token to include `role: "authenticated"`. Add a Clerk webhook pointing to:

```text
https://YOUR_DOMAIN/api/webhooks/clerk
```

Subscribe to organization, organization-membership, and user create/update/delete events. Put its signing secret in `CLERK_WEBHOOK_SIGNING_SECRET`.

## 4. Configure callback URLs

For a deployment at `https://agent.example.com`, register:

| Provider | URL |
| --- | --- |
| Slack OAuth | `https://agent.example.com/api/oauth/slack/callback` |
| Slack Events | `https://agent.example.com/api/webhooks/slack/events` |
| Slack Interactivity | `https://agent.example.com/api/webhooks/slack/interactivity` |
| Google | `https://agent.example.com/email/callback` |
| Salesforce | `https://agent.example.com/api/salesforce/oauth/callback` |
| Attio MCP | `https://agent.example.com/api/oauth/attio/callback` |
| Granola MCP | `https://agent.example.com/api/oauth/granola/callback` |

Callback URLs must match exactly. Production uses HTTPS and does not support wildcard redirect URIs.

## 5. Validate environment variables

Set the variables described in `.env.example`, then run:

```bash
pnpm check:env:production
```

Google, Salesforce, Exa, Browserbase, and Gmail Pub/Sub are optional until their corresponding skills are enabled. Slack, Supabase, Clerk, Inngest, Anthropic, and OpenAI are required for the reference deployment.

## 6. Deploy the Node container

Any Docker host works:

```bash
docker build -t slack-sales-agent .
docker run --env-file .env -p 3001:3001 slack-sales-agent
```

Render users can create a Blueprint from `render.yaml`. Railway, Fly.io, Cloud Run, and similar services can deploy the included Dockerfile directly. Set `SERVER_BASE_URL`, `FRONTEND_URL`, and `ALLOWED_ORIGINS` to the final HTTPS origin before connecting providers.

## 7. Register Inngest

Point the Inngest application at:

```text
https://YOUR_DOMAIN/api/inngest
```

Set both `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`. Production startup refuses to run without the signing key.

## 8. Smoke test

1. Open the hosted URL and sign in.
2. Create or select an organization.
3. Connect Slack and Google.
4. Optionally connect Salesforce, Attio, or Granola.
5. DM the Slack app: `What can you help me with?`
6. Request a meeting brief.
7. Draft an email and verify the Slack approval buttons.
8. Propose a CRM mutation and verify that it cannot execute without an authorized approval.

Use `/health` for a liveness probe and protect `/health/deep` with `HEALTH_CHECK_SECRET` in public deployments.
