/**
 * Search Knowledge Base Inngest Function
 * 
 * Performs vector similarity search on the main knowledge base.
 * Migrated from Supabase Edge Functions to Inngest.
 */

import { inngest } from "../../client";
import { getSupabaseAdmin, generateEmbedding, getUserOrganization } from "../../utils";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "search-knowledge-base" });

export const searchKnowledgeBase = inngest.createFunction(
  { 
    id: "search-knowledge-base",
    retries: 3,
  },
  { event: "knowledge-base/search" },
  async ({ event, step }) => {
    const { query, limit = 5, userId, organizationId } = event.data;

    // Step 1: Get user's organization
    const actualOrgId = await step.run("get-organization", async () => {
      const supabase = getSupabaseAdmin();
      
      // Always fetch org from user profile for security
      const orgId = await getUserOrganization(supabase, userId);
      
      // Log security warning if client provided different org
      if (organizationId && organizationId !== orgId) {
        log.warn({ clientOrg: organizationId, userOrg: orgId }, "SECURITY: Client sent different org than user belongs to");
      }
      
      return orgId;
    });

    if (!actualOrgId) {
      return { 
        error: "No organization found",
        results: [] 
      };
    }

    log.info({ orgId: actualOrgId, queryPreview: query.substring(0, 50) }, "Searching");

    // Step 2: Generate embedding for the query
    const queryEmbedding = await step.run("generate-embedding", async () => {
      return await generateEmbedding(query);
    });

    // Step 3: Perform vector search
    const results = await step.run("vector-search", async () => {
      const supabase = getSupabaseAdmin();
      
      const searchParams: Record<string, unknown> = {
        query_embedding: queryEmbedding,
        match_threshold: 0.0, // Low threshold to see all results
        match_count: limit,
      };

      // Add organization filter if available
      if (actualOrgId) {
        searchParams.organization_id_filter = actualOrgId;
      }

      const { data, error: searchError } = await supabase.rpc('search_documents', searchParams);

      if (searchError) {
        // Fallback to manual search if RPC doesn't exist
        log.info("RPC not found, using fallback search");

        let chunksQuery = supabase
          .from('document_chunks')
          .select(`
            *,
            documents!inner(filename, category, organization_id),
            document_embeddings(embedding)
          `);

        // Apply org filtering
        if (actualOrgId) {
          chunksQuery = chunksQuery.or(
            `organization_id.eq.${actualOrgId},organization_id.is.null`,
            { foreignTable: 'documents' }
          );
        }

        const { data: chunks, error: chunksError } = await chunksQuery.limit(100);

        if (chunksError) {
          throw chunksError;
        }

        // Simple text matching fallback
        const filteredChunks = chunks
          ?.filter(chunk =>
            chunk.content.toLowerCase().includes(query.toLowerCase())
          )
          .slice(0, limit);

        return filteredChunks?.map(chunk => ({
          content: chunk.content,
          filename: chunk.documents.filename,
          category: chunk.documents.category,
          similarity: 0.5,
          is_fallback: true
        })) || [];
      }

      log.info({ resultCount: data?.length || 0 }, "Found results");
      
      return data || [];
    });

    return { results };
  }
);
