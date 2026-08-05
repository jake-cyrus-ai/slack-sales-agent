/**
 * Centralized LLM creation with explicit retry configuration.
 *
 * Wraps ChatAnthropic with:
 *  - Explicit maxRetries (instead of hidden LangChain defaults)
 *  - Retry-After header support
 *  - Structured logging on failures
 *  - Non-retryable 4xx abort (except 429)
 *
 * Also provides `invokeWithRetry` for sub-agent-level retry.
 *
 *
 */

import { ChatAnthropic } from '@langchain/anthropic';
import { config } from '../config.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ component: 'llm-retry' });

// ─── Types ───────────────────────────────────────────────────────────────────

interface CreateLLMOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  maxRetries?: number;
}

// ─── Retry handler ───────────────────────────────────────────────────────────

function isNonRetryableClientError(status: number | undefined): boolean {
  if (!status) return false;
  // 4xx except 429 (rate limit) are non-retryable
  return status >= 400 && status < 500 && status !== 429;
}

/**
 * Custom onFailedAttempt handler for p-retry (used by LangChain's AsyncCaller).
 * Logs structured retry info, respects Retry-After, aborts on non-retryable errors.
 */
async function onFailedAttempt(error: any): Promise<void> {
  const status: number | undefined = error?.status ?? error?.response?.status;
  const attempt: number = error?.attemptNumber ?? 0;
  const retriesLeft: number = error?.retriesLeft ?? 0;

  log.warn({ attempt, status: status ?? 'unknown', retriesLeft, message: error?.message?.slice(0, 120) }, 'Attempt failed');

  // Abort immediately on non-retryable client errors
  if (isNonRetryableClientError(status)) {
    error.retriesLeft = 0;
    throw error;
  }

  // Respect Retry-After header when present (Anthropic includes it on 429/529)
  const retryAfterRaw =
    error?.headers?.get?.('retry-after') ??
    error?.responseHeaders?.get?.('retry-after') ??
    error?.error?.headers?.['retry-after'];

  if (retryAfterRaw) {
    const seconds = parseFloat(retryAfterRaw);
    if (!isNaN(seconds) && seconds > 0 && seconds <= 60) {
      log.warn({ seconds }, 'Respecting Retry-After');
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    }
  }
}

// ─── LLM Factory ─────────────────────────────────────────────────────────────

/**
 * Create a ChatAnthropic instance with explicit retry configuration.
 * Use this instead of `new ChatAnthropic({...})` everywhere.
 */
export function createLLM(opts: CreateLLMOptions = {}): ChatAnthropic {
  return new ChatAnthropic({
    model: opts.model || 'claude-sonnet-4-20250514',
    anthropicApiKey: config.anthropicApiKey,
    temperature: opts.temperature ?? 0,
    ...(opts.maxTokens && { maxTokens: opts.maxTokens }),
    maxRetries: opts.maxRetries ?? 3,
    onFailedAttempt,
  });
}

// ─── Sub-agent retry wrapper ─────────────────────────────────────────────────

function isTransientError(err: any): boolean {
  const status: number | undefined = err?.status ?? err?.response?.status;
  if (status === 429 || status === 529) return true;
  if (status && status >= 500 && status < 600) return true;
  if (err?.message?.includes('timed out')) return true;
  if (err?.code === 'ECONNRESET' || err?.code === 'ECONNREFUSED') return true;
  return false;
}

/**
 * Invoke a LangGraph agent with a single retry on transient failures.
 * Preserves the existing Promise.race timeout pattern.
 */
export async function invokeWithRetry(
  agent: { invoke: (input: any, config?: any) => Promise<any> },
  messages: any[],
  recursionLimit: number,
  timeoutMs: number,
  skillName: string,
): Promise<any> {
  const maxAttempts = 2; // original + 1 retry

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await Promise.race([
        agent.invoke({ messages }, { recursionLimit }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`${skillName} skill timed out after ${timeoutMs / 1000}s`)),
            timeoutMs,
          ),
        ),
      ]);
    } catch (err: any) {
      if (attempt < maxAttempts && isTransientError(err)) {
        const backoffMs = 2000 * attempt;
        log.warn({ skillName, attempt, backoffMs, message: err.message }, 'Sub-agent attempt failed, retrying');
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      throw err;
    }
  }

  // Unreachable, but satisfies TypeScript
  throw new Error(`${skillName} exhausted all retry attempts`);
}
