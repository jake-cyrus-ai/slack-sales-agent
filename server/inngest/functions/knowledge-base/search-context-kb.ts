/**
 * Search Context Knowledge Base Inngest Function
 * 
 * Searches internal knowledge for reasoning (sales playbooks, competitive intel, etc.).
 * Used by the email response agent to gather context.
 * Migrated from Supabase Edge Functions to Inngest.
 */

import { inngest } from "../../client";
import { getSupabaseAdmin, generateEmbedding, resolveOrgForUser } from "../../utils";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "search-context-kb" });

export const searchContextKB = inngest.createFunction(
  { 
    id: "search-context-kb",
    retries: 3,
  },
  { event: "knowledge-base/search-context" },
  async ({ event, step }) => {
    const { 
      query, 
      limit = 5, 
      category, 
      threshold = 0.5,
      userId,
      organizationId 
    } = event.data;

    // Step 1: Get user's organization
    const actualOrgId = await step.run("get-organization", async () => {
      const userOrgId = await resolveOrgForUser(userId);

      // Log security warning if mismatch
      if (organizationId && organizationId !== userOrgId) {
        log.warn({ clientOrg: organizationId, userOrg: userOrgId }, "SECURITY: Client sent different org than user belongs to");
      }

      return userOrgId;
    });

    if (!actualOrgId) {
      return { 
        error: "No organization found",
        results: [] 
      };
    }

    log.info({ orgId: actualOrgId, queryPreview: query.substring(0, 50) }, "Searching");

    // Step 2: Generate embedding
    const queryEmbedding = await step.run("generate-embedding", async () => {
      return await generateEmbedding(query);
    });

    // Step 3: Vector search
    const results = await step.run("vector-search", async () => {
      const supabase = getSupabaseAdmin();

      const { data, error: searchError } = await supabase.rpc(
        "search_context_knowledge",
        {
          query_embedding: queryEmbedding,
          organization_id_filter: actualOrgId,
          match_threshold: threshold,
          match_count: limit,
          category_filter: category || null,
        }
      );

      if (searchError) {
        log.error({ err: searchError }, "Search error");

        // Fallback search
        log.info("Attempting fallback search...");

        let fallbackQuery = supabase
          .from("context_knowledge")
          .select("id, title, content, category, subcategory, tags, priority")
          .eq("organization_id", actualOrgId);

        if (category) {
          fallbackQuery = fallbackQuery.eq("category", category);
        }

        const { data: fallbackResults, error: fallbackError } = await fallbackQuery.limit(limit);

        if (fallbackError) {
          throw new Error(`Search failed: ${fallbackError.message}`);
        }

        // Filter by text matching
        const queryLower = query.toLowerCase();
        const filtered = fallbackResults
          ?.filter((item: any) =>
            item.title.toLowerCase().includes(queryLower) ||
            item.content.toLowerCase().includes(queryLower)
          )
          .map((item: any) => ({ ...item, similarity: 0.5, is_fallback: true }));

        return filtered || [];
      }

      log.info({ resultCount: data?.length || 0 }, "Found results");
      
      return data || [];
    });

    return { results };
  }
);
