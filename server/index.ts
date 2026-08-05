/**
 * Express Server for Vercel Workflow Functions
 * 
 * This server handles Vercel Workflow function execution and webhooks.
 * It runs alongside the Vite dev server in development and
 * serves as the backend in production.
 * 
 * Security Features:
 * - Webhook signature verification (Slack & Gmail)
 * - Rate limiting on webhook endpoints
 * - CORS configuration with allowed origins
 * - Request ID tracking
 * - Input validation
 * - Global error handling
 */

import express, { Response, NextFunction } from "express";
import type { Request } from "./types";
import cors from "cors";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pinoHttp from "pino-http";
import { workflow } from "../server/workflows/client";
import {
  verifySlackSignature,
  verifyGmailSignature,
  validateGmailPayload,
  validateSlackPayload,
} from "./webhookVerification";
import { clerkWebhookRouter } from "./webhooks/clerk";
import { clerkMiddleware } from "@clerk/express";
import { logger } from "./lib/logger";
import styleExamplesRouter from "./routes/style-examples";
import userRouter from "./routes/user";
import salesforceRouter from "./routes/salesforce";
import attioRouter from "./routes/attio";
import oauthRouter from "./routes/oauth";
import knowledgeBaseRouter from "./routes/knowledge-base";
import calendarRouter from "./routes/calendar";
import automationRouter from "./routes/automation";
import featureFlagsRouter from "./routes/feature-flags";
import onboardingRouter from "./routes/onboarding";
import feedbackRouter from "./routes/feedback";
import { checkMigrationFlagsAtStartup, logMigrationConfig } from "./lib/featureFlags";
import { supabase } from './src/lib/supabase';
import './src/config';

const app = express();
const PORT = process.env.PORT || 3001;

/**
 * Safely send events to Vercel Workflow, gracefully handling startup race conditions
 * where the Vercel Workflow dev server isn't ready yet. Returns true if sent, false if dropped.
 */
async function dispatchWorkflowEventSafe(
  event: Parameters<typeof workflow.send>[0],
  requestId?: any
): Promise<boolean> {
  try {
    await workflow.send(event);
    return true;
  } catch (error: any) {
    if (error?.message?.includes("fetch failed")) {
      const eventName = Array.isArray(event) ? event.map(e => e.name).join(", ") : (event as any).name;
      logger.warn({ requestId, eventName }, "Vercel Workflow not ready, dropped event");
      return false;
    }
    throw error;
  }
}

// Trust the first proxy (Render, Railway, etc.) so X-Forwarded-For is used
// correctly by express-rate-limit and req.ip reflects the real client IP.
app.set("trust proxy", 1);

// ============================================================================
// Feature Flag Validation
// ============================================================================

// Validate Clerk migration feature flags at startup
try {
  checkMigrationFlagsAtStartup();
} catch (error) {
  logger.error("Failed to start server due to invalid feature flags");
  process.exit(1);
}

// Require the legacy Supabase signing secret used for worker-scoped RLS tokens.
if (process.env.NODE_ENV === "production") {
  if (!process.env.SUPABASE_JWT_SECRET) {
    logger.error("FATAL: SUPABASE_JWT_SECRET is required in production. It is used to mint user-scoped Supabase clients in Vercel Workflow functions.");
    process.exit(1);
  }
}

// ============================================================================
// Security Middleware
// ============================================================================

// CORS configuration with allowed origins
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()) || [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:8080',
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, Postman, etc.)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        logger.warn({ origin }, "CORS blocked origin");
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-ID',
    ],
  })
);

// Body parsing middleware with size limits
// The `verify` callback captures the raw body for webhook signature verification
// (Clerk/svix and Slack require the exact original bytes to validate signatures).
app.use(express.json({
  limit: '1mb',
  verify: (req: any, _res, buf) => {
    req.rawBody = buf.toString('utf-8');
  },
}));
app.use(express.urlencoded({
  extended: true,
  limit: '1mb',
  verify: (req: any, _res, buf) => {
    req.rawBody = buf.toString('utf-8');
  },
}));

// Request ID tracking middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = crypto.randomUUID();
  req.id = requestId;
  res.setHeader('X-Request-ID', requestId);
  next();
});

// Structured request logging via pino-http
// Reuses req.id set by the middleware above via genReqId
app.use(
  pinoHttp({
    logger,
    genReqId: (req) => (req as any).id ?? crypto.randomUUID(),
    autoLogging: {
      ignore: (req) => (req as any).url === "/health",
    },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    serializers: {
      req: (req) => ({ method: req.method, url: req.url, id: req.id }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  })
);

// Clerk authentication middleware is applied per-route below (not globally)
// so that Vercel Workflow, health-check, and webhook routes are never blocked by
// missing Clerk keys or unauthenticated requests.

// Rate limiting for webhook endpoints
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // Limit each IP to 100 requests per minute
  message: { error: 'Too many requests from this IP, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    req.log.warn({ ip: req.ip }, "Webhook rate limit exceeded");
    res.status(429).json({
      error: 'Too many requests',
      retryAfter: res.getHeader('Retry-After'),
    });
  },
});

// General API rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per 15 minutes
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Deep health check rate limiter - stricter to prevent abuse
// This endpoint makes downstream API calls, so we limit to 6 req/min per IP
const deepHealthLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 6, // Limit each IP to 6 requests per minute
  message: { error: 'Too many health check requests' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    req.log.warn({ ip: req.ip }, "Deep health check rate limit exceeded");
    res.status(429).json({
      error: 'Too many health check requests',
      retryAfter: res.getHeader('Retry-After'),
    });
  },
});

// ============================================================================
// Health Check & Monitoring
// ============================================================================

import { checkDownstreamHealth, type HealthCheckResult } from "./src/health/downstream-checks";

app.get("/health", (req: Request, res: Response) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    requestId: req.id,
  });
});

// Runtime browser configuration. Only values explicitly intended for public
// clients belong here; this keeps one Docker image portable across deployments.
app.get("/api/config", (_req: Request, res: Response) => {
  res.json({
    clerkPublishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY || null,
  });
});

app.get("/health/deep", deepHealthLimiter, async (req: Request, res: Response) => {
  // Optional secret-based protection: when HEALTH_CHECK_SECRET is set,
  // requests must provide ?secret=<value> to access the endpoint
  const secret = process.env.HEALTH_CHECK_SECRET;
  if (secret && req.query.secret !== secret) {
    return res.status(401).json({
      error: "Unauthorized",
      requestId: req.id,
    });
  }

  const startTime = Date.now();
  const result: HealthCheckResult = await checkDownstreamHealth();
  const duration = Date.now() - startTime;

  const httpStatus = result.status === "healthy" ? 200 : result.status === "degraded" ? 207 : 503;

  res.status(httpStatus).json({
    ...result,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checkDurationMs: duration,
    requestId: req.id,
  });
});

// ============================================================================
// Webhook Endpoints
// ============================================================================

/**
 * Gmail Push Webhook Handler
 * Receives Google Pub/Sub push notifications for new emails
 */
app.post(
  "/api/webhooks/gmail",
  webhookLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      req.log.info("Gmail webhook received");

      // 1. Validate payload structure
      if (!validateGmailPayload(req.body)) {
        req.log.warn("Invalid Gmail payload structure");
        return res.status(400).json({
          error: "Invalid payload structure",
          requestId: req.id,
        });
      }

      // 2. Verify signature
      if (!await verifyGmailSignature(req)) {
        req.log.warn("Gmail signature verification failed");
        return res.status(401).json({
          error: "Unauthorized - Invalid signature",
          requestId: req.id,
        });
      }

      // 3. Decode Gmail push notification
      const message = JSON.parse(
        Buffer.from(req.body.message.data, "base64").toString()
      );

      req.log.info({ emailAddress: message.emailAddress }, "Gmail notification received");

      // 4. Send to Vercel Workflow
      await dispatchWorkflowEventSafe({
        name: "email/notification",
        data: {
          emailAddress: message.emailAddress,
          historyId: message.historyId,
        },
      }, req.id);

      res.status(200).json({
        success: true,
        requestId: req.id,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Slack Events Webhook Handler
 * Receives Slack events (app_mention, message, etc.)
 */
app.post(
  "/api/webhooks/slack/events",
  webhookLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      req.log.info({ type: req.body.type }, "Slack event received");

      // 1. Handle Slack URL verification challenge (no signature needed)
      if (req.body.type === "url_verification") {
        req.log.info("Slack URL verification challenge");
        return res.json({ challenge: req.body.challenge });
      }

      // 2. Validate payload structure
      if (!validateSlackPayload(req.body)) {
        req.log.warn("Invalid Slack payload structure");
        return res.status(400).json({
          error: "Invalid payload structure",
          requestId: req.id,
        });
      }

      // 3. Verify Slack signature
      if (!verifySlackSignature(req, req.rawBody)) {
        req.log.warn("Slack signature verification failed");
        return res.status(401).json({
          error: "Unauthorized - Invalid signature",
          requestId: req.id,
        });
      }

      // 4. Extract event data and send to Vercel Workflow
      // Preserve top-level team_id so downstream workspace resolution works.
      const eventData = req.body.event || req.body;
      const rawEventType = eventData.type || "event";
      const eventPayload = {
        ...eventData,
        team_id: req.body.team_id || req.body.team?.id || eventData.team_id,
      };

      // Skip non-user events before they reach Vercel Workflow. These are system/
      // metadata events that the bot should never process:
      // - message_changed: change notifications (not the edit itself)
      // - message_deleted: deletion notifications
      // - hidden: internal Slack bookkeeping (e.g. assistant thread metadata)
      // - bot_id / bot_message: prevents response loops
      if (
        eventData.subtype === "message_changed" ||
        eventData.subtype === "message_deleted" ||
        eventData.hidden === true ||
        eventData.bot_id ||
        eventData.subtype === "bot_message"
      ) {
        req.log.info({ subtype: eventData.subtype }, "Skipping non-user Slack event");
        return res.status(200).json({ success: true, requestId: req.id });
      }

      // Deduplicate: when a user @mentions the bot in a channel, Slack sends
      // BOTH a "message" event and an "app_mention" event. We skip the
      // "message" event only when it contains a bot mention (text has <@U...>),
      // since the app_mention will handle it. DMs and plain channel messages
      // (no @mention) are processed normally.
      const isChannelMessage =
        rawEventType === "message" && eventData.channel_type !== "im" && !eventData.subtype;
      const hasBotMention = typeof eventData.text === 'string' && /<@U[A-Z0-9]+>/.test(eventData.text);
      if (isChannelMessage && hasBotMention) {
        req.log.info("Skipping channel message with @mention (app_mention will handle it)");
        return res.status(200).json({ success: true, requestId: req.id });
      }

      // Normalize Slack event types so that both direct messages and channel
      // app_mention events flow through the same Vercel Workflow "slack/message"
      // pipeline. All other Slack events fall back to the generic
      // "slack/event" handler.
      const workflowEventName =
        rawEventType === "message" || rawEventType === "app_mention"
          ? "slack/message"
          : "slack/event";

      const sent = await dispatchWorkflowEventSafe({
        name: workflowEventName as any,
        data: eventPayload,
      }, req.id);

      if (sent) {
        req.log.info({ workflowEventName }, "Slack event sent to Vercel Workflow");
      }

      res.status(200).json({
        success: true,
        requestId: req.id,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Slack Interactivity Webhook Handler
 * Receives Slack interactive component actions (button clicks, modal submissions, etc.)
 * Note: Slack sends these as URL-encoded form data, not JSON
 */
app.post(
  "/api/webhooks/slack/interactivity",
  webhookLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      req.log.info("Slack interactivity received");

      // 1. Verify Slack signature using raw body captured by urlencoded middleware
      if (!verifySlackSignature(req, req.rawBody)) {
        req.log.warn("Slack interactivity signature verification failed");
        return res.status(401).json({
          error: "Unauthorized - Invalid signature",
          requestId: req.id,
        });
      }

      // 2. Get payload from parsed form body
      const payloadStr = req.body?.payload;

      if (!payloadStr) {
        req.log.warn("No payload in Slack interactivity request");
        return res.status(400).json({
          error: "No payload",
          requestId: req.id,
        });
      }

      const payload = JSON.parse(payloadStr);

      req.log.info({ type: payload.type, action: payload.actions?.[0]?.action_id }, "Slack interactivity payload");

      // 4. Send to Vercel Workflow
      const sent = await dispatchWorkflowEventSafe({
        name: "slack/interaction",
        data: {
          type: payload.type,
          payload: payloadStr,
          user: payload.user,
          team: payload.team,
          channel: payload.channel,
        },
      }, req.id);

      if (sent) {
        req.log.info("Slack interactivity sent to Vercel Workflow");
      }

      // 5. Respond immediately (Slack requires quick response)
      res.status(200).json({
        success: true,
        requestId: req.id,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Legacy Slack Webhook Handler (for backwards compatibility)
 * Redirects to appropriate endpoint based on content
 */
app.post(
  "/api/webhooks/slack",
  webhookLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    // Check if this is an interactivity payload (has payload field)
    if (req.body.payload) {
      // Redirect to interactivity handler
      return app._router.handle(
        { ...req, url: "/api/webhooks/slack/interactivity", path: "/api/webhooks/slack/interactivity" },
        res,
        next
      );
    } else {
      // Redirect to events handler
      return app._router.handle(
        { ...req, url: "/api/webhooks/slack/events", path: "/api/webhooks/slack/events" },
        res,
        next
      );
    }
  }
);

// ============================================================================
// Clerk Webhook Endpoint
// ============================================================================

app.use("/api/webhooks/clerk", webhookLimiter, clerkWebhookRouter);

// ============================================================================
// OAuth Callback Endpoints (No Clerk Auth - uses oauth_states for CSRF)
// ============================================================================

// OAuth callback endpoints are redirect endpoints that don't have Clerk session.
// They validate requests using stored state tables instead.
app.get("/api/oauth/slack/callback", apiLimiter, oauthRouter);
app.get("/api/oauth/granola/callback", apiLimiter, oauthRouter);
app.get("/api/oauth/attio/callback", apiLimiter, oauthRouter);

// ============================================================================
// Protected API Routes (require Clerk authentication)
// ============================================================================

// Apply shared middleware once for all protected /api routes.
// Wrap clerkMiddleware so auth failures surface as 401s in route handlers
// (via getAuth()) instead of crashing the middleware chain with a 500.
app.use("/api", apiLimiter, (req: Request, res: Response, next: NextFunction) => {
  const clerk = clerkMiddleware();
  clerk(req, res, (err?: any) => {
    if (err) {
      req.log.error({ err: err.message || err }, "clerkMiddleware error");
      // Let the request continue — route handlers will see userId=null from getAuth()
      // and return 401 themselves.
    }
    next();
  });
});

// OAuth routes (Google endpoints require Clerk auth)
app.use("/api", oauthRouter);

// Standard routes
app.use("/api", userRouter);
app.use("/api", styleExamplesRouter);
app.use("/api", knowledgeBaseRouter);
app.use("/api", calendarRouter);
app.use("/api/salesforce", salesforceRouter);
app.use("/api/attio", attioRouter);
app.use("/api", automationRouter);
app.use("/api", featureFlagsRouter);
app.use("/api", onboardingRouter);
app.use("/api", feedbackRouter);

app.get("/api/cron/:workflowId", async (req: Request, res: Response) => {
  const cronSecret = process.env.CRON_SECRET;
  if (
    process.env.NODE_ENV === "production" &&
    (!cronSecret || req.header("authorization") !== `Bearer ${cronSecret}`)
  ) {
    return res.status(401).json({ error: "Unauthorized", requestId: req.id });
  }
  try {
    const workflowId = Array.isArray(req.params.workflowId)
      ? req.params.workflowId[0]
      : req.params.workflowId;
    const result = await workflow.startScheduled(workflowId);
    return res.status(202).json({ accepted: true, ...result, requestId: req.id });
  } catch (error) {
    req.log.error({ err: error, workflowId: req.params.workflowId }, "Failed to start scheduled workflow");
    return res.status(404).json({ error: "Unknown scheduled workflow", requestId: req.id });
  }
});

// ============================================================================
// Test Endpoints (Development Only)
// ============================================================================

/**
 * Test endpoints for local development
 * These bypass signature verification and rate limiting for easier testing
 * Only enabled in development mode
 */
if (process.env.NODE_ENV !== 'production') {
  logger.warn("Test endpoints enabled (development mode only)");

  /**
   * Test Slack Message Endpoint
   * POST /api/test/slack/message
   * Bypasses signature verification for local testing
   */
  app.post(
    "/api/test/slack/message",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        req.log.info("TEST: Slack message received");

        const eventData = req.body.event || req.body;
        const rawEventType = eventData.type || "message";

        const workflowEventName =
          rawEventType === "message" || rawEventType === "app_mention"
            ? "slack/message"
            : "slack/event";

        await dispatchWorkflowEventSafe({
          name: workflowEventName as any,
          data: eventData,
        }, req.id);

        req.log.info({ workflowEventName }, "TEST: Event sent to Vercel Workflow");

        res.status(200).json({
          success: true,
          message: 'Test message sent to Vercel Workflow',
          eventType: workflowEventName,
          requestId: req.id,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * Test Slack Interaction Endpoint
   * POST /api/test/slack/interaction
   * Bypasses signature verification for local testing
   */
  app.post(
    "/api/test/slack/interaction",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        req.log.info("TEST: Slack interaction received");

        // Parse payload from form data
        const payloadStr = req.body.payload || JSON.stringify(req.body);
        const payload = typeof payloadStr === 'string' ? JSON.parse(payloadStr) : payloadStr;

        await dispatchWorkflowEventSafe({
          name: "slack/interaction",
          data: {
            type: payload.type,
            payload: typeof payloadStr === 'string' ? payloadStr : JSON.stringify(payloadStr),
            user: payload.user,
            team: payload.team,
            channel: payload.channel,
          },
        }, req.id);

        req.log.info("TEST: Interaction sent to Vercel Workflow");

        res.status(200).json({
          success: true,
          message: 'Test interaction sent to Vercel Workflow',
          requestId: req.id,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * Test Gmail Notification Endpoint
   * POST /api/test/gmail
   * Bypasses signature verification for local testing
   */
  app.post(
    "/api/test/gmail",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        req.log.info("TEST: Gmail notification received");

        let message: any;

        // Support both decoded and encoded formats
        if (req.body.message && req.body.message.data) {
          // Encoded format (like real Gmail push)
          message = JSON.parse(
            Buffer.from(req.body.message.data, "base64").toString()
          );
        } else {
          // Direct format for easier testing
          message = req.body;
        }

        await dispatchWorkflowEventSafe({
          name: "email/notification",
          data: {
            emailAddress: message.emailAddress,
            historyId: message.historyId,
          },
        }, req.id);

        req.log.info("TEST: Gmail notification sent to Vercel Workflow");

        res.status(200).json({
          success: true,
          message: 'Test Gmail notification sent to Vercel Workflow',
          requestId: req.id,
        });
      } catch (error) {
        next(error);
      }
    }
  );
}

// Serve the small onboarding/configuration UI from the same deployable service.
// API and webhook routes above always win; unknown API paths still return JSON.
if (process.env.NODE_ENV === "production") {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const frontendDir = path.join(rootDir, "dist");
  app.use(express.static(frontendDir, { index: false, maxAge: "1h" }));
  app.get(/^\/(?!api(?:\/|$)|health(?:\/|$)).*/, (_req, res) => {
    res.sendFile(path.join(frontendDir, "index.html"));
  });
}

// ============================================================================
// Error Handling Middleware
// ============================================================================

/**
 * 404 Not Found Handler
 */
app.use((req: Request, res: Response) => {
  req.log.warn({ path: req.path, method: req.method }, "404 Not Found");
  res.status(404).json({
    error: "Not Found",
    path: req.path,
    requestId: req.id,
  });
});

/**
 * Global Error Handler
 * Must be defined last, after all other middleware and routes
 */
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  // Fall back to module logger: req.log is attached by pino-http, but errors
  // raised by middleware ordered before it (e.g. CORS) reach this handler
  // without a request-scoped logger.
  const log = req.log ?? logger;
  log.error({ err, path: req.path, method: req.method }, "Unhandled error");

  if (res.headersSent) return next(err);

  // Don't expose internal error details in production
  const isDev = process.env.NODE_ENV === "development";

  res.status(500).json({
    error: "Internal Server Error",
    message: isDev ? err.message : "An unexpected error occurred",
    requestId: req.id,
    ...(isDev && { stack: err.stack }),
  });
});

// ============================================================================
// Server Startup
// ============================================================================

const isTestEnv = process.env.NODE_ENV === "test";

// Validate encryption key is not the placeholder before starting
async function validateEncryptionKey(): Promise<void> {
  try {
    const { data: key, error } = await supabase.rpc('_get_encryption_key');
    if (error) {
      logger.error({ err: error.message }, "FATAL: Could not verify encryption key");
      process.exit(1);
    }
    if (!key || key === 'PLACEHOLDER_REPLACE_ME') {
      logger.error("FATAL: Encryption key in app_secrets is still the placeholder. Run: UPDATE app_secrets SET value = 'your-real-key' WHERE name = 'calendar_encryption_key';");
      process.exit(1);
    }
  } catch (err) {
    logger.error({ err }, "FATAL: Could not verify encryption key");
    process.exit(1);
  }
}

if (!isTestEnv && !process.env.VERCEL) {
  validateEncryptionKey().then(() => {
  const server = app.listen(PORT, () => {
    const supabaseHost = (() => {
      try {
        return new URL(process.env.SUPABASE_URL || "").host;
      } catch {
        return null;
      }
    })();
    const supabaseProjectRef = supabaseHost?.split(".")[0] || "unknown";

    // Base URL from environment (no hardcoded URLs)
    // In production/staging, set SERVER_BASE_URL to the external URL (e.g., https://your-app.example.com)
    // Locally, defaults to http://localhost:PORT
    const baseURL = process.env.SERVER_BASE_URL || `http://localhost:${PORT}`;

    logger.info(
      {
        env: process.env.NODE_ENV || "development",
        supabaseProjectRef,
        port: PORT,
        baseURL,
      },
      "Server started"
    );

    // Log Clerk migration configuration if enabled
    if (process.env.CLERK_MIGRATION_ENABLED === 'true') {
      logMigrationConfig();
    }

  });

  // ============================================================================
  // Graceful Shutdown with Connection Draining
  // ============================================================================

  const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '30000', 10);
  let isShuttingDown = false;

  const gracefulShutdown = (signal: string) => {
    if (isShuttingDown) {
      logger.info({ signal }, "Already shutting down, ignoring signal");
      return;
    }

    isShuttingDown = true;
    logger.info({ signal }, "Graceful shutdown initiated");

    // Set a hard deadline for shutdown
    const forceExitTimer = setTimeout(() => {
      logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, "Force exit after timeout — some requests may have been dropped");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    // Don't let this timer prevent the process from exiting naturally
    forceExitTimer.unref();

    // Stop accepting new connections and wait for existing ones to complete
    server.close((err) => {
      if (err) {
        logger.error({ err }, "Error during server close");
        clearTimeout(forceExitTimer);
        process.exit(1);
      }

      logger.info("All connections drained, server closed cleanly");
      clearTimeout(forceExitTimer);
      process.exit(0);
    });

    // Close idle keep-alive connections immediately to speed up shutdown
    server.closeIdleConnections();
  };

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  }); // end validateEncryptionKey().then()
}

export default app;
