/**
 * Inngest Client Configuration
 * 
 * Central Inngest client for the Slack Sales Agent application.
 * All Inngest functions should use this client instance.
 */

import { Inngest, EventSchemas } from "inngest";
import type { Events } from "./events";
import { orgValidationMiddleware } from "./middleware/org-validation.js";

/**
 * Main Inngest client instance
 *
 * Configure with your app ID and event schemas for full type safety.
 * When INNGEST_SIGNING_KEY is set we force cloud mode so the SDK signs
 * responses (required for Inngest Cloud sync). Otherwise mode is inferred
 * (e.g. dev when using the local dev server).
 */
export const inngest = new Inngest({
  id: "agent-ai",
  schemas: new EventSchemas().fromRecord<Events>(),
  // Force cloud mode only in production; local dev server always uses dev mode
  isDev: process.env.NODE_ENV !== 'production',
  middleware: [orgValidationMiddleware],
});
