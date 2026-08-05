/**
 * TypeScript type declarations for Express Request extensions
 */

import type { Request as ExpressRequest } from "express";
import type { Logger } from "pino";

declare global {
  namespace Express {
    interface Request {
      id?: string; // Request ID for tracking
      rawBody?: string; // Raw request body for webhook signature verification
      log: Logger; // Injected by pino-http
      organizationId?: string;
      widgetKeyId?: string;
    }
  }
}

// Export the extended Request type
export type Request = ExpressRequest;
