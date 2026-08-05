/**
 * Upload Shareable Documents Vercel Workflow Function
 * 
 * Handles document uploads to the Shareable Documents KB.
 * Supports both direct file uploads and pre-uploaded files (via Express route).
 * Triggers document processing pipeline after successful upload.
 */

import { workflow } from "../../client";
import { getSupabaseAdmin } from "../../utils/supabase";
import { generateEmbedding } from "../../utils/llm/clients";

export const uploadShareableDocs = workflow.createFunction(
  { 
    id: "upload-shareable-docs",
    retries: 3,
  },
  { event: "document/uploaded" },
  async ({ event, step }) => {
        const { path, file, userId, organizationId, category, metadata: eventMetadata } = event.data;

    // Step 1: Save file to Supabase Storage (if not already uploaded)
    const fileMetadata = await step.run("save-to-storage", async () => {
            // If file was already uploaded by Express route, use provided metadata
      if (eventMetadata?.filePath && eventMetadata.filePath !== "") {
        return {
          filePath: eventMetadata.filePath,
          fileName: eventMetadata.fileName || path,
          fileSize: eventMetadata.fileSizeBytes || 0,
          fileType: eventMetadata.fileType || "application/octet-stream",
          alreadyUploaded: true,
        };
      }

      // Otherwise, upload the file to storage
      const supabase = getSupabaseAdmin();
      
      const timestamp = Date.now();
      const filePath = `shareable-docs/${organizationId}/${timestamp}-${path}`;
      
      const { error: uploadError } = await supabase.storage
        .from("documents")
        .upload(filePath, file, {
          upsert: false,
        });

      if (uploadError) {
        throw new Error(`Storage upload failed: ${uploadError.message}`);
      }

      const fileSize = file instanceof Blob ? file.size : 0;

      return {
        filePath,
        fileName: path,
        fileSize,
        fileType: file instanceof Blob ? file.type : "application/octet-stream",
        alreadyUploaded: false,
      };
    });

    // Step 2: Generate embedding from content
    const embeddingData = await step.run("generate-embedding", async () => {
            // Use provided text content if available, otherwise generate from metadata
      const textContent = eventMetadata?.textContent || 
        `Document: ${eventMetadata?.title || fileMetadata.fileName}\n${eventMetadata?.description || ""}\nCategory: ${eventMetadata?.docType || category || "general"}`;
      
      const embedding = await generateEmbedding(textContent);

      return {
        textContent,
        embedding,
      };
    });

    // Step 3: Create database record
    const documentRecord = await step.run("create-db-record", async () => {
            const supabase = getSupabaseAdmin();

      const insertPayload = {
        organization_id: organizationId,
        title: eventMetadata?.title || fileMetadata.fileName,
        description: eventMetadata?.description || null,
        file_path: fileMetadata.filePath,
        file_name: fileMetadata.fileName,
        file_type: fileMetadata.fileType,
        file_size_bytes: fileMetadata.fileSize,
        content: embeddingData.textContent,
        embedding: embeddingData.embedding,
        created_by: userId,
        doc_type: eventMetadata?.docType || category || "other",
        tags: eventMetadata?.tags || [],
        is_public: eventMetadata?.isPublic || false,
        requires_nda: eventMetadata?.requiresNda || false,
        version: eventMetadata?.version || "1.0",
        valid_until: eventMetadata?.validUntil || null,
      };

      const { data: insertedDoc, error: insertError } = await supabase
        .from("shareable_documents")
        .insert(insertPayload)
        .select()
        .single();

      if (insertError) {
        throw new Error(`Database insert failed: ${insertError.message}`);
      }

      return insertedDoc;
    });

    return {
      success: true,
      documentId: documentRecord.id,
      title: documentRecord.title,
      filePath: fileMetadata.filePath,
    };
  }
);
