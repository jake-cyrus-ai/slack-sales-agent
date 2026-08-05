import "dotenv/config";

type Requirement = { name: string; why: string; productionOnly?: boolean; oneOf?: string[] };

const requirements: Requirement[] = [
  { name: "SERVER_BASE_URL", why: "OAuth and webhook callbacks" },
  { name: "FRONTEND_URL", why: "OAuth completion redirects" },
  { name: "ALLOWED_ORIGINS", why: "browser CORS allowlist" },
  { name: "SUPABASE_URL", why: "database and Storage" },
  { name: "SUPABASE_ANON_KEY", why: "RLS-scoped clients" },
  { name: "SUPABASE_SERVICE_ROLE_KEY", why: "trusted backend jobs" },
  { name: "SUPABASE_JWT_SECRET", why: "worker RLS tokens" },
  { name: "CREDENTIAL_ENCRYPTION_KEY", why: "OAuth credential encryption" },
  { name: "ANTHROPIC_API_KEY", why: "agent reasoning" },
  { name: "OPENAI_API_KEY", why: "embeddings" },
  { name: "SLACK_APP_ID", why: "workspace resolution" },
  { name: "SLACK_CLIENT_ID", why: "Slack installation OAuth" },
  { name: "SLACK_CLIENT_SECRET", why: "Slack installation OAuth" },
  { name: "SLACK_SIGNING_SECRET", why: "Slack request verification" },
  { name: "CLERK_SECRET_KEY", why: "onboarding authentication" },
  { name: "VITE_CLERK_PUBLISHABLE_KEY", why: "onboarding authentication" },
  { name: "CLERK_WEBHOOK_SIGNING_SECRET", why: "identity synchronization" },
  { name: "INNGEST_EVENT_KEY", why: "durable workflow events", productionOnly: true },
  { name: "INNGEST_SIGNING_KEY", why: "durable workflow verification", productionOnly: true },
  { name: "GOOGLE_CLIENT_ID", why: "Gmail and Calendar OAuth", oneOf: ["GOOGLE_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_ID"] },
  { name: "GOOGLE_CLIENT_SECRET", why: "Gmail and Calendar OAuth", oneOf: ["GOOGLE_CLIENT_SECRET", "GOOGLE_CALENDAR_CLIENT_SECRET"] },
];

const production = process.argv.includes("--production") || process.env.NODE_ENV === "production";
const missing = requirements.filter((item) => {
  if (item.productionOnly && !production) return false;
  const names = item.oneOf ?? [item.name];
  return !names.some((name) => process.env[name]?.trim());
});

const errors: string[] = [];
for (const name of ["SERVER_BASE_URL", "FRONTEND_URL"]) {
  const value = process.env[name];
  if (!value) continue;
  try {
    const parsed = new URL(value);
    if (production && parsed.protocol !== "https:") errors.push(`${name} must use HTTPS in production`);
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) errors.push(`${name} must be an origin without a path, query, or fragment`);
  } catch {
    errors.push(`${name} is not a valid URL`);
  }
}

if ((process.env.CREDENTIAL_ENCRYPTION_KEY?.length ?? 0) < 32) {
  errors.push("CREDENTIAL_ENCRYPTION_KEY must contain at least 32 characters");
}

if (missing.length || errors.length) {
  for (const item of missing) process.stderr.write(`Missing ${item.oneOf?.join(" or ") ?? item.name}: ${item.why}\n`);
  for (const error of errors) process.stderr.write(`${error}\n`);
  process.exit(1);
}

process.stdout.write(`Environment is valid for ${production ? "production" : "development"}.\n`);
