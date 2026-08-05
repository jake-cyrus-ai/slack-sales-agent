# Google OAuth setup

Google OAuth supplies both Gmail and Google Calendar access. Each deployer owns this OAuth application; Attio and Granola's hosted-MCP connection model does not apply to Google.

1. Create a Google Cloud project and configure its OAuth consent screen.
2. Enable Gmail API, Google Calendar API, and (for Gmail push delivery) Cloud Pub/Sub API.
3. Create a Web application OAuth client.
4. Register the exact browser callback from `GOOGLE_OAUTH_REDIRECT_URI`, normally `https://sales-agent.example.com/email/callback`. The configuration UI forwards the state-validated code to the backend.
5. Configure the Google client variables shown in `.env.example`.
6. Add test users while the consent screen is in testing status, or complete Google's production verification before serving arbitrary users.

Use the smallest scopes your enabled skills need. Read-only Gmail/Calendar installations should omit send/compose scopes. Email sending requires Gmail send/compose scopes and must remain approval-gated unless an organization deliberately enables a constrained autonomous-email policy.

Local callback URLs can use localhost. Production callbacks must use HTTPS, match the registered URI exactly, and point to the hosted Express service—not the static frontend.

Never commit client secrets or provider tokens. Disconnecting a Google connection revokes it where possible and removes the encrypted local credential record; reconnecting starts a new state-validated authorization flow.
