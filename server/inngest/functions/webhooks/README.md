# Webhook Handler Functions

This directory contains Inngest functions that handle incoming webhooks from external services (Gmail, Slack, etc.). These functions are triggered by events sent from the API endpoints in `/server/index.ts`.

## Architecture Overview

```
External Service → API Endpoint → Inngest Event → Webhook Handler Function → Agent Functions
```

### Flow Example: Gmail Push Notifications

1. **Gmail** sends push notification to `/api/webhooks/gmail`
2. **API endpoint** verifies signature and sends `email/notification` event to Inngest
3. **handleGmailNotification** function processes the notification
4. Function fetches new emails and fans out `email/qualify` events
5. **qualifyEmailAgent** processes each email

## Functions

### 1. Gmail Notification Handler (`gmail-notification.ts`)

**Event:** `email/notification`  
**Triggered by:** Gmail Pub/Sub push notifications via `/api/webhooks/gmail`

**Purpose:**
- Receives Gmail push notifications when new emails arrive
- Fetches email details using Gmail History API
- Filters out internal emails (same domain)
- Queues external emails for qualification
- Fans out to `email/qualify` events

**Environment Variables:**
- `GOOGLE_CALENDAR_CLIENT_ID` - Google OAuth client ID
- `GOOGLE_CALENDAR_CLIENT_SECRET` - Google OAuth client secret
- `SUPABASE_URL` - Supabase instance URL
- `SERVICE_ROLE_KEY` - Supabase service role key

**Database Dependencies:**
- `calendar_credentials` - User Gmail credentials
- `profiles` - User profiles with organization info
- `organizations` - Feature flags for email auto-response
- `gmail_watch_subscriptions` - Gmail watch subscription state
- `incoming_emails` - Queue for incoming emails

**Steps:**
1. Get user credentials from calendar_credentials
2. Check if email auto-response feature is enabled
3. Get last processed historyId from gmail_watch_subscriptions
4. Refresh access token and fetch new emails
5. Process each message (filter, extract, store)
6. Fan out to email qualification
7. Update last processed historyId

### 2. Slack Interaction Handler (`slack-interaction.ts`)

**Event:** `slack/interaction`  
**Triggered by:** Slack interactive components via `/api/webhooks/slack/interactivity`

**Purpose:**
- Handles button clicks from Slack messages (email approval buttons)
- Processes modal submissions
- Updates Slack messages with action results
- Sends approval/rejection events to email workflow

**Supported Actions:**
- `email_approve` - Approve and send email draft
- `email_reject` - Cancel/reject email draft
- `email_show_full` - Show full email content in thread

**Environment Variables:**
- `SLACK_TOKEN_ENCRYPTION_KEY` - Key for decrypting Slack bot tokens
- `SUPABASE_URL` - Supabase instance URL
- `SERVICE_ROLE_KEY` - Supabase service role key

**Database Dependencies:**
- `slack_workspaces` - Slack workspace configurations
- `slack_user_mappings` - Maps Slack users to Sales Agent users
- `email_auto_response_drafts` - Email drafts awaiting approval

**Steps:**
1. Get workspace details and bot token
2. Decrypt bot token if encrypted
3. Get user mapping (Slack user → Sales Agent user)
4. Get draft details from database
5. Process action (approve/reject/show_full)
6. Send event to email workflow
7. Update Slack message with result

### 3. Slack Message Handler (`slack-message.ts`)

**Event:** `slack/message`  
**Triggered by:** Slack message events via `/api/webhooks/slack/events`

**Purpose:**
- Handles incoming Slack messages and commands
- Links Slack users to Sales Agent accounts
- Classifies message intent
- Routes to appropriate agent functions

**Supported Intents:**
- `meeting-prep` - Trigger meeting preparation
- `search-docs` - Search knowledge base documents
- `contact-management` - Manage customer/prospect contacts
- `chat` - General chat with AI assistant

**Commands:**
- `/prep` - Prepare for upcoming meeting
- `/docs [query]` - Search documents
- `Add [email] as a [customer/prospect]` - Add contact

**Environment Variables:**
- `SLACK_TOKEN_ENCRYPTION_KEY` - Key for decrypting Slack bot tokens
- `SUPABASE_URL` - Supabase instance URL
- `SERVICE_ROLE_KEY` - Supabase service role key

**Database Dependencies:**
- `slack_workspaces` - Slack workspace configurations
- `slack_user_mappings` - Maps Slack users to Sales Agent users

**Steps:**
1. Get workspace details and bot token
2. Decrypt bot token
3. Link Slack user to Sales Agent account
4. Classify message intent
5. Route to appropriate handler
6. Send acknowledgment to Slack

## Setup Instructions

### 1. Gmail Push Notifications

**Google Cloud Console:**
1. Create a Pub/Sub topic (e.g., `gmail-notifications`)
2. Create a push subscription pointing to: `https://your-domain.com/api/webhooks/gmail`
3. Grant Gmail API service account publish permissions
4. Enable Gmail API for your project

**Slack Configuration:**
1. Go to your Slack app settings
2. Navigate to "Event Subscriptions"
3. Set Request URL to: `https://your-domain.com/api/webhooks/slack/events`
4. Subscribe to workspace events:
   - `app_mention` - When bot is mentioned
   - `message.channels` - Public channel messages
   - `message.im` - Direct messages

### 2. Slack Interactivity

**Slack Configuration:**
1. Go to your Slack app settings
2. Navigate to "Interactivity & Shortcuts"
3. Enable Interactivity
4. Set Request URL to: `https://your-domain.com/api/webhooks/slack/interactivity`

### 3. Environment Variables

Add to your `.env` file:

```bash
# Google OAuth
GOOGLE_CALENDAR_CLIENT_ID=your-client-id
GOOGLE_CALENDAR_CLIENT_SECRET=your-client-secret

# Slack
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_TOKEN_ENCRYPTION_KEY=your-encryption-key

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SERVICE_ROLE_KEY=your-service-role-key
```

## Testing

### Local Development

1. Start Inngest Dev Server:
```bash
npx inngest-cli@latest dev
```

2. Start Express Server:
```bash
npm run server:dev
```

3. Use ngrok to expose local server:
```bash
ngrok http 3001
```

4. Update webhook URLs in Google Cloud Console and Slack to use ngrok URL

### Test Gmail Webhook

```bash
# Send test Gmail push notification
curl -X POST http://localhost:3001/api/webhooks/gmail \
  -H "Content-Type: application/json" \
  -d '{
    "message": {
      "data": "eyJlbWFpbEFkZHJlc3MiOiJ0ZXN0QGV4YW1wbGUuY29tIiwiaGlzdG9yeUlkIjoiMTIzNDUifQ=="
    }
  }'
```

### Test Slack Interaction

```bash
# Send test Slack interaction
curl -X POST http://localhost:3001/api/webhooks/slack/interactivity \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d 'payload={"type":"block_actions","actions":[{"action_id":"email_approve","value":"draft-123"}],"user":{"id":"U123"},"team":{"id":"T123"},"channel":{"id":"C123"},"message":{"ts":"1234567890.123456"}}'
```

### Test Slack Message

```bash
# Send test Slack message event
curl -X POST http://localhost:3001/api/webhooks/slack/events \
  -H "Content-Type: application/json" \
  -d '{
    "type":"event_callback",
    "event":{
      "type":"message",
      "user":"U123",
      "text":"Hello bot!",
      "channel":"C123",
      "team_id":"T123"
    }
  }'
```

## Monitoring

### Inngest Dashboard

View function runs, steps, and errors at: `http://localhost:8288` (dev) or your Inngest Cloud dashboard (production)

### Logs

- Server logs: Check console output from Express server
- Function logs: Check Inngest dashboard for detailed step-by-step execution
- Database logs: Query Supabase logs for database operations

## Error Handling

All webhook handlers include:
- Automatic retries (2-3 attempts)
- Step-based error recovery
- Graceful degradation (skip on errors, don't fail entire workflow)
- Detailed logging for debugging

### Common Issues

1. **Signature verification failed**
   - Check `SLACK_SIGNING_SECRET` is correct
   - Ensure timestamp is not too old (5 min window)
   - Verify webhook URL is accessible from internet

2. **User not found**
   - Ensure Slack user is mapped in `slack_user_mappings` table
   - Check user has linked their accounts

3. **Gmail credentials not found**
   - User needs to connect Gmail via OAuth
   - Check `calendar_credentials` table has active entry

4. **Feature disabled**
   - Check organization's `feature_flags` in database
   - Ensure `email_auto_response.enabled` is true

## Security

All webhooks include:
- ✅ Signature verification (Gmail JWT, Slack HMAC)
- ✅ Timestamp validation (prevent replay attacks)
- ✅ Rate limiting (100 req/min per IP)
- ✅ Request ID tracking
- ✅ Input validation

## Migration Notes

These functions replace the following Supabase Edge Functions:
- `gmail-push-webhook/` → `gmail-notification.ts`
- `slack-bot-handler/` → `slack-message.ts`
- `slack-interactivity-handler/` → `slack-interaction.ts`

### Key Differences from Supabase

1. **Event-driven**: Webhooks emit events instead of calling functions directly
2. **Durable execution**: Inngest manages state, no manual checkpointing
3. **Better observability**: Step-by-step execution visible in dashboard
4. **Automatic retries**: Built-in retry logic with exponential backoff
5. **Type safety**: Full TypeScript support with typed events

## Related Documentation

- [Inngest Documentation](https://www.inngest.com/docs)
- [Gmail Push Notifications](https://developers.google.com/gmail/api/guides/push)
- [Slack Events API](https://api.slack.com/apis/connections/events-api)
- [Slack Interactivity](https://api.slack.com/interactivity)
