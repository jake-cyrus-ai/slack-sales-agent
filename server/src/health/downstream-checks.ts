/**
 * Downstream Health Checks
 *
 * Verifies connectivity to critical external dependencies:
 * - Supabase (PostgreSQL database)
 * - Clerk (authentication)
 * - Vercel Workflow (background job processing)
 * - OpenAI (LLM provider)
 * - Anthropic (LLM provider)
 * - Slack (messaging integration)
 * - Google (OAuth/Gmail/Calendar)
 *
 * Used by /health/deep endpoint to detect partial outages
 * that a shallow health check would miss.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { clerkClient } from "@clerk/express";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { WebClient } from "@slack/web-api";

export type ServiceStatus = "healthy" | "unhealthy" | "degraded" | "not_configured";

// Module-level cached clients to avoid per-request instantiation overhead
let _supabaseClient: SupabaseClient | null = null;
let _openaiClient: OpenAI | null = null;
let _anthropicClient: Anthropic | null = null;
let _slackClient: WebClient | null = null;

export interface ServiceCheck {
  status: ServiceStatus;
  latencyMs: number;
  error?: string;
}

export interface HealthCheckResult {
  status: ServiceStatus;
  services: {
    supabase: ServiceCheck;
    clerk: ServiceCheck;
    workflow: ServiceCheck;
    openai: ServiceCheck;
    anthropic: ServiceCheck;
    slack: ServiceCheck;
    google: ServiceCheck;
  };
}

const HEALTH_CHECK_TIMEOUT_MS = 5000;

async function withTimeout<T>(
  promiseOrThenable: Promise<T> | PromiseLike<T>,
  timeoutMs: number,
  serviceName: string
): Promise<T> {
  return Promise.race([
    Promise.resolve(promiseOrThenable),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${serviceName} health check timed out after ${timeoutMs}ms`)),
        timeoutMs
      )
    ),
  ]);
}

async function checkSupabase(): Promise<ServiceCheck> {
  const startTime = Date.now();

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      return {
        status: "unhealthy",
        latencyMs: Date.now() - startTime,
        error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
      };
    }

    if (!_supabaseClient) {
      _supabaseClient = createClient(supabaseUrl, serviceRoleKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      });
    }

    const result = await withTimeout(
      _supabaseClient.from("profiles").select("user_id").limit(1).then((res) => res),
      HEALTH_CHECK_TIMEOUT_MS,
      "Supabase"
    );

    if (result.error) {
      return {
        status: "unhealthy",
        latencyMs: Date.now() - startTime,
        error: result.error.message,
      };
    }

    return {
      status: "healthy",
      latencyMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      status: "unhealthy",
      latencyMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

async function checkClerk(): Promise<ServiceCheck> {
  const startTime = Date.now();

  try {
    const secretKey = process.env.CLERK_SECRET_KEY;

    if (!secretKey) {
      return {
        status: "unhealthy",
        latencyMs: Date.now() - startTime,
        error: "Missing CLERK_SECRET_KEY",
      };
    }

    await withTimeout(
      clerkClient.users.getUserList({ limit: 1 }),
      HEALTH_CHECK_TIMEOUT_MS,
      "Clerk"
    );

    return {
      status: "healthy",
      latencyMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      status: "unhealthy",
      latencyMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

async function checkWorkflow(): Promise<ServiceCheck> {
  const configured = Boolean(process.env.VERCEL || process.env.WORKFLOW_WORLD_URL);
  return {
    status: configured ? "healthy" : "not_configured",
    latencyMs: 0,
    ...(!configured && { error: "Workflow runtime is activated by Vercel at deploy time" }),
  };
}

async function checkOpenAI(): Promise<ServiceCheck> {
  const startTime = Date.now();

  try {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return {
        status: "unhealthy",
        latencyMs: Date.now() - startTime,
        error: "Missing OPENAI_API_KEY",
      };
    }

    if (!_openaiClient) {
      _openaiClient = new OpenAI({ apiKey });
    }

    await withTimeout(
      _openaiClient.models.list().then((res) => res),
      HEALTH_CHECK_TIMEOUT_MS,
      "OpenAI"
    );

    return {
      status: "healthy",
      latencyMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      status: "unhealthy",
      latencyMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

async function checkAnthropic(): Promise<ServiceCheck> {
  const startTime = Date.now();

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      return {
        status: "unhealthy",
        latencyMs: Date.now() - startTime,
        error: "Missing ANTHROPIC_API_KEY",
      };
    }

    if (!_anthropicClient) {
      _anthropicClient = new Anthropic({ apiKey });
    }

    await withTimeout(
      _anthropicClient.models.list({ limit: 1 }),
      HEALTH_CHECK_TIMEOUT_MS,
      "Anthropic"
    );

    return {
      status: "healthy",
      latencyMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      status: "unhealthy",
      latencyMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

async function checkSlack(): Promise<ServiceCheck> {
  const startTime = Date.now();

  try {
    const botToken = process.env.SLACK_BOT_TOKEN;

    if (!botToken) {
      return {
        status: "not_configured",
        latencyMs: Date.now() - startTime,
        error: "Slack not configured (optional)",
      };
    }

    if (!_slackClient) {
      _slackClient = new WebClient(botToken);
    }

    const result = await withTimeout(
      _slackClient.auth.test() as Promise<{ ok: boolean; error?: string }>,
      HEALTH_CHECK_TIMEOUT_MS,
      "Slack"
    );

    if (!result.ok) {
      return {
        status: "unhealthy",
        latencyMs: Date.now() - startTime,
        error: result.error || "Slack auth.test failed",
      };
    }

    return {
      status: "healthy",
      latencyMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      status: "unhealthy",
      latencyMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

async function checkGoogle(): Promise<ServiceCheck> {
  const startTime = Date.now();

  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return {
        status: "not_configured",
        latencyMs: Date.now() - startTime,
        error: "Google OAuth not configured (optional)",
      };
    }

    const tokenInfoUrl = "https://oauth2.googleapis.com/tokeninfo";
    const response = await withTimeout(
      fetch(tokenInfoUrl, { method: "POST", body: "" }).then((res) => res),
      HEALTH_CHECK_TIMEOUT_MS,
      "Google"
    );

    if (response.status === 400) {
      return {
        status: "healthy",
        latencyMs: Date.now() - startTime,
      };
    }

    if (!response.ok && response.status !== 400) {
      return {
        status: "degraded",
        latencyMs: Date.now() - startTime,
        error: `Google OAuth endpoint returned ${response.status}`,
      };
    }

    return {
      status: "healthy",
      latencyMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      status: "unhealthy",
      latencyMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

function aggregateStatus(services: HealthCheckResult["services"]): ServiceStatus {
  const activeStatuses = Object.values(services)
    .map((s) => s.status)
    .filter((s) => s !== "not_configured");

  if (activeStatuses.length === 0 || activeStatuses.every((s) => s === "healthy")) {
    return "healthy";
  }

  if (activeStatuses.some((s) => s === "unhealthy")) {
    return "unhealthy";
  }

  return "degraded";
}

export async function checkDownstreamHealth(): Promise<HealthCheckResult> {
  const [supabase, clerk, workflow, openai, anthropic, slack, google] = await Promise.all([
    checkSupabase(),
    checkClerk(),
    checkWorkflow(),
    checkOpenAI(),
    checkAnthropic(),
    checkSlack(),
    checkGoogle(),
  ]);

  const services = { supabase, clerk, workflow, openai, anthropic, slack, google };

  return {
    status: aggregateStatus(services),
    services,
  };
}
