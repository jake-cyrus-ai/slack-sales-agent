import 'dotenv/config';

// =============================================================================
// Slack — each environment sets canonical SLACK_* vars directly in its .env file.
// No toggle or suffix resolution needed.
// =============================================================================

// SLACK_APP_ID must be set explicitly per environment to the real Slack App ID
// (e.g. "A0AR5RDKLCA", from api.slack.com/apps). It must NOT be derived from
// SLACK_CLIENT_ID — the first segment of a client ID is a team/workspace ID,
// never an app ID, so the old derive set SLACK_APP_ID to a value that could
// never match slack_workspaces.slack_app_id, breaking every workspace lookup
// with workspace_not_found. Fail fast if it is set to something malformed.
if (process.env.SLACK_APP_ID && !/^A[A-Z0-9]{7,}$/.test(process.env.SLACK_APP_ID)) {
  throw new Error(
    `SLACK_APP_ID is "${process.env.SLACK_APP_ID}", which is not a valid Slack App ID ` +
      `(expected format like "A0AR5RDKLCA"). Set it to the real App ID from api.slack.com/apps.`,
  );
}
// Also set VITE_SLACK_CLIENT_ID for the frontend
if (process.env.SLACK_CLIENT_ID) {
  process.env.VITE_SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID;
}

// =============================================================================

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function requiredAny(...names: string[]): string {
  for (const name of names) {
    const val = process.env[name];
    if (val) return val;
  }
  throw new Error(`Missing required env var: ${names.join(' or ')}`);
}

function optional(name: string, fallback = ''): string {
  return process.env[name] || fallback;
}

export const config = {
  port: parseInt(optional('PORT', '3001'), 10),

  // Supabase
  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceRoleKey: requiredAny('SUPABASE_SERVICE_ROLE_KEY', 'SERVICE_ROLE_KEY'),

  // LLM
  anthropicApiKey: required('ANTHROPIC_API_KEY'),
  openaiApiKey: required('OPENAI_API_KEY'),

  // Google OAuth (optional for local dev without Gmail/Calendar features)
  googleClientId: optional('GOOGLE_CALENDAR_CLIENT_ID', optional('GOOGLE_CLIENT_ID')),
  googleClientSecret: optional('GOOGLE_CALENDAR_CLIENT_SECRET', optional('GOOGLE_CLIENT_SECRET')),

  // Slack
  slackAppId: optional('SLACK_APP_ID'),
  slackSigningSecret: optional('SLACK_SIGNING_SECRET'),
  slackBotToken: optional('SLACK_BOT_TOKEN'),
  slackClientId: optional('SLACK_CLIENT_ID'),
  slackClientSecret: optional('SLACK_CLIENT_SECRET'),
  slackTokenEncryptionKey: optional('SLACK_TOKEN_ENCRYPTION_KEY'),
  slackEngineeringWebhookUrl: optional('SLACK_ENGINEERING_WEBHOOK_URL'),

  // Clerk
  clerkSecretKey: optional('CLERK_SECRET_KEY'),
  clerkPublishableKey: optional('CLERK_PUBLISHABLE_KEY'),
  clerkWebhookSigningSecret: optional('CLERK_WEBHOOK_SIGNING_SECRET'),

  // Research
  exaApiKey: optional('EXA_API_KEY'),
  browserbaseApiKey: optional('BROWSERBASE_API_KEY'),
  browserbaseProjectId: optional('BROWSERBASE_PROJECT_ID'),

  // Inngest
  inngestEventKey: optional('INNGEST_EVENT_KEY'),
  inngestSigningKey: optional('INNGEST_SIGNING_KEY'),

  // Salesforce (shared Connected App for per-org OAuth)
  salesforceConnectedAppClientId: optional('SALESFORCE_CONNECTED_APP_CLIENT_ID'),
  salesforceConnectedAppClientSecret: optional('SALESFORCE_CONNECTED_APP_CLIENT_SECRET'),

} as const;
