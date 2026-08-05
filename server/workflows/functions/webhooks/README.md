# Webhook workflows

Public HTTP routes in `server/index.ts` verify provider signatures, deduplicate deliveries, acknowledge promptly, and dispatch normalized events here. Business logic never trusts workspace, user, or organization identifiers directly from an unverified payload.

- `slack-message.ts` resolves the workspace/user and routes DMs, mentions, and threads to the supervisor.
- `slack-interaction.ts` handles approval buttons and modals, checks the approving actor, and starts idempotent email or CRM actions.
- `gmail-notification.ts` processes verified Pub/Sub notifications and fans out email qualification work.
- `document-share.ts` processes authenticated document-share events.

Tests use fixtures and mocked provider clients. Add replay, invalid-signature, cross-tenant, unauthorized-approval, and duplicate-delivery coverage when extending a handler.
