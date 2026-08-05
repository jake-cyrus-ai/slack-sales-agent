/**
 * Centralized tool error handling.
 *
 * Provides a ToolError class hierarchy for categorizing tool failures,
 * plus a `withToolErrorHandling` wrapper that catches errors, classifies
 * them, logs consistently, and returns the expected JSON string format.
 *
 * JSON output is backward compatible with the existing `{ error, results }` shape,
 * with added `errorCategory` and `retryable` fields.
 */

import { logger } from '../../lib/logger.js';

const log = logger.child({ component: 'tool-errors' });

// ─── Error classes ───────────────────────────────────────────────────────────

type ErrorCategory = 'input' | 'authorization' | 'api' | 'unknown';

export class ToolError extends Error {
  readonly toolName: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;

  constructor(toolName: string, message: string, category: ErrorCategory, retryable: boolean) {
    super(message);
    this.name = 'ToolError';
    this.toolName = toolName;
    this.category = category;
    this.retryable = retryable;
  }

  toJSON(): string {
    return JSON.stringify({
      error: this.message,
      errorCategory: this.category,
      retryable: this.retryable,
      results: [],
    });
  }
}

/** Bad input from the LLM (invalid params, missing required fields). */
export class ToolInputError extends ToolError {
  constructor(toolName: string, message: string) {
    super(toolName, message, 'input', false);
    this.name = 'ToolInputError';
  }
}

/** Missing credentials, disconnected integration, unauthorized. */
export class ToolAuthorizationError extends ToolError {
  constructor(toolName: string, message: string) {
    super(toolName, message, 'authorization', false);
    this.name = 'ToolAuthorizationError';
  }
}

/** External API failure (HTTP error, timeout, connection refused). */
export class ToolAPIError extends ToolError {
  readonly statusCode?: number;

  constructor(toolName: string, message: string, statusCode?: number) {
    // 5xx errors are retryable; client errors are not
    super(toolName, message, 'api', statusCode ? statusCode >= 500 : true);
    this.name = 'ToolAPIError';
    this.statusCode = statusCode;
  }
}

// ─── Error classifier ────────────────────────────────────────────────────────

/**
 * Heuristic classifier for untyped errors.
 * Inspects message and status code to categorize the error.
 */
export function classifyError(toolName: string, err: any): ToolError {
  const msg = err?.message || String(err);
  const status: number | undefined = err?.status ?? err?.response?.status;

  // Authorization patterns
  if (
    status === 401 || status === 403 ||
    /not connected|not linked|credentials|unauthorized|oauth/i.test(msg)
  ) {
    return new ToolAuthorizationError(toolName, msg);
  }

  // Input validation patterns
  if (
    status === 400 ||
    /invalid|required|missing.*param|validation|expected/i.test(msg)
  ) {
    return new ToolInputError(toolName, msg);
  }

  // API failures
  if (
    (status && status >= 500) ||
    /timeout|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|fetch failed/i.test(msg)
  ) {
    return new ToolAPIError(toolName, msg, status);
  }

  return new ToolError(toolName, msg, 'unknown', false);
}

// ─── Wrapper function ────────────────────────────────────────────────────────

/**
 * Wrap a tool's func with centralized error handling.
 *
 * Catches exceptions (both typed ToolError and untyped), classifies them,
 * logs consistently, and returns the expected JSON string format.
 *
 * Usage:
 *   func: withToolErrorHandling('tool_name', async (args) => { ... })
 */
export function withToolErrorHandling<TArgs>(
  toolName: string,
  fn: (args: TArgs) => Promise<string>,
): (args: TArgs) => Promise<string> {
  return async (args: TArgs): Promise<string> => {
    try {
      return await fn(args);
    } catch (err: any) {
      // If already a ToolError, use it directly
      if (err instanceof ToolError) {
        log.error({ err, toolName, category: err.category }, 'Tool error');
        return err.toJSON();
      }

      // Classify untyped errors
      const classified = classifyError(toolName, err);
      log.error({ err, toolName, category: classified.category }, 'Tool error');
      return classified.toJSON();
    }
  };
}
