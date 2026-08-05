/**
 * Process Document Inngest Function
 * 
 * Handles document text extraction, chunking, and triggers embedding generation.
 * Implements fan-out pattern to process chunks in parallel.
 */

import { inngest } from "../../client";
import { getSupabaseAdmin } from "../../utils/supabase";
import { PDFParse } from "pdf-parse";
import { logger } from "../../../lib/logger";
import { getOpenAIClient } from "../../utils/llm/clients";

const log = logger.child({ fn: "process-document" });

/** Predefined tag vocabulary for AI auto-tagging */
const TAG_VOCABULARY = [
  "battlecard",
  "pricing",
  "product-overview",
  "objection-handling",
  "case-study",
  "security-compliance",
  "onboarding",
  "roi-calculator",
  "technical-spec",
  "integration",
  "faq",
  "process",
  "template",
  "competitive-analysis",
  "industry-report",
] as const;

const VALID_CATEGORIES = [
  "agent-playbook",
  "playbook",
  "competitive-intel",
  "product-info",
  "sales-methodology",
  "process",
  "industry-knowledge",
  "customer-memo",
  "legal",
  "security",
  "contract",
  "other",
] as const;

/**
 * Split text into chunks for embedding
 */
function chunkText(text: string, chunkSize: number = 800): string[] {
  const rawChunks: string[] = [];
  const words = text.split(/\s+/);
  let currentChunk = '';

  for (const word of words) {
    if (currentChunk.length + word.length > chunkSize) {
      if (currentChunk) rawChunks.push(currentChunk.trim());
      currentChunk = word;
    } else {
      currentChunk += (currentChunk ? ' ' : '') + word;
    }
  }
  if (currentChunk) rawChunks.push(currentChunk.trim());

  // Filter out chunks that are too short or low quality
  const chunks: string[] = [];
  for (const chunk of rawChunks) {
    // Skip chunks that are too short
    if (chunk.length < 100) {
      continue;
    }

    // Skip chunks with too many special characters (likely corrupted)
    const alphanumericRatio = (chunk.match(/[a-zA-Z0-9\s]/g) || []).length / chunk.length;
    if (alphanumericRatio < 0.7) {
      continue;
    }

    chunks.push(chunk);
  }

  return chunks;
}

/**
 * Extract text from document based on file type.
 * Accepts a base64 string (serializable across Inngest steps).
 */
export async function extractText(base64Data: string, filename: string): Promise<string> {
  const lowerFilename = filename.toLowerCase();
  const buffer = Buffer.from(base64Data, "base64");

  if (lowerFilename.endsWith('.pdf')) {
    const parser = new PDFParse({ data: buffer, verbosity: 0 });
    const result = await parser.getText();
    await parser.destroy();
    return result.text;
  } else {
    return buffer.toString("utf-8");
  }
}

export const processDocument = inngest.createFunction(
  { 
    id: "process-document",
    retries: 2,
  },
  { event: "document/process" },
  async ({ event, step }) => {
    const { documentId, userId, organizationId } = event.data;

    // Step 1: Fetch document details
    const document = await step.run("fetch-document", async () => {
      const supabase = getSupabaseAdmin();

      const { data, error } = await supabase
        .from("documents")
        .select("*")
        .eq("id", documentId)
        .single();

      if (error || !data) {
        throw new Error(`Document not found: ${documentId}`);
      }

      // Verify ownership and organization (multi-tenant isolation)
      if (data.user_id !== userId) {
        throw new Error("Unauthorized: Document does not belong to user");
      }

      // Verify organization isolation
      if (data.organization_id !== organizationId) {
        throw new Error("Unauthorized: Document does not belong to organization");
      }

      // Check if document should be in knowledge base
      if (data.in_knowledge_base === false) {
        return { skipped: true, document: data };
      }

      return { skipped: false, document: data };
    });

    // Skip processing if document is excluded from KB
    if (document.skipped) {
      await step.run("mark-as-processed", async () => {
        const supabase = getSupabaseAdmin();
        await supabase
          .from("documents")
          .update({ processed: true })
          .eq("id", documentId);
      });

      return { 
        success: true, 
        skipped: true,
        message: "Document excluded from knowledge base" 
      };
    }

    // Step 2: Download file from storage (convert to base64 for Inngest serialization)
    const fileContent = await step.run("download-file", async () => {
      const supabase = getSupabaseAdmin();

      const { data: fileData, error: downloadError } = await supabase.storage
        .from("documents")
        .download(document.document.file_path);

      if (downloadError || !fileData) {
        throw new Error("Failed to download document from storage");
      }

      const arrayBuffer = await fileData.arrayBuffer();
      return Buffer.from(arrayBuffer).toString("base64");
    });

    // Step 3: Extract text from document
    const extractedText = await step.run("extract-text", async () => {
      const text = await extractText(fileContent, document.document.filename);

      // Validate extracted text
      if (!text || text.trim().length < 50) {
        throw new Error("Extracted text is too short or empty");
      }

      // Check for binary garbage
      // eslint-disable-next-line no-control-regex
      const binaryRatio = (text.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) || []).length / text.length;
      if (binaryRatio > 0.1) {
        throw new Error(`Extracted text appears corrupted (${(binaryRatio * 100).toFixed(2)}% binary characters)`);
      }

      return text;
    });

    // Step 4: AI auto-tagging (category + tags)
    const aiTags = await step.run("ai-auto-tag", async () => {
      try {
        const openai = getOpenAIClient();
        const preview = extractedText.substring(0, 3000);

        const response = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0,
          max_tokens: 200,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `You are a document classifier for a sales enablement knowledge base.
Given the filename and first ~3000 characters of a document, return JSON with:
- "category": one of: ${VALID_CATEGORIES.join(", ")}
- "tags": array of up to 6 tags from this vocabulary: ${TAG_VOCABULARY.join(", ")}

Pick tags that best describe the document's purpose and content. Be selective — only use tags that clearly apply.
Return ONLY valid JSON, no markdown.`,
            },
            {
              role: "user",
              content: `Filename: ${document.document.filename}\n\nContent preview:\n${preview}`,
            },
          ],
        });

        const raw = response.choices[0]?.message?.content?.trim() || "{}";
        const cleaned = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
        const parsed = JSON.parse(cleaned) as { category?: string; tags?: string[] };

        // Validate category
        const category = VALID_CATEGORIES.includes(parsed.category as any)
          ? parsed.category!
          : document.document.category;

        // Validate tags — only allow known vocabulary, max 6
        const tags = (parsed.tags || [])
          .filter((t: string) => TAG_VOCABULARY.includes(t as any))
          .slice(0, 6);

        return { category, tags };
      } catch (err) {
        log.error({ err, documentId }, "AI auto-tag failed, using filename-based category");
        return { category: document.document.category, tags: [] as string[] };
      }
    });

    // Step 4b: Update document with AI-generated tags and refined category
    await step.run("update-document-tags", async () => {
      const supabase = getSupabaseAdmin();
      const { error } = await supabase
        .from("documents")
        .update({
          category: aiTags.category,
          tags: aiTags.tags,
        })
        .eq("id", documentId);

      if (error) {
        throw new Error(`Failed to update document tags: ${error.message}`);
      }
    });

    // Step 5: Chunk the text
    const chunks = await step.run("chunk-text", async () => {
      const chunkedText = chunkText(extractedText);
      
      log.info({ chunkCount: chunkedText.length, documentId }, "Created chunks from document");
      
      return chunkedText;
    });

    // Step 5: Store chunks in database
    const chunkRecords = await step.run("store-chunks", async () => {
      const supabase = getSupabaseAdmin();
      
      const chunkInserts = chunks.map((content, index) => ({
        document_id: documentId,
        organization_id: organizationId, // Multi-tenant isolation
        content,
        chunk_index: index,
        metadata: {
          filename: document.document.filename,
          category: aiTags.category,
          tags: aiTags.tags,
          chunk_length: content.length,
        },
      }));

      const { data: insertedChunks, error: chunkError } = await supabase
        .from("document_chunks")
        .insert(chunkInserts)
        .select();

      if (chunkError) {
        throw new Error(`Failed to insert chunks: ${chunkError.message}`);
      }

      return insertedChunks;
    });

    // Step 6: Fan out to embedding generation (parallel processing)
    await step.sendEvent(
      "fan-out-embeddings",
      chunkRecords.map(chunk => ({
        name: "document/generate-embedding",
        data: {
          chunkId: chunk.id,
          text: chunk.content,
          organizationId, // Pass organizationId for multi-tenant verification
        },
      }))
    );

    // Step 7: Mark document as processed
    await step.run("mark-document-processed", async () => {
      const supabase = getSupabaseAdmin();
      
      await supabase
        .from("documents")
        .update({ processed: true })
        .eq("id", documentId);
    });

    return {
      success: true,
      chunksCreated: chunks.length,
      documentId,
    };
  }
);
