/**
 * Generate Embeddings Vercel Workflow Function
 * 
 * Generates embeddings for individual document chunks.
 * Designed to run with high concurrency for parallel processing.
 */

import { workflow } from "../../client";
import { getSupabaseAdmin } from "../../utils/supabase";
import { generateEmbedding } from "../../utils/llm/clients";

export const generateEmbeddings = workflow.createFunction(
  { 
    id: "generate-embeddings",
    retries: 3,
    concurrency: {
      limit: 5,
    },
  },
  { event: "document/generate-embedding" },
  async ({ event, step }) => {
        const { chunkId, text, organizationId } = event.data;

    // Validate input
    if (!text || text.length > 10000) {
      throw new Error("Invalid text content for embedding generation");
    }

    // Step 1: Generate embedding using OpenAI
    const embedding = await step.run("create-embedding", async () => {
            return await generateEmbedding(text);
    });

    // Step 2: Verify chunk belongs to organization (multi-tenant security)
    await step.run("verify-organization", async () => {
            const supabase = getSupabaseAdmin();

      const { data: chunk, error: chunkError } = await supabase
        .from("document_chunks")
        .select("organization_id")
        .eq("id", chunkId)
        .single();

      if (chunkError || !chunk) {
        throw new Error(`Chunk not found: ${chunkId}`);
      }

      if (chunk.organization_id !== organizationId) {
        throw new Error("Unauthorized: Chunk does not belong to organization");
      }
    });

    // Step 3: Store embedding in database
    await step.run("save-embedding", async () => {
            const supabase = getSupabaseAdmin();

      const { error: insertError } = await supabase
        .from("document_embeddings")
        .insert({
          chunk_id: chunkId,
          embedding: embedding,
          organization_id: organizationId,
        });

      if (insertError) {
        throw new Error(`Failed to insert embedding: ${insertError.message}`);
      }

      return { chunkId, embeddingLength: embedding.length };
    });

    return { 
      success: true, 
      chunkId,
      embeddingDimensions: embedding.length,
    };
  }
);
