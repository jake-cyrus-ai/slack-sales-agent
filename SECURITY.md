# Security

Please report vulnerabilities privately to the repository owner instead of opening a public issue. Do not include live credentials, tokens, customer data, or message contents in a report.

## Deployment responsibility

This repository is deployable reference software, not a hosted service. Operators are responsible for provider-app review, secrets management, data-processing terms, retention policy, monitoring, backups, and incident response.

## Security controls

- Slack HMAC verification includes timestamp replay protection.
- OAuth callbacks validate state; Attio and Granola use PKCE and constrain discovered endpoints to provider domains.
- OAuth credentials are encrypted before database storage and must never enter model context, Slack responses, browser payloads, or logs.
- Clerk protects onboarding/settings routes; organization membership and PostgreSQL RLS enforce tenant isolation.
- Consequential email and CRM actions are idempotent and audited. Approval is the default; autonomous email requires explicit organization configuration.
- CORS, redirect destinations, webhook rate limits, and health endpoints are configurable.

Use separate provider applications and databases for development and production. Rotate secrets immediately if they are exposed, revoke affected provider connections, and review audit records before reconnecting.
