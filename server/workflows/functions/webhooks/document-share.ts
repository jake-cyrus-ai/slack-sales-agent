/**
 * Document Share Handler for Vercel Workflow
 *
 * Detects document share requests and uploads actual files to Slack.
 * Ported from server/src/slack/document-share.ts, adapted for Vercel Workflow context
 * (uses raw fetch instead of @slack/web-api, uses getSupabaseAdmin instead of
 * the singleton supabase client).
 */

import { getSupabaseAdmin } from "../../utils/supabase";
import { generateEmbedding } from "../../../src/services/embeddings";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "document-share" });

/**
 * Sanitize a value for safe interpolation into PostgREST `.or()` filter strings.
 * Strips characters that act as metacharacters in PostgREST filter syntax
 * (commas separate conditions, dots separate column.operator.value, parens group).
 */
function sanitizeForPostgrestFilter(value: string): string {
  return value.replace(/[,.()[\]]/g, " ").replace(/\s+/g, " ").trim();
}

export interface DocumentShareRequest {
  isShareRequest: boolean;
  query: string | null;
}

/**
 * Detect if a message is asking to share/get a document.
 * Patterns: "can I have", "can I get", "send me", "give me", "share", "get me", "i need"
 */
export function detectDocumentShareRequest(text: string): DocumentShareRequest {
  const lowerText = text.toLowerCase().trim();

  const sharePatterns = [
    /(?:can\s+i\s+(?:have|get)|send\s+me|give\s+me|share)\s+(?:the\s+)?(?:my\s+)?(?:our\s+)?(.+)/i,
    /(?:i\s+need|get\s+me)\s+(?:the\s+)?(?:my\s+)?(?:our\s+)?(.+)/i,
  ];

  for (const pattern of sharePatterns) {
    const match = lowerText.match(pattern);
    if (match) {
      const query = match[1]?.trim().replace(/[?!.,;:]+$/, "").trim();
      if (
        /soc\s*2|privacy|terms|policy|contract|msa|nda|datasheet|pdf|document|report|agreement|security|memo|one[- ]?pager|case[- ]?study|presentation|deck|comparison/i.test(
          query
        )
      ) {
        return { isShareRequest: true, query };
      }
    }
  }

  return { isShareRequest: false, query: null };
}

export interface ShareDocumentResult {
  success: boolean;
  documentTitle?: string;
  error?: string;
}

/**
 * Search for a document and upload it directly to Slack.
 * Uses raw fetch for Slack API calls (no @slack/web-api dependency in Vercel Workflow).
 */
export async function shareDocumentInWorkflow(
  botToken: string,
  channel: string,
  threadTs: string | undefined,
  query: string,
  organizationId: string
): Promise<ShareDocumentResult> {
  const supabase = getSupabaseAdmin();

  log.info({ query, organizationId }, "Searching for");

  try {
    // Generate embedding for query
    const queryEmbedding = await generateEmbedding(query);
    log.info("Generated embedding, searching...");

    // Search shareable documents using vector search
    const { data: results, error: searchError } = await supabase.rpc(
      "search_shareable_documents",
      {
        query_embedding: queryEmbedding,
        organization_id_filter: organizationId,
        match_threshold: 0.3,
        match_count: 1,
        doc_type_filter: null,
      }
    );

    log.info({ resultCount: results?.length || 0, searchError: searchError?.message }, "Vector search results");

    let document = results?.[0];

    // If found via vector search, fetch created_by for legacy path support
    if (document && document.id) {
      const { data: fullDoc } = await supabase
        .from("shareable_documents")
        .select("created_by")
        .eq("id", document.id)
        .single();

      if (fullDoc) {
        document = { ...document, created_by: fullDoc.created_by };
      }
    }

    // Fallback to text search if no vector results
    if (!document) {
      log.info("No vector results, trying text search...");

      const normalizedQuery = query
        .replace(/soc2/i, "soc 2")
        .replace(/(\d)/g, " $1")
        .replace(/\s+/g, " ")
        .trim();

      log.info({ normalizedQuery }, "Text search with normalized query");

      const safeQuery = sanitizeForPostgrestFilter(query);
      const safeNormalized = sanitizeForPostgrestFilter(normalizedQuery);

      const { data: fallback } = await supabase
        .from("shareable_documents")
        .select(
          "id, title, description, file_path, file_name, file_type, created_by, organization_id"
        )
        .eq("organization_id", organizationId)
        .or(
          `title.ilike.%${safeQuery}%,description.ilike.%${safeQuery}%,title.ilike.%${safeNormalized}%,description.ilike.%${safeNormalized}%`
        )
        .limit(1)
        .maybeSingle();

      log.info({ title: fallback ? fallback.title : "not found" }, "Text search result");
      document = fallback;
    }

    if (!document || !document.file_path) {
      return {
        success: false,
        error: `I couldn't find a document matching "${query}". Try asking for a specific document like "SOC2 report" or "Privacy Policy".`,
      };
    }

    log.info({ title: document.title, filePath: document.file_path }, "Found document");

    // Determine the correct storage path
    let storagePath = document.file_path;
    if (!storagePath.includes("/")) {
      if (document.created_by) {
        storagePath = `${document.created_by}/${document.file_path}`;
        log.info("Using legacy path pattern with created_by");
      }
    }

    log.info({ storagePath }, "Downloading from storage path");

    // Download file from Supabase Storage
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("documents")
      .download(storagePath);

    if (downloadError || !fileData) {
      log.error({ err: downloadError }, "Download error");
      return { success: false, error: "Failed to download document from storage" };
    }

    // Convert Blob to Buffer
    const arrayBuffer = await fileData.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const fileName = document.file_name || "document.pdf";
    const title = document.title || document.file_name;

    log.info({ fileName, fileSize: buffer.length, tokenPrefix: botToken.substring(0, 10) + "..." }, "Uploading to Slack");

    // Step 1: Get upload URL from Slack
    const getUrlResp = await fetch("https://slack.com/api/files.getUploadURLExternal", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${botToken}`,
      },
      body: new URLSearchParams({
        filename: fileName,
        length: String(buffer.length),
      }),
    });

    const getUrlData = (await getUrlResp.json()) as {
      ok: boolean;
      upload_url?: string;
      file_id?: string;
      error?: string;
      needed?: string;
      provided?: string;
      response_metadata?: any;
    };

    if (!getUrlData.ok || !getUrlData.upload_url || !getUrlData.file_id) {
      log.error({ getUrlData }, "Failed to get upload URL");
      return { success: false, error: `Failed to get Slack upload URL: ${getUrlData.error}` };
    }

    // Step 2: Upload file content to the URL
    const uploadResp = await fetch(getUrlData.upload_url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: buffer,
    });

    if (!uploadResp.ok) {
      log.error({ status: uploadResp.status }, "Upload failed");
      return { success: false, error: "Failed to upload file to Slack" };
    }

    // Step 3: Complete the upload and share to the channel/thread
    const completeResp = await fetch("https://slack.com/api/files.completeUploadExternal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({
        files: [{ id: getUrlData.file_id, title }],
        channel_id: channel,
        thread_ts: threadTs,
        initial_comment: `Here's the ${title} you requested!`,
      }),
    });

    const completeData = (await completeResp.json()) as { ok: boolean; error?: string; needed?: string; provided?: string };

    if (!completeData.ok) {
      log.error({ completeData }, "Complete upload failed");
      return { success: false, error: "Failed to complete Slack file upload" };
    }

    log.info({ title }, "Successfully uploaded");
    return { success: true, documentTitle: title };
  } catch (err: any) {
    log.error({ err }, "Error");
    return { success: false, error: err.message || "Unknown error" };
  }
}
