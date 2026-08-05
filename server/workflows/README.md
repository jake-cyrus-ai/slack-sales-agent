# Durable workflows

This directory contains the event registry and sales automation jobs executed through Vercel Workflow.

## Execution model

- `client.ts` is the provider-neutral event and step compatibility contract used by routes and skills.
- `dispatcher.ts` contains the two compiled Vercel workflows: event dispatch and scheduled dispatch.
- `execution-step.ts` is the Node.js step boundary. Provider SDKs, Supabase, models, and Slack calls execute there rather than in the deterministic workflow sandbox.
- `functions/index.ts` registers event and cron definitions.
- `middleware/org-validation.ts` revalidates user/organization claims before business logic runs.

Slack approval requests are persisted before a workflow yields. An authenticated Slack interaction checks the tenant and approving user, then starts an idempotent follow-up event. Approval state is therefore durable without keeping function compute active during a human wait.

## Add an event workflow

1. Add its payload type to `events.ts`.
2. Create a definition under `functions/` with `workflow.createFunction(...)`.
3. Put external calls inside named `step.run(...)` operations.
4. Export and register the definition in `functions/index.ts`.
5. Add mocked success, failure, idempotency, and tenant-isolation tests.

The public trigger API is:

```typescript
import { workflow } from "./workflows/client.js";

await workflow.send({
  name: "sales/example.requested",
  data: { userId, organizationId },
});
```

## Development and validation

```bash
pnpm dev:vercel
pnpm exec workflow web
pnpm check:workflows
pnpm build:workflows
pnpm test:workflow
```

`nitro.config.ts` installs the Workflow compiler for Express. Production builds emit Vercel Build Output API functions and Workflow's well-known flow/step routes.
