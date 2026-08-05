# Scheduled workflows

Vercel Cron calls the authenticated `/api/cron/:workflowId` route. The allowlisted schedules live in `vercel.json`; each identifier must match a cron definition registered in `functions/index.ts`.

Scheduled jobs cover Gmail polling and watch renewal, calendar sync, meeting and follow-up scans, reminders, action digests, morning briefings, feedback learning, onboarding readiness, and usage rollups. Fan-out events retain the originating organization and user identity, and the runtime revalidates tenant membership before provider access.

Test schedules with mocks; do not call provider APIs from tests. `pnpm check:workflows`, `pnpm test:workflow`, and the Vercel production-preset build validate registration and compilation.
