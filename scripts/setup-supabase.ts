import "dotenv/config";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}. Add it to .env before running setup:supabase.`);
  return value;
};

const url = required("SUPABASE_URL");
const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
const encryptionKey = required("CREDENTIAL_ENCRYPTION_KEY");

if (encryptionKey.length < 32) {
  throw new Error("CREDENTIAL_ENCRYPTION_KEY must contain at least 32 characters. Generate one with: openssl rand -base64 32");
}

const supabase = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  const { error: secretError } = await supabase.from("app_secrets").upsert(
    {
      name: "credential_encryption_key",
      value: encryptionKey,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "name" },
  );
  if (secretError) {
    throw new Error(`Could not provision credential encryption. Did you run supabase db push? ${secretError.message}`);
  }

  const { data: buckets, error: bucketListError } = await supabase.storage.listBuckets();
  if (bucketListError) throw new Error(`Could not list Storage buckets: ${bucketListError.message}`);
  if (!buckets.some((bucket) => bucket.id === "documents")) {
    const { error: bucketError } = await supabase.storage.createBucket("documents", {
      public: false,
      fileSizeLimit: 20 * 1024 * 1024,
      allowedMimeTypes: ["application/pdf", "text/plain", "text/markdown"],
    });
    if (bucketError) throw new Error(`Could not create documents bucket: ${bucketError.message}`);
  }

  const probe = `bootstrap-${crypto.randomUUID()}`;
  const { data: encrypted, error: encryptError } = await supabase.rpc("encrypt_token", { token: probe });
  if (encryptError || !encrypted) throw new Error(`Encryption check failed: ${encryptError?.message ?? "empty ciphertext"}`);
  const { data: decrypted, error: decryptError } = await supabase.rpc("decrypt_token", { encrypted_token: encrypted });
  if (decryptError || decrypted !== probe) throw new Error(`Decryption check failed: ${decryptError?.message ?? "round trip mismatch"}`);

  const { error: cleanupError } = await supabase.from("app_secrets").delete().eq("name", "bootstrap_probe");
  if (cleanupError) throw new Error(`Bootstrap cleanup failed: ${cleanupError.message}`);

  process.stdout.write("Supabase is ready: schema reachable, encryption verified, and private documents bucket available.\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
