import type { Response } from "express";
import type { ZodSchema, ZodError } from "zod";
import type { Request } from "../types";

/**
 * Parses `req.body` against a zod schema. On failure, sends a 400 JSON
 * response (including `requestId` and issues) and returns `null`.
 *
 * Usage:
 *   const body = validateBody(schema, req, res);
 *   if (!body) return;
 */
export function validateBody<T>(
  schema: ZodSchema<T>,
  req: Request,
  res: Response
): T | null {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const zerr = result.error as ZodError;
    req.log.warn({ issues: zerr.issues }, "Request body failed validation");
    res.status(400).json({
      error: "Invalid request body",
      issues: zerr.issues,
      requestId: req.id,
    });
    return null;
  }
  return result.data;
}

/**
 * Same as validateBody but for query params.
 */
export function validateQuery<T>(
  schema: ZodSchema<T>,
  req: Request,
  res: Response
): T | null {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    const zerr = result.error as ZodError;
    req.log.warn({ issues: zerr.issues }, "Query params failed validation");
    res.status(400).json({
      error: "Invalid query params",
      issues: zerr.issues,
      requestId: req.id,
    });
    return null;
  }
  return result.data;
}
