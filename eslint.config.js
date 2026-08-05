import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // Disable no-explicit-any for test files (everywhere).
    // Mocking, stubs, and assertion helpers legitimately use any.
    files: [
      "**/__tests__/**/*.{ts,tsx}",
      "**/*.test.{ts,tsx}",
      "src/test/**/*.{ts,tsx}",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // Disable no-explicit-any for dev/test scripts.
    files: ["scripts/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // Disable no-explicit-any for external API adapters, webhook payload
    // boundaries, and legacy integration code where upstream SDK types are
    // incomplete or intentionally untyped.
    //
    // Covers:
    //   server/routes/**         — Express handlers dealing with external payloads
    //   server/webhooks/**       — Raw webhook ingestion (Clerk, Stripe, etc.)
    //   server/index.ts          — Top-level server bootstrap
    //   server/webhookVerification.ts
    //   server/lib/**            — Server-side utility libs
    //   server/inngest/**        — Inngest function bodies (event/webhook handlers)
    //   server/src/salesforce/** — Salesforce SDK adapter layer
    //   server/src/attio/**      — Attio SDK adapter layer
    //   server/src/tools/**      — Tool implementations calling external APIs
    //   server/src/services/**   — Service layer (Supabase, third-party)
    //   server/src/lib/**        — Internal utility libs
    //   server/src/slack/**      — Slack adapter layer
    //   server/src/middleware/**  — Express middleware
    //   server/src/types/**      — Shared type declarations
    //   server/src/index.ts
    //   src/**                   — Frontend: React code, pages, components
    files: [
      "server/index.ts",
      "server/webhookVerification.ts",
      "server/lib/**/*.{ts,tsx}",
      "server/routes/**/*.{ts,tsx}",
      "server/webhooks/**/*.{ts,tsx}",
      "server/inngest/**/*.{ts,tsx}",
      "server/src/index.ts",
      "server/src/attio/**/*.{ts,tsx}",
      "server/src/lib/**/*.{ts,tsx}",
      "server/src/middleware/**/*.{ts,tsx}",
      "server/src/salesforce/**/*.{ts,tsx}",
      "server/src/services/**/*.{ts,tsx}",
      "server/src/slack/**/*.{ts,tsx}",
      "server/src/tools/**/*.{ts,tsx}",
      "server/src/types/**/*.{ts,tsx}",
      "src/**/*.{ts,tsx}",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // Re-enforce no-explicit-any for the core agent and skill architecture.
    // These modules are the semantic heart of the system — precise types here
    // prevent silent runtime errors from unvalidated LLM outputs.
    files: [
      "server/src/agent/**/*.{ts,tsx}",
      "server/src/skills/**/*.{ts,tsx}",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    // Disciplined-hybrid boundary rule: the frontend must route all Supabase
    // mutations through Express. Direct Supabase is only for RLS-protected
    // reads, realtime subscriptions, and auth session reads. Enforced as
    // "error" — every pre-existing violation has been migrated to an Express
    // route + a typed hook in src/lib/api/*.
    // See CLAUDE.md "Frontend ↔ Supabase Boundary" for the rule and process.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.object.type='CallExpression'][callee.object.callee.type='MemberExpression'][callee.object.callee.property.name='from'][callee.property.name=/^(insert|update|upsert|delete)$/]",
          message:
            "Frontend must not mutate Supabase directly. Route this through an Express endpoint and call it via a hook in src/lib/api/*.",
        },
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name='rpc']",
          message:
            "Frontend must not invoke Supabase RPCs directly. Route through an Express endpoint.",
        },
      ],
    },
  }
);
