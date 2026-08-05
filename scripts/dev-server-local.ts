/**
 * Boot the Express server pointed at the LOCAL Supabase stack.
 *
 * Why this exists instead of just `tsx --env-file=...`:
 *   Node 22's native --env-file parser has an edge case where one of the
 *   value shapes in .env.development causes ANTHROPIC_API_KEY to be silently
 *   dropped (other keys in the same file load fine). The `dotenv` library
 *   parses the same file cleanly, so we bypass --env-file entirely and load
 *   via dotenv before importing the server.
 *
 * Layering:
 *   .env.development  — dev defaults (hosted dev Supabase, real API keys)
 *   .env.local        — local-only overrides (points Supabase at 127.0.0.1)
 *
 * Usage:
 *   pnpm dev:server:local
 */

import { config as loadDotenv } from "dotenv";

// Order matters: later loads override earlier ones.
loadDotenv({ path: ".env.development", override: true });
loadDotenv({ path: ".env.local", override: true });

if (!process.env.SUPABASE_URL?.includes("127.0.0.1") &&
    !process.env.SUPABASE_URL?.includes("localhost")) {
  console.error(
    "REFUSING to boot dev:server:local — SUPABASE_URL is not local. " +
      "Did you forget to create .env.local with the local Supabase overrides?"
  );
  process.exit(1);
}

console.log(`[dev-server-local] SUPABASE_URL=${process.env.SUPABASE_URL}`);
console.log("[dev-server-local] Booting server/index.ts ...\n");

await import("../server/index.ts");
