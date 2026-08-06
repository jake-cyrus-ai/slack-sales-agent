# Salesforce Integration: Client Onboarding Guide

This guide covers how to connect a customer's Salesforce org to the app. There are two paths: using our shared Connected App (simpler for the customer) or the customer providing their own Connected App (more control on their side).

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Path A: Using Our Shared Connected App](#path-a-using-our-shared-connected-app)
4. [Path B: Customer Provides Their Own Connected App](#path-b-customer-provides-their-own-connected-app)
5. [How to Create a Salesforce Connected App (Step-by-Step)](#how-to-create-a-salesforce-connected-app)
6. [Required Salesforce Permissions](#required-salesforce-permissions)
7. [Testing the Connection](#testing-the-connection)
8. [Troubleshooting](#troubleshooting)
9. [Disconnecting a Customer](#disconnecting-a-customer)

---

## Overview

the app integrates with Salesforce to read and write CRM data (accounts, opportunities, contacts, leads, cases, tasks, events, notes, and reports). Each customer organization connects their own Salesforce org via OAuth 2.0 Authorization Code flow with PKCE.

**Two connection options:**

| Option | Who creates the Connected App? | What does the customer provide? | Best for |
|--------|-------------------------------|--------------------------------|----------|
| **Path A** (Shared App) | We do (one-time setup) | Nothing — just authorize via OAuth | Most customers |
| **Path B** (Custom App) | The customer | Their `client_id` and `client_secret` | Enterprise customers with strict security policies |

**Architecture:** Credentials are stored encrypted per-organization in the `salesforce_credentials` table. Tokens auto-refresh. All org members share the connection.

---

## Prerequisites

### For our server

- `SALESFORCE_CONNECTED_APP_CLIENT_ID` and `SALESFORCE_CONNECTED_APP_CLIENT_SECRET` set in `.env` (required for Path A; not needed if every customer uses Path B)
- `SERVER_BASE_URL` set correctly (used to construct the OAuth callback URL: `{SERVER_BASE_URL}/api/salesforce/oauth/callback`)
- Database migrations applied (`20260312000000_create_salesforce_credentials.sql` and `20260312000001_create_salesforce_oauth_pending.sql`)

### For the customer

- **Salesforce Edition:** Enterprise, Unlimited, Developer, or Performance (API access required — Essentials and Professional do not include API access by default)
- **Admin Access:** The person authorizing the connection must be a Salesforce administrator (or have the "Manage Connected Apps" permission)
- **App organization membership:** The customer must have an organization in the app, and the person connecting must have the `admin` or `owner` membership role

---

## Path A: Using Our Shared Connected App

This is the simplest path. We maintain a single Salesforce Connected App, and each customer simply authorizes it.

### What we need from the customer

Nothing — they just need to click "Connect Salesforce" and authorize.

### Server setup (one-time)

1. **Create a Connected App** in our Salesforce org (see [How to Create a Salesforce Connected App](#how-to-create-a-salesforce-connected-app) below)
2. Set these env vars:
   ```
   SALESFORCE_CONNECTED_APP_CLIENT_ID=<your Connected App consumer key>
   SALESFORCE_CONNECTED_APP_CLIENT_SECRET=<your Connected App consumer secret>
   ```
3. In the Connected App settings, add the callback URL:
   ```
   {SERVER_BASE_URL}/api/salesforce/oauth/callback
   ```
   Example: `https://sales-agent.example.com/api/salesforce/oauth/callback`

### The connection flow

1. The customer's org admin navigates to Settings in the the app UI
2. Clicks "Connect Salesforce"
3. The frontend calls the Salesforce OAuth initiation endpoint with its Supabase access token and active organization header
4. The server generates a PKCE code challenge + random state, stores it in `salesforce_oauth_pending`, and redirects the user to:
   ```
   https://login.salesforce.com/services/oauth2/authorize
     ?response_type=code
     &client_id={SALESFORCE_CONNECTED_APP_CLIENT_ID}
     &redirect_uri={SERVER_BASE_URL}/api/salesforce/oauth/callback
     &state={random_uuid}
     &code_challenge={sha256_hash}
     &code_challenge_method=S256
     &scope=api refresh_token
   ```
5. The customer logs into Salesforce and approves access
6. Salesforce redirects to our callback: `GET /api/salesforce/oauth/callback?code=...&state=...`
7. The server exchanges the code for tokens, encrypts them, and stores in `salesforce_credentials`
8. The customer is redirected to `/settings?salesforce_connected=true`

### What gets stored

| Column | Value |
|--------|-------|
| `organization_id` | The customer's the app org UUID |
| `instance_url` | e.g., `https://na1.salesforce.com` |
| `access_token_encrypted` | Encrypted via pgcrypto |
| `refresh_token_encrypted` | Encrypted via pgcrypto |
| `token_expiry` | ~2 hours from issue |
| `oauth_client_id` | NULL (uses shared app) |
| `oauth_client_secret_encrypted` | NULL (uses shared app) |
| `sync_status` | `active` |

---

## Path B: Customer Provides Their Own Connected App

Some customers prefer to create their own Connected App to maintain full control over API access. This is common in enterprise environments with strict security policies.

### What we need from the customer

1. **Consumer Key** (`client_id`) — from their Connected App
2. **Consumer Secret** (`client_secret`) — from their Connected App

### What the customer needs to do

1. Create a Connected App in their Salesforce org (see [step-by-step guide](#how-to-create-a-salesforce-connected-app) below)
2. Configure these OAuth settings:
   - **Callback URL:** `{SERVER_BASE_URL}/api/salesforce/oauth/callback`
     - Example: `https://sales-agent.example.com/api/salesforce/oauth/callback`
   - **Selected OAuth Scopes:**
     - `Access the identity URL service (id, profile, email, address, phone)` — or simply `api`
     - `Perform requests at any time (refresh_token, offline_access)`
     - `Access and manage your data (api)`
   - **Require Proof Key for Code Exchange (PKCE):** Recommended to enable
3. Send us their **Consumer Key** and **Consumer Secret**

### The connection flow

Same as Path A, but the OAuth connect URL includes custom credentials:

```
GET /api/salesforce/oauth/connect?custom_client_id={their_client_id}&custom_client_secret={their_client_secret}
```

The server will:
1. Encrypt the `custom_client_secret` before storing in `salesforce_oauth_pending`
2. Use the customer's `client_id` in the Salesforce authorize redirect
3. On callback, use the customer's credentials to exchange the code
4. Store the customer's `client_id` and encrypted `client_secret` in `salesforce_credentials` for future token refreshes

### What gets stored

| Column | Value |
|--------|-------|
| `organization_id` | The customer's the app org UUID |
| `instance_url` | Their Salesforce instance |
| `access_token_encrypted` | Encrypted |
| `refresh_token_encrypted` | Encrypted |
| `oauth_client_id` | Customer's Consumer Key |
| `oauth_client_secret_encrypted` | Encrypted Consumer Secret |
| `sync_status` | `active` |

---

## How to Create a Salesforce Connected App

These steps are for creating a Connected App in Salesforce. Follow these whether you're setting up our shared app (Path A) or guiding a customer through creating their own (Path B).

### Step 1: Navigate to Setup

1. Log into Salesforce as an administrator
2. Click the **gear icon** (top right) > **Setup**
3. In the Quick Find search box, type **"App Manager"**
4. Click **App Manager** under Platform Tools > Apps

### Step 2: Create a New Connected App

1. Click **New Connected App** (top right)
2. Fill in the basic information:
   - **Connected App Name:** `the app CRM Integration` (or whatever name you prefer)
   - **API Name:** `Sales Agent_CRM_Integration` (auto-fills)
   - **Contact Email:** Your admin email

### Step 3: Enable OAuth Settings

1. Check **Enable OAuth Settings**
2. **Callback URL:** Enter the exact callback URL:
   ```
   https://sales-agent.example.com/api/salesforce/oauth/callback
   ```
   (Replace with your actual `SERVER_BASE_URL` if different)
3. **Selected OAuth Scopes:** Add the following:
   - `Access and manage your data (api)`
   - `Perform requests at any time (refresh_token, offline_access)`
4. **Require Proof Key for Code Exchange (PKCE) Extension for Supported Authorization Flows:** Check this box (recommended)
5. Uncheck **Require Secret for Web Server Flow** if you want PKCE-only (optional)
6. Uncheck **Require Secret for Refresh Token Flow** (leave unchecked for simplicity)

### Step 4: Save and Retrieve Credentials

1. Click **Save**
2. You'll see a warning that it takes 2-10 minutes for the app to be available — click **Continue**
3. Click **Manage Consumer Details** (you may need to verify your identity via email code)
4. Copy the:
   - **Consumer Key** — this is the `client_id`
   - **Consumer Secret** — this is the `client_secret`

### Step 5: Configure Policies (Important)

1. Go back to the Connected App page in App Manager
2. Click the **dropdown arrow** next to your app > **Manage**
3. Click **Edit Policies**
4. Under **OAuth Policies:**
   - **Permitted Users:** Select `All users may self-authorize` (simplest) or `Admin approved users are pre-authorized` (if you want to restrict)
   - **IP Relaxation:** Select `Relax IP restrictions` (recommended for cloud-hosted apps)
   - **Refresh Token Policy:** Select `Refresh token is valid until revoked` (recommended)
5. Click **Save**

### Step 6: Wait for Propagation

Connected App changes can take **2-10 minutes** to propagate across Salesforce. If OAuth fails immediately after creation, wait and try again.

---

## Required Salesforce Permissions

The user who authorizes the connection (and whose token is used for API calls) must have access to the following Salesforce objects and fields. Typically, a user with the **System Administrator** or **Standard User** profile has all of these.

### Objects — Read Access Required

| Object | Used By | Key Fields |
|--------|---------|------------|
| **Account** | Account Lookup, List Accounts | Id, Name, Industry, Website, Type, Phone, BillingCity/State/Country, AnnualRevenue, NumberOfEmployees, OwnerId |
| **Opportunity** | Opportunities, Update Opportunity | Id, Name, StageName, Amount, CloseDate, Probability, NextStep, Description, ForecastCategory, Type, LeadSource, IsClosed, IsWon |
| **Contact** | Contacts | Id, Name, Title, Email, Phone, MobilePhone, Department, AccountId, LeadSource |
| **Lead** | Leads | Id, Name, Title, Company, Email, Phone, Status, LeadSource, Rating, Industry, IsConverted |
| **Case** | Cases | Id, CaseNumber, Subject, Description, Status, Priority, Type, Origin, AccountId, ContactId, IsClosed, IsEscalated |
| **Task** | Tasks/Events, Create Task, Log Activity | Id, Subject, Status, Priority, ActivityDate, Description, WhatId, WhoId, TaskSubtype |
| **Event** | Tasks/Events | Id, Subject, StartDateTime, EndDateTime, Location, Description, WhatId, WhoId |
| **Note** | Notes | Id, Title, Body (legacy Note object) |
| **ContentDocumentLink** | Notes | ContentDocumentId, ContentDocument.Title (for ContentNote/enhanced notes) |
| **Report** | Reports | Id, Name, Description, FolderName, Format, LastRunDate |

### Objects — Write Access Required

| Object | Used By | Fields Written |
|--------|---------|---------------|
| **Opportunity** | Update Opportunity, Create Opportunity | StageName, Amount, CloseDate, NextStep, Description, Probability, Name, AccountId, Type, LeadSource |
| **Task** | Create Task, Log Activity | Subject, Status, Priority, ActivityDate, WhatId, WhoId, Description, TaskSubtype, CallType |

### Analytics API

The **Reports** tool also uses the Salesforce Analytics API (`/services/data/v59.0/analytics/reports/`) to execute reports. The authorizing user must have the **"Run Reports"** permission.

### How to verify permissions

If a customer reports that certain tools aren't working, check their Salesforce user's:
1. **Profile** — determines default object and field permissions
2. **Permission Sets** — may grant additional access
3. **Sharing Rules / OWD** — determines which records are visible (Organization-Wide Defaults)
4. **Field-Level Security** — determines which fields are readable/writable

---

## Testing the Connection

### 1. Check connection status via API

```bash
curl -H "Authorization: Bearer {supabase_access_token}" \
  -H "X-Organization-ID: {organization_uuid}" \
  "https://sales-agent.example.com/api/salesforce/oauth/status"
```

Expected response for a connected org:
```json
{
  "connected": true,
  "syncStatus": "active",
  "instanceUrl": "https://na1.salesforce.com",
  "connectedBy": "user_2abc123",
  "connectedAt": "2026-03-12T10:00:00.000Z",
  "usesCustomApp": false
}
```

### 2. Verify in the database

```sql
SELECT
  organization_id,
  instance_url,
  sync_status,
  connected_by_user_id,
  connected_at,
  token_expiry,
  oauth_client_id IS NOT NULL AS uses_custom_app
FROM salesforce_credentials
WHERE organization_id = '<org-uuid>';
```

Check that:
- `sync_status` is `active`
- `token_expiry` is in the future
- `instance_url` matches the customer's Salesforce org

### 3. Test a query via the API

```bash
curl -X POST "https://sales-agent.example.com/api/salesforce/query" \
  -H "Authorization: Bearer {supabase_access_token}" \
  -H "X-Organization-ID: {organization_uuid}" \
  -H "Content-Type: application/json" \
  -d '{"query": "List 3 accounts in Salesforce"}'
```

Expected: The agent should return account names from the customer's Salesforce org.

### 4. Test specific permissions

To verify object-level and field-level permissions, you can adapt the permission check script at `scripts/test/sfdc-permission-check.ts`. That script currently uses the old Client Credentials flow, but the checks it runs are useful as a reference.

**Manual permission check via SOQL (using a decrypted token):**

```bash
# Get the access token (from the database, decrypted)
# Then test each object:

# Accounts
curl -H "Authorization: Bearer {access_token}" \
  "https://{instance_url}/services/data/v59.0/query?q=SELECT+Id,Name+FROM+Account+LIMIT+1"

# Opportunities
curl -H "Authorization: Bearer {access_token}" \
  "https://{instance_url}/services/data/v59.0/query?q=SELECT+Id,Name,StageName+FROM+Opportunity+LIMIT+1"

# Contacts
curl -H "Authorization: Bearer {access_token}" \
  "https://{instance_url}/services/data/v59.0/query?q=SELECT+Id,Name,Email+FROM+Contact+LIMIT+1"

# Leads
curl -H "Authorization: Bearer {access_token}" \
  "https://{instance_url}/services/data/v59.0/query?q=SELECT+Id,Name,Company+FROM+Lead+LIMIT+1"

# Cases
curl -H "Authorization: Bearer {access_token}" \
  "https://{instance_url}/services/data/v59.0/query?q=SELECT+Id,CaseNumber,Subject+FROM+Case+LIMIT+1"

# Tasks
curl -H "Authorization: Bearer {access_token}" \
  "https://{instance_url}/services/data/v59.0/query?q=SELECT+Id,Subject,Status+FROM+Task+LIMIT+1"

# Reports
curl -H "Authorization: Bearer {access_token}" \
  "https://{instance_url}/services/data/v59.0/query?q=SELECT+Id,Name+FROM+Report+LIMIT+1"
```

If any of these return a `MALFORMED_QUERY`, `INVALID_FIELD`, or `INSUFFICIENT_ACCESS` error, the user's profile is missing permissions for that object/field.

### 5. Test write permissions

```bash
# Create a test task
curl -X POST "https://{instance_url}/services/data/v59.0/sobjects/Task" \
  -H "Authorization: Bearer {access_token}" \
  -H "Content-Type: application/json" \
  -d '{"Subject": "the app Integration Test", "Status": "Not Started", "Priority": "Normal"}'
```

Expected: HTTP 201 with a response containing the new Task ID. Delete the test task afterward:

```bash
curl -X DELETE "https://{instance_url}/services/data/v59.0/sobjects/Task/{task_id}" \
  -H "Authorization: Bearer {access_token}"
```

---

## Troubleshooting

### "Salesforce is not connected for this organization"

**Cause:** No row in `salesforce_credentials` for this org, or `sync_status` is not `active`.

**Fix:** The org admin needs to go through the OAuth connect flow.

### "Salesforce token refresh failed"

**Cause:** The refresh token was revoked (admin revoked the Connected App in Salesforce), or the Connected App was deleted/modified.

**Fix:**
1. Check `salesforce_credentials.sync_status` — if it's `expired`, the customer needs to re-authorize
2. In Salesforce Setup > Connected Apps OAuth Usage, verify the app is still authorized
3. Have the admin disconnect and reconnect via the app Settings

### "error=redirect_uri_mismatch"

**Cause:** The callback URL in the OAuth request doesn't match what's configured in the Salesforce Connected App.

**Fix:** Ensure the Connected App's callback URL exactly matches:
```
{SERVER_BASE_URL}/api/salesforce/oauth/callback
```
No trailing slash. Protocol must match (https vs http).

### "error=invalid_client_id"

**Cause:** The `client_id` is wrong or the Connected App hasn't propagated yet.

**Fix:** Verify the Consumer Key. If just created, wait 2-10 minutes.

### "INSUFFICIENT_ACCESS" or "INVALID_FIELD" errors on queries

**Cause:** The Salesforce user who authorized doesn't have permissions for the object or field.

**Fix:** In Salesforce Setup:
1. Check the user's **Profile** for object-level permissions
2. Check **Permission Sets** assigned to the user
3. Check **Field-Level Security** for specific fields
4. The user should ideally have System Administrator or a custom profile with full CRM access

### "error=invalid_grant" on token refresh

**Cause:** The refresh token has been invalidated. This can happen if:
- The Salesforce admin revoked all OAuth tokens
- The Connected App's refresh token policy expired the token
- The user's password was changed (resets all OAuth tokens in some orgs)

**Fix:** Disconnect and reconnect.

### OAuth state expired

**Cause:** The user took longer than 10 minutes between clicking "Connect" and completing Salesforce login.

**Fix:** Try again — the 10-minute window resets each attempt.

---

## Disconnecting a Customer

### Via API

```bash
curl -X POST "https://sales-agent.example.com/api/salesforce/oauth/disconnect" \
  -H "Authorization: Bearer {supabase_access_token}" \
  -H "X-Organization-ID: {organization_uuid}"
```

This will:
1. Revoke the access token at Salesforce (best-effort)
2. Delete the `salesforce_credentials` row
3. Clear the in-memory connection cache

### Via Database (manual)

```sql
DELETE FROM salesforce_credentials
WHERE organization_id = '<org-uuid>';
```

Note: This doesn't revoke the token at Salesforce. The customer can also revoke from their side in Salesforce Setup > Connected Apps OAuth Usage.

### Customer-side revocation

If the customer wants to revoke access from their end:
1. Salesforce Setup > **Connected Apps OAuth Usage**
2. Find the Connected App (either "the app CRM Integration" or their custom app name)
3. Click **Revoke** next to the authorized user

This will invalidate the tokens. The next API call from the app will fail, and `sync_status` will be set to `expired` after the next refresh attempt.
