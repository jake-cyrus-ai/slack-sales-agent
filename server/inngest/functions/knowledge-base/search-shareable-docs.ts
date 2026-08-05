/**
 * Search Shareable Documents Inngest Function
 * 
 * Searches customer-facing documents that can be attached to emails.
 * Used by the email response agent.
 * Migrated from Supabase Edge Functions to Inngest.
 */

import { inngest } from "../../client";
import { getSupabaseAdmin, generateEmbedding, resolveOrgForUser } from "../../utils";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "search-shareable-docs" });

export const searchShareableDocs = inngest.createFunction(
  { 
    id: "search-shareable-docs",
    retries: 3,
  },
  { event: "knowledge-base/search-shareable" },
  async ({ event, step }) => {
    const { 
      query, 
      limit = 5, 
      doc_type,
      threshold = 0.5,
      userId,
      organizationId,
      include_download_url = false
    } = event.data;

    // Step 1: Get user's organization
    const actualOrgId = await step.run("get-organization", async () => {
      const userOrgId = await resolveOrgForUser(userId);

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

    // Step 3: Vector search with fallback
    let results = await step.run("vector-search", async () => {
      const supabase = getSupabaseAdmin();

      const { data, error: searchError } = await supabase.rpc(
        "search_shareable_documents",
        {
          query_embedding: queryEmbedding,
          organization_id_filter: actualOrgId,
          match_threshold: threshold,
          match_count: limit,
          doc_type_filter: doc_type || null,
        }
      );

      // Fallback function
      const runFallback = async (): Promise<any[]> => {
        log.info("Attempting fallback search...");
        
        let fallbackQuery = supabase
          .from("shareable_documents")
          .select("id, title, description, doc_type, file_path, file_name, file_type, is_public, requires_nda, tags")
          .eq("organization_id", actualOrgId);

        if (doc_type) {
          fallbackQuery = fallbackQuery.eq("doc_type", doc_type);
        }

        const { data: fallbackResults, error: fallbackError } = await fallbackQuery.limit(limit);

        if (fallbackError) {
          throw new Error(`Search failed: ${fallbackError.message}`);
        }

        const queryLower = (query || "").toLowerCase().trim();
        const filtered = (fallbackResults || []).map((item: any) => ({ 
          ...item, 
          similarity: 0.5, 
          is_fallback: true 
        }));
        
        if (!doc_type && queryLower) {
          return filtered.filter((item: any) =>
            (item.title && item.title.toLowerCase().includes(queryLower)) ||
            (item.description && item.description.toLowerCase().includes(queryLower))
          );
        }
        
        return filtered;
      };

      if (searchError) {
        log.error({ err: searchError }, "Search error");
        return await runFallback();
      }

      let enrichedResults = data || [];

      // Try fallback if no results
      if (enrichedResults.length === 0) {
        try {
          const fallbackFiltered = await runFallback();
          if (fallbackFiltered.length > 0) {
            log.info({ resultCount: fallbackFiltered.length }, "Fallback found results");
            enrichedResults = fallbackFiltered;
          }
        } catch (fallbackErr) {
          log.warn({ err: fallbackErr }, "Fallback search failed");
        }
      }

      log.info({ resultCount: enrichedResults.length }, "Found results");
      
      return enrichedResults;
    });

    // Step 4: Generate signed download URLs if requested
    if (include_download_url && results.length > 0) {
      results = await step.run("generate-download-urls", async () => {
        const supabase = getSupabaseAdmin();
        
        return await Promise.all(
          results.map(async (doc: any) => {
            if (doc.file_path) {
              const { data: signedUrl } = await supabase.storage
                .from("documents")
                .createSignedUrl(doc.file_path, 3600); // 1 hour expiry

              return {
                ...doc,
                download_url: signedUrl?.signedUrl || null,
              };
            }
            return doc;
          })
        );
      });
    }

    return { results };
  }
);
