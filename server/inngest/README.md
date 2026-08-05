# Inngest Setup Documentation

## Overview

This directory contains the Inngest infrastructure for the Slack Sales Agent application. Inngest provides durable execution, automatic retries, and observability for all background jobs and workflows.

## Directory Structure

```
server/inngest/
├── client.ts              # Inngest client configuration
├── events.ts              # Event schema definitions (TypeScript types)
├── functions/             # Inngest function implementations
│   ├── index.ts          # Function registry (exports all functions)
│   ├── knowledge-base/   # KB search and management functions
│   ├── email/            # Email processing functions
│   ├── calendar/         # Calendar sync and meeting prep functions
│   ├── agents/           # LangGraph agent workflows
│   ├── webhooks/         # Webhook handler functions
│   └── scheduled/        # Cron-scheduled functions
└── utils/                # Shared utility functions
    ├── llm/              # AI client utilities
    ├── google/           # Google API helpers
    ├── slack/            # Slack API helpers
    └── prompts/          # LLM prompts
```

## Running the Server

### Development

Run both the Vite frontend and Inngest backend:

```bash
npm run dev:all
```

Or run them separately:

```bash
# Terminal 1 - Frontend
npm run dev

# Terminal 2 - Backend
npm run dev:server
```

### Production

Build and start the server:

```bash
npm run build
npm run build:server
npm run start:server
```

## Inngest Dev Server

For local development with the Inngest dashboard, run (with the app server already running on port 3001):

```bash
pnpm run dev:inngest
```

Or with the full stack:

```bash
pnpm run dev:all
```

This will:
- Start the Inngest Dev Server at **http://localhost:8288**
- Sync with your app at `http://localhost:3001/api/inngest`
- Provide a dashboard to view function runs, steps, and logs
- Enable local testing of functions

## Testing Inngest (match production behavior)

Inngest functions replace the previous Supabase Edge Functions. To confirm they behave the same in dev as in production:

1. **Start the stack**  
   `pnpm run dev:all` (Vite on 8080, server on 3001, Inngest dev server on 8288).

2. **Open the dashboard**  
   Go to **http://localhost:8288**. You’ll see:
   - **Apps** – your app and its registered functions
   - **Runs** – each function run, status (running/succeeded/failed), and duration
   - **Events** – events sent to Inngest
   - **Stream** – live event and run activity

3. **Trigger events**  
   - **From the app:** Use the test endpoints (e.g. `GET /api/test/slack/message`, `GET /api/test/gmail`) or real webhooks; they send events to Inngest.  
   - **From the CLI:**  
     ```bash
     pnpm run test:inngest-trigger -- --event email/feedback.extract --data '{"userId":"test-123"}'
     ```
   - **From the dashboard:** In the Stream tab you can send test events.

4. **Verify behavior**  
   - In **Runs**, open a run to see step-by-step execution and logs.  
   - Check for failed runs and use the error and stack trace to debug.  
   - Compare inputs/outputs and side effects (DB, Slack, email) with what you expect from the old Edge Functions.

5. **Unit tests**  
   Run Inngest-related tests:  
   `pnpm run test:inngest`

## Creating New Functions

### 1. Define Event Types

Add your event types to `events.ts`:

```typescript
export interface MyEventData {
  userId: string;
  someField: string;
}

export type Events = {
  // ... existing events
  "my/event": { data: MyEventData };
};
```

### 2. Create Function

Create a new file in the appropriate directory (e.g., `functions/my-category/my-function.ts`):

```typescript
import { inngest } from "../../client";

export const myFunction = inngest.createFunction(
  { 
    id: "my-function",
    retries: 3,
  },
  { event: "my/event" },
  async ({ event, step }) => {
    const result = await step.run("step-name", async () => {
      // Your logic here
      return { success: true };
    });
    
    return result;
  }
);
```

### 3. Register Function

Add to `functions/index.ts`:

```typescript
import { myFunction } from "./my-category/my-function";

export const functions = [
  // ... existing functions
  myFunction,
];
```

## Sending Events

From anywhere in your application:

```typescript
import { inngest } from "@/inngest/client";

await inngest.send({
  name: "my/event",
  data: {
    userId: "123",
    someField: "value",
  },
});
```

## Key Concepts

### Step Functions

Inngest functions use `step.run()` to create durable execution points. If a step fails, Inngest will retry from that step (not the entire function):

```typescript
await step.run("step-1", async () => {
  // This will retry independently
});

await step.run("step-2", async () => {
  // This only runs after step-1 succeeds
});
```

### Human-in-the-Loop

Use `step.waitForEvent()` to pause execution until a specific event is received:

```typescript
const approval = await step.waitForEvent("email/approval-response", {
  timeout: "7d",
  match: "data.draftId",
});
```

### Fan-out Processing

Send multiple events in parallel:

```typescript
await step.sendEvent("fan-out", items.map(item => ({
  name: "process/item",
  data: { itemId: item.id },
})));
```

### Scheduled Functions

Use cron triggers for recurring jobs:

```typescript
export const myScheduledJob = inngest.createFunction(
  { id: "my-scheduled-job" },
  { cron: "0 * * * *" }, // Every hour
  async ({ step }) => {
    // Job logic
  }
);
```

## Webhook Endpoints

The server provides these webhook endpoints:

- `POST /api/webhooks/gmail` - Gmail push notifications
- `POST /api/webhooks/slack` - Slack events

## Monitoring

### Local Development

Access the Inngest Dev Server dashboard at http://localhost:8288

### Production

Use the Inngest Cloud dashboard at https://app.inngest.com to:
- View function runs
- Inspect step execution
- Debug failures
- Monitor performance
- Set up alerts

### Failure Alerting

The `handle-function-failure` function provides centralized alerting for all permanently failed functions (after exhausting all retries). It listens for the `inngest/function.failed` system event and:

1. **Logs** the failure with structured data (function ID, run ID, error, original event)
2. **Sends Slack alerts** to the #engineering channel (if configured)

To enable Slack alerting, set the webhook URL in your environment:

```env
SLACK_ENGINEERING_WEBHOOK_URL=https://hooks.slack.com/services/YOUR_WORKSPACE/YOUR_CHANNEL/YOUR_TOKEN
```

To create a Slack Incoming Webhook:
1. Go to [Slack API Apps](https://api.slack.com/apps)
2. Select your app (or create one)
3. Navigate to "Incoming Webhooks" → Enable → "Add New Webhook to Workspace"
4. Select the #engineering channel
5. Copy the webhook URL

The alert includes:
- Function ID and Run ID
- Error type and message
- Original triggering event name and data preview
- Direct link to the Inngest Dashboard for that run

## Environment Variables

Required environment variables (same as Supabase Edge Functions):

```env
# Supabase
SUPABASE_URL=
SERVICE_ROLE_KEY=

# OpenAI
OPENAI_API_KEY=

# Anthropic
ANTHROPIC_API_KEY=

# Google OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Slack
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=

# Alerting (optional but recommended for production)
SLACK_ENGINEERING_WEBHOOK_URL=  # Slack Incoming Webhook for #engineering alerts
```

## Migration Status

### ✅ Phase 1: Setup & Infrastructure (COMPLETE)
- Inngest SDK installed
- Client configured
- Event schemas defined
- Serve handler created

### 🔄 Phase 2: Shared Utilities (IN PROGRESS)
- Converting Deno imports to Node.js
- Migrating shared modules

### ⏳ Phase 3: Simple Functions (PENDING)
- Knowledge base functions
- Email utilities
- Calendar helpers

### ⏳ Phase 4+: Complex Workflows (PENDING)
- Agent workflows
- Webhooks
- Scheduled jobs

## Resources

- [Inngest Documentation](https://www.inngest.com/docs)
- [Inngest TypeScript SDK](https://github.com/inngest/inngest-js)
- [Step Functions Guide](https://www.inngest.com/docs/functions/step-functions)
