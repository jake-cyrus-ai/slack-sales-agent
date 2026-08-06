/**
 * Conversation feedback routes.
 *
 * Routes:
 * - POST /api/feedback — record thumbs-up / thumbs-down feedback on a message
 *
 * Replaces the direct `supabase.from("conversation_feedback").insert(...)` the
 * MessageFeedback component used to do from the browser. The acting user id is
 * derived server-side from the Supabase Auth session (getAuth) — the client never
 * supplies it — so feedback can't be attributed to another user.
 */

import { Router, type Response } from "express";
import { getAuth, requireAuth } from "../lib/auth";
import { z } from "zod";
import type { Request } from "../types";
import { validateBody } from "../lib/validate";
// User-scoped client: feedback is the caller's own row, so RLS still enforces
// the user/org boundary at the database even if an app-level check is missed.
import { getSupabaseForRequest } from "../lib/supabase";

const router = Router();

const feedbackSchema = z
  .object({
    conversationId: z.string().uuid(),
    messageId: z.string().min(1).max(256),
    feedbackType: z.enum(["thumbs_up", "thumbs_down"]),
  })
  .strict();

// ---------------------------------------------------------------------------
// POST /api/feedback
// ---------------------------------------------------------------------------
router.post(
  "/feedback",
  requireAuth(),
  async (req: Request, res: Response) => {
    const { userId } = getAuth(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized", requestId: req.id });
    }

    const body = validateBody(feedbackSchema, req, res);
    if (!body) return;

    try {
      const supabase = getSupabaseForRequest(req);
      const { error } = await supabase.from("conversation_feedback").insert({
        conversation_id: body.conversationId,
        message_id: body.messageId,
        user_id: userId,
        feedback_type: body.feedbackType,
        feedback_value: {
          rating: body.feedbackType === "thumbs_up" ? 1 : -1,
          timestamp: new Date().toISOString(),
        },
      });

      if (error) {
        req.log.error(
          { err: error, conversationId: body.conversationId },
          "Error inserting conversation feedback",
        );
        return res
          .status(500)
          .json({ error: error.message, requestId: req.id });
      }

      req.log.info(
        { conversationId: body.conversationId, feedbackType: body.feedbackType },
        "Conversation feedback recorded",
      );
      return res.status(201).json({ success: true, requestId: req.id });
    } catch (error) {
      req.log.error({ err: error }, "Error recording conversation feedback");
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Internal server error",
        requestId: req.id,
      });
    }
  },
);

export default router;
