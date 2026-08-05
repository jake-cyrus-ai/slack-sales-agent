# Admin & Onboarding Vercel Workflow Functions

This directory contains administrative and onboarding functions triggered by events rather than HTTP requests.

## Functions

### create-waitlist-user.ts

**Event:** `admin/create-waitlist-user`

**Purpose:** Creates a new user account for a waitlist submission.

**Migration Source:** `supabase/functions/create-waitlist-user`

**How it works:**
1. Generates a signup link via Supabase Auth
2. Creates user account with metadata (first name, last name, company, title, LinkedIn)
3. Triggers Supabase's "Confirm sign up" email template
4. Handles "user already exists" errors gracefully

**Event Data:**
```typescript
{
  email: string;
  firstName: string;
  lastName: string;
  company?: string;
  title?: string;
  linkedinProfile?: string;
}
```

**Returns:**
```typescript
{
  success: boolean;
  message: string;
  userId?: string;
  alreadyExists?: boolean;
}
```

### send-waitlist-approval.ts

**Event:** `admin/send-waitlist-approval`

**Purpose:** Sends approval/invite email to a waitlist user.

**Migration Source:** `supabase/functions/send-waitlist-approval`

**How it works:**
1. Checks if user already exists
2. Auto-confirms email if user exists but email not confirmed
3. Sends invite email via Supabase Auth's `inviteUserByEmail`
4. Triggers Supabase's "Invite user" email template

**Event Data:**
```typescript
{
  email: string;
  firstName: string;
  lastName: string;
  signupLink: string;
}
```

**Returns:**
```typescript
{
  success: boolean;
  message: string;
  email: string;
  userId?: string;
}
```

### send-organization-invite.ts

**Event:** `admin/send-organization-invite`

**Purpose:** Sends an invite email for organization membership.

**Migration Source:** `supabase/functions/send-organization-invite`

**How it works:**
1. Fetches invite details from `organization_invites` table
2. Generates invite URL with token
3. Logs invite URL (email sending to be implemented with Resend/SendGrid)

**Event Data:**
```typescript
{
  inviteId: string;
}
```

**Returns:**
```typescript
{
  success: boolean;
  message: string;
  inviteUrl: string;
  email?: string;
  recipientName?: string;
  organizationName: string;
}
```

**Note:** Currently logs invite URLs. Production implementation should use Resend or SendGrid to send actual emails.

### initialize-sample-deals.ts

**Event:** `onboarding/initialize-deals`

**Purpose:** Creates sample deals for a new user during onboarding.

**Migration Source:** `supabase/functions/initialize-sample-deals`

**How it works:**
1. Checks if user already has deals (scoped to organization)
2. Creates 8 sample deals with various stages and health scores
3. Includes organization_id for multi-tenant isolation

**Event Data:**
```typescript
{
  userId: string;
  organizationId?: string;
}
```

**Returns:**
```typescript
{
  success: boolean;
  message: string;
  deals?: Deal[];
  count: number;
  skipped?: boolean;
}
```

**Sample Deals:**
- 3 "At Risk" deals (Acme Corp, FinTechCo, RetailX, CloudVentures)
- 5 "Healthy" deals (TechStart Inc, Global Solutions, DataCore Systems, InnovateLabs)
- Various stages: MSA Redlines, Security Review, Signature Pending, Negotiation, etc.

## Multi-Tenancy

Admin functions respect organization boundaries:
- `initialize-sample-deals` scopes deals to user's organization
- All functions preserve `organization_id` for proper data isolation

## Migration from HTTP to Events

These functions were originally HTTP endpoints in Supabase Edge Functions. They're now event-driven Vercel Workflow functions:

**Before (Supabase HTTP):**
```typescript
serve(async (req) => {
  const body = await req.json();
  // Process immediately
  return new Response(JSON.stringify(result));
});
```

**After (Vercel Workflow Event-Driven):**
```typescript
workflow.createFunction(
  { id: "admin-function" },
  { event: "admin/event-name" },
  async ({ event, step }) => {
    // Durable execution with steps
    return result;
  }
);
```

**Benefits:**
- Automatic retries on failure
- Better observability in Vercel Workflow dashboard
- Durable execution with step-by-step tracking
- No need to manage HTTP responses

## Usage

To trigger these functions, send events via Vercel Workflow:

```typescript
// Create waitlist user
await workflow.send({
  name: "admin/create-waitlist-user",
  data: {
    email: "user@example.com",
    firstName: "John",
    lastName: "Doe",
    company: "Acme Corp",
  },
});

// Initialize sample deals
await workflow.send({
  name: "onboarding/initialize-deals",
  data: {
    userId: "user-uuid",
    organizationId: "org-uuid",
  },
});
```

## Environment Variables

Required:
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key
- `FRONTEND_URL` or `NEXT_PUBLIC_APP_URL` - Frontend URL for invite links

## Testing

1. Run Vercel Workflow dev server: `npx workflow-cli dev`
2. Send test events via Vercel Workflow dashboard or programmatically
3. Monitor execution and inspect step-by-step results
4. Check database for created records

## Future Enhancements

- **Email Sending:** Implement Resend or SendGrid for `send-organization-invite`
- **Webhooks:** Add webhook notifications when admin actions complete
- **Analytics:** Track onboarding funnel metrics
- **Bulk Operations:** Add batch user creation/invitation functions
