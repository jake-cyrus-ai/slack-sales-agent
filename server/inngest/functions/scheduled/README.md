# Scheduled Inngest Functions

This directory contains scheduled functions that run on a cron schedule via Inngest.

## Functions

### poll-gmail-inboxes.ts

**Cron Schedule:** Every 5 minutes (`*/5 * * * *`)

**Purpose:** Polls Gmail for new emails as a fallback when push notifications aren't working.

**Migration Source:** `supabase/functions/gmail-poll-inbox`

**How it works:**
1. Main function (`pollGmailInboxes`) runs every 5 minutes
2. Queries for users with active calendar credentials and email_auto_response feature enabled
3. Fans out events to trigger individual polling jobs for each user
4. Individual function (`pollUserInbox`) processes each user:
   - Refreshes Google OAuth tokens
   - Fetches recent emails (last 10 minutes or since last poll)
   - Extracts email content and metadata
   - Stores emails in `incoming_emails` table
   - Triggers email qualification for new emails

**Key improvements over Supabase:**
- Durable execution with built-in retries
- Better observability via Inngest dashboard
- Automatic state management (no manual checkpoint tracking)
- Concurrency control (max 10 users polled simultaneously)

### sync-all-calendars.ts

**Cron Schedule:** Every hour (`0 * * * *`)

**Purpose:** Syncs Google Calendar events for all users with active calendar connections.

**Migration Source:** `supabase/functions/sync-all-calendars`

**How it works:**
1. Queries for users with active calendar credentials
2. Fans out `calendar/sync` events for each user
3. Individual sync is handled by `calendar/sync-calendar-events.ts`

**Key improvements over Supabase:**
- Event-driven fan-out pattern
- Better error tracking per user
- No need to manage HTTP calls between functions

## Multi-Tenancy

All functions respect organization boundaries using `organization_id` for data isolation:
- Emails are scoped to user's current organization
- Feature flags (like `email_auto_response`) are checked per organization
- Calendar events include organization_id for proper data isolation

## Environment Variables

Required environment variables:
- `GOOGLE_CLIENT_ID` or `GOOGLE_CALENDAR_CLIENT_ID` - Google OAuth client ID
- `GOOGLE_CLIENT_SECRET` or `GOOGLE_CALENDAR_CLIENT_SECRET` - Google OAuth client secret
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key

## Testing

To test scheduled functions locally:
1. Run Inngest dev server: `npx inngest-cli dev`
2. Use Inngest dashboard to manually trigger cron functions
3. Monitor execution in the dashboard

## Events Emitted

### poll-gmail-inboxes
- `email/poll-inbox` - Triggered for each user to poll (handled by `pollUserInbox`)
- `email/qualify` - Triggered for each new email found (handled by `qualifyEmailAgent`)

### sync-all-calendars
- `calendar/sync` - Triggered for each user to sync (handled by `syncCalendarEvents`)
