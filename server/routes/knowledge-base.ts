/**
 * Knowledge Base API Routes
 *
 * Replaces the Supabase Edge Function "search-knowledge-base".
 * Uses Clerk authentication and performs synchronous vector search.
 */

import { Router, Response } from "express";
import { getAuth, requireAuth } from "@clerk/express";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import type { Request } from "../types";
import type { Logger } from "pino";
import { isOrgAdmin } from "../lib/auth";

const router = Router();

const getSupabaseAdmin = (): SupabaseClient => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
};

const getOpenAIClient = (): OpenAI => {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is not set");
  }

  return new OpenAI({ apiKey });
};

interface SearchRequestBody {
  query: string;
  limit?: number;
}

interface SearchResult {
  content: string;
  filename: string;
  category?: string;
  similarity: number;
  is_fallback?: boolean;
}

const resolveOrgIdFromClerk = async (
  supabase: SupabaseClient,
  clerkOrgId: string,
  log: Logger
): Promise<string | null> => {
  const { data: org, error } = await supabase
    .from("organizations")
    .select("id")
    .eq("clerk_id", clerkOrgId)
    .maybeSingle();

  if (error) {
    log.error({ err: error }, "Error resolving org by clerk_id");
    return null;
  }

  return org?.id ?? null;
};

/**
 * POST /api/knowledge-base/search
 *
 * Performs vector similarity search on the knowledge base.
 * This is a synchronous operation - no Vercel Workflow involved.
 */
router.post(
  "/knowledge-base/search",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const { userId: clerkUserId, orgId: clerkOrgId } = auth;

      if (!clerkUserId) {
        return res.status(401).json({
          error: "Unauthorized - No user ID in session",
          requestId: req.id,
        });
      }

      const { query, limit = 5 } = req.body as SearchRequestBody;

      if (!query || typeof query !== "string" || !query.trim()) {
        return res.status(400).json({
          error: "Query is required",
          requestId: req.id,
        });
      }

      const supabase = getSupabaseAdmin();

      // Resolve the internal organization UUID from the Clerk org ID
      let organizationId: string | null = null;
      if (clerkOrgId) {
        organizationId = await resolveOrgIdFromClerk(supabase, clerkOrgId, req.log);
        if (organizationId) {
          req.log.info(
            { organizationId },
            "Searching knowledge base for org"
          );
        }
      }

      if (!organizationId) {
        req.log.info(
          { userId: clerkUserId },
          "Searching knowledge base (user-scoped)"
        );
      }

      // Generate embedding for the search query using OpenAI
      const openai = getOpenAIClient();
      const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: query,
      });

      const queryEmbedding = embeddingResponse.data[0].embedding;

      // Perform similarity search using pgvector
      const searchParams: Record<string, unknown> = {
        query_embedding: queryEmbedding,
        match_threshold: 0.0,
        match_count: limit,
      };

      if (organizationId) {
        searchParams.organization_id_filter = organizationId;
        req.log.info({ organizationId, userId: clerkUserId }, "Search params");
      } else {
        searchParams.user_id_filter = clerkUserId;
        req.log.info({ userId: clerkUserId }, "Search params (legacy)");
      }

      const { data: results, error: searchError } = await supabase.rpc(
        "search_documents",
        searchParams
      );

      if (searchError) {
        // Fallback to manual search if RPC doesn't exist
        req.log.info("RPC not found, using fallback search");

        let chunksQuery = supabase
          .from("document_chunks")
          .select(
            `
            *,
            documents!inner(filename, category, organization_id),
            document_embeddings(embedding)
          `
          );

        // Apply filtering on the joined documents table
        if (organizationId) {
          // Strict org filtering - no IS NULL clause to prevent data leaks
          chunksQuery = chunksQuery.eq("documents.organization_id", organizationId);
        } else {
          // When no org context, scope to user's own documents
          // First get the user's profile to find their documents
          const { data: profile } = await supabase
            .from("profiles")
            .select("id")
            .eq("clerk_id", clerkUserId)
            .maybeSingle();
          
          if (profile?.id) {
            chunksQuery = chunksQuery.eq("documents.user_id", profile.id);
          } else {
            // No profile found, return empty results to prevent data leaks
            return res.json({ results: [] });
          }
        }

        const { data: chunks, error: chunksError } = await chunksQuery.limit(
          100
        );

        if (chunksError) {
          req.log.error({ err: chunksError }, "Fallback search error");
          return res.status(500).json({
            error: "Search failed",
            requestId: req.id,
          });
        }

        // Simple text matching fallback
        const filteredChunks = chunks
          ?.filter((chunk) =>
            chunk.content.toLowerCase().includes(query.toLowerCase())
          )
          .slice(0, limit);

        const fallbackResults: SearchResult[] =
          filteredChunks?.map((chunk) => ({
            content: chunk.content,
            filename: chunk.documents.filename,
            category: chunk.documents.category,
            similarity: 0.5,
            is_fallback: true,
          })) || [];

        return res.json({ results: fallbackResults });
      }

      req.log.info(
        { count: results?.length || 0 },
        "Found relevant chunks"
      );

      // Log similarity scores for debugging
      if (results && results.length > 0) {
        req.log.info(
          {
            topMatches: results.map((r: SearchResult) => ({
              filename: r.filename,
              similarity: r.similarity,
            })),
          },
          "Top matches"
        );
      } else {
        req.log.info("No results found");
      }

      return res.json({ results: results || [] });
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Internal server error";
      req.log.error({ err: error }, "Error searching knowledge base");
      return res.status(500).json({
        error: errorMessage,
        requestId: req.id,
      });
    }
  }
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// POST /api/knowledge-base/context
// Insert a context_knowledge row scoped to the active org. Admin-only.
// Body: { title, content, category, metadata? }
// ---------------------------------------------------------------------------
router.post(
  "/knowledge-base/context",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const { userId, orgId: clerkOrgId, orgRole } = auth;

      if (!userId) {
        return res.status(401).json({ error: "Unauthorized", requestId: req.id });
      }
      if (!clerkOrgId) {
        return res.status(403).json({ error: "No organization context", requestId: req.id });
      }
      if (!isOrgAdmin(orgRole)) {
        return res.status(403).json({ error: "Org admin role required", requestId: req.id });
      }

      const { title, content, category, metadata } = req.body ?? {};
      if (typeof title !== "string" || !title.trim() ||
          typeof content !== "string" || !content.trim() ||
          typeof category !== "string" || !category.trim()) {
        return res.status(400).json({
          error: "title, content, and category are required strings",
          requestId: req.id,
        });
      }

      const supabase = getSupabaseAdmin();
      const organizationId = await resolveOrgIdFromClerk(supabase, clerkOrgId, req.log);
      if (!organizationId) {
        return res.status(400).json({ error: "Could not resolve organization", requestId: req.id });
      }

      const { data: inserted, error: insertError } = await supabase
        .from("context_knowledge")
        .insert({
          organization_id: organizationId,
          title,
          content,
          category,
          metadata: metadata ?? {},
        })
        .select("id")
        .single();

      if (insertError) {
        req.log.error({ err: insertError, organizationId }, "Failed to insert context_knowledge");
        return res.status(500).json({ error: "Failed to add context knowledge", requestId: req.id });
      }

      return res.json({ id: inserted.id, requestId: req.id });
    } catch (error: unknown) {
      req.log.error({ err: error }, "Error adding context knowledge");
      const message = error instanceof Error ? error.message : "Internal server error";
      return res.status(500).json({ error: message, requestId: req.id });
    }
  }
);

// ---------------------------------------------------------------------------
// DELETE /api/knowledge-base/context/:id
// Delete a context_knowledge row, validated to belong to the active org. Admin-only.
// ---------------------------------------------------------------------------
router.delete(
  "/knowledge-base/context/:id",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const { userId, orgId: clerkOrgId, orgRole } = auth;

      if (!userId) return res.status(401).json({ error: "Unauthorized", requestId: req.id });
      if (!clerkOrgId) return res.status(403).json({ error: "No organization context", requestId: req.id });
      if (!isOrgAdmin(orgRole)) return res.status(403).json({ error: "Org admin role required", requestId: req.id });

      const id = req.params.id as string;
      if (!id || !UUID_RE.test(id)) {
        return res.status(400).json({ error: "Invalid id", requestId: req.id });
      }

      const supabase = getSupabaseAdmin();
      const organizationId = await resolveOrgIdFromClerk(supabase, clerkOrgId, req.log);
      if (!organizationId) {
        return res.status(400).json({ error: "Could not resolve organization", requestId: req.id });
      }

      const { data: row, error: fetchError } = await supabase
        .from("context_knowledge")
        .select("id, organization_id")
        .eq("id", id)
        .maybeSingle();

      if (fetchError) {
        req.log.error({ err: fetchError, id }, "Error fetching context_knowledge for delete");
        return res.status(500).json({ error: "Failed to load row", requestId: req.id });
      }
      if (!row) {
        return res.status(404).json({ error: "Not found", requestId: req.id });
      }
      if (row.organization_id !== organizationId) {
        return res.status(403).json({ error: "Row does not belong to your organization", requestId: req.id });
      }

      const { error: deleteError } = await supabase
        .from("context_knowledge")
        .delete()
        .eq("id", id);

      if (deleteError) {
        req.log.error({ err: deleteError, id }, "Failed to delete context_knowledge");
        return res.status(500).json({ error: "Failed to delete", requestId: req.id });
      }

      return res.json({ success: true, requestId: req.id });
    } catch (error: unknown) {
      req.log.error({ err: error }, "Error deleting context knowledge");
      const message = error instanceof Error ? error.message : "Internal server error";
      return res.status(500).json({ error: message, requestId: req.id });
    }
  }
);

// ---------------------------------------------------------------------------
// DELETE /api/knowledge-base/shareable/:id
// Delete a shareable_documents row, validated to belong to the active org. Admin-only.
// ---------------------------------------------------------------------------
router.delete(
  "/knowledge-base/shareable/:id",
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const auth = getAuth(req);
      const { userId, orgId: clerkOrgId, orgRole } = auth;

      if (!userId) return res.status(401).json({ error: "Unauthorized", requestId: req.id });
      if (!clerkOrgId) return res.status(403).json({ error: "No organization context", requestId: req.id });
      if (!isOrgAdmin(orgRole)) return res.status(403).json({ error: "Org admin role required", requestId: req.id });

      const id = req.params.id as string;
      if (!id || !UUID_RE.test(id)) {
        return res.status(400).json({ error: "Invalid id", requestId: req.id });
      }

      const supabase = getSupabaseAdmin();
      const organizationId = await resolveOrgIdFromClerk(supabase, clerkOrgId, req.log);
      if (!organizationId) {
        return res.status(400).json({ error: "Could not resolve organization", requestId: req.id });
      }

      const { data: row, error: fetchError } = await supabase
        .from("shareable_documents")
        .select("id, organization_id")
        .eq("id", id)
        .maybeSingle();

      if (fetchError) {
        req.log.error({ err: fetchError, id }, "Error fetching shareable_documents for delete");
        return res.status(500).json({ error: "Failed to load row", requestId: req.id });
      }
      if (!row) {
        return res.status(404).json({ error: "Not found", requestId: req.id });
      }
      if (row.organization_id !== organizationId) {
        return res.status(403).json({ error: "Row does not belong to your organization", requestId: req.id });
      }

      const { error: deleteError } = await supabase
        .from("shareable_documents")
        .delete()
        .eq("id", id);

      if (deleteError) {
        req.log.error({ err: deleteError, id }, "Failed to delete shareable_documents");
        return res.status(500).json({ error: "Failed to delete", requestId: req.id });
      }

      return res.json({ success: true, requestId: req.id });
    } catch (error: unknown) {
      req.log.error({ err: error }, "Error deleting shareable document");
      const message = error instanceof Error ? error.message : "Internal server error";
      return res.status(500).json({ error: message, requestId: req.id });
    }
  }
);

export default router;
