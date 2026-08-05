import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260803155844_baseline.sql"),
  "utf8",
);

describe("fresh Supabase installation contract", () => {
  it("contains the tenant, workflow, approval, preference, feedback, and integration data model", () => {
    for (const table of [
      "organizations", "profiles", "organization_users", "slack_workspaces",
      "slack_user_mappings", "oauth_connections", "calendar_credentials",
      "granola_credentials", "attio_credentials", "salesforce_credentials",
      "conversations", "workflow_runs", "email_approval_requests",
      "user_preferences", "user_learnings", "feedback_events", "audit_events",
      "idempotency_keys",
    ]) {
      expect(migration).toContain(`public.${table}`);
    }
  });

  it("provisions backend-only credential encryption with the correct base64 decode", () => {
    expect(migration).toContain("public.app_secrets");
    expect(migration).toContain("credential_encryption_key");
    expect(migration).toContain("decode(encrypted_access,  'base64')");
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.decrypt_token(text) FROM PUBLIC");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.decrypt_token(text) TO service_role");
  });

  it("enables RLS for every credential and tenant table", () => {
    for (const table of [
      "app_secrets", "organizations", "profiles", "organization_users",
      "slack_workspaces", "calendar_credentials", "granola_credentials",
      "attio_credentials", "salesforce_credentials", "user_preferences",
      "user_learnings", "feedback_events",
    ]) {
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
    }
  });

  it("does not include removed product or customer features", () => {
    expect(migration.toLowerCase()).not.toContain("cyrus");
    expect(migration).not.toContain("legal_document_translations");
  });
});
