/**
 * Email Share Handler
 *
 * Detects requests to send documents via email from Slack and sends them
 * as Gmail attachments. Uses the googleapis SDK for typed API access.
 *
 * Example: "Send customer-memo to ali@your-app.example.com"
 *        -> finds "customer-memo" doc, sends as attachment to ali@your-app.example.com
 *
 * Supports multi-doc: "Send the SOC 2 and NDA to ali@your-app.example.com"
 *        -> finds both docs, sends as attachments in one email
 */

import { WebClient } from '@slack/web-api';
import { getSupabaseAdmin } from '../../workflows/utils/supabase';
import { generateEmbedding } from '../services/embeddings.js';
import { getGmailClient } from '../services/google-client.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ component: 'email-share' });

/**
 * Sanitize a value for safe interpolation into PostgREST `.or()` filter strings.
 * Strips characters that act as metacharacters in PostgREST filter syntax
 * (commas separate conditions, dots separate column.operator.value, parens group).
 */
function sanitizeForPostgrestFilter(value: string): string {
  return value.replace(/[,.()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Split a query string on common separators to support multi-doc requests.
 * "soc 2 and nda" → ["soc 2", "nda"]
 * "soc 2, privacy policy, and msa" → ["soc 2", "privacy policy", "msa"]
 * "soc 2 report" → ["soc 2 report"]
 */
function splitDocumentQueries(query: string): string[] {
  return query
    .split(/,\s*and\s+|,\s+|\s+and\s+/)
    .map((q) => q.trim())
    .filter((q) => q.length > 0);
}

/**
 * Format a list with Oxford comma: ["a"] → "a", ["a","b"] → "a and b",
 * ["a","b","c"] → "a, b, and c"
 */
function formatList(items: string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

export interface EmailShareRequest {
  isEmailRequest: boolean;
  queries: string[];
  recipientEmail: string | null;
}

/**
 * Strip Slack markup so detection regexes work on plain text.
 * Slack formats mentions as <@U12345> and emails as <mailto:a@b.com|a@b.com>.
 */
function stripSlackFormatting(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+>/gi, '')                        // remove user/bot mentions
    .replace(/<mailto:([^|>]+)\|[^>]*>/gi, '$1')           // mailto links -> plain email
    .replace(/<mailto:([^>]+)>/gi, '$1')                   // mailto without label
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/gi, '$2')    // URL links -> label
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detect if a message is asking to send a document via email.
 * Patterns: "send <document> to <email>", "email <document> to <email>"
 */
export function detectEmailShareRequest(text: string): EmailShareRequest {
  const lowerText = stripSlackFormatting(text).toLowerCase().trim();

  const emailPatterns = [
    /(?:can\s+you\s+)?(?:send|email|forward)\s+(?:the\s+)?(?:my\s+)?(?:our\s+)?(.+?)\s+to\s+([\w.+-]+@[\w.-]+\.[a-z]{2,})/i,
  ];

  for (const pattern of emailPatterns) {
    const match = lowerText.match(pattern);
    if (match) {
      const rawQuery = match[1]?.trim().replace(/[?!.,;:]+$/, '').trim();
      const recipientEmail = match[2]?.trim();

      if (rawQuery && recipientEmail) {
        const queries = splitDocumentQueries(rawQuery);
        return { isEmailRequest: true, queries, recipientEmail };
      }
    }
  }

  return { isEmailRequest: false, queries: [], recipientEmail: null };
}

export interface EmailShareResult {
  success: boolean;
  recipientEmail?: string;
  documentTitles?: string[];
  notFound?: string[];
  error?: string;
}

/**
 * Find multiple documents in parallel. Returns found docs and the queries that failed.
 */
async function findDocuments(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  queries: string[],
  organizationId: string,
): Promise<{ found: DocumentResult[]; notFound: string[] }> {
  const results = await Promise.all(
    queries.map(async (query) => {
      const doc = await findDocument(supabase, query, organizationId);
      return { query, doc };
    }),
  );

  const found: DocumentResult[] = [];
  const notFound: string[] = [];

  for (const { query, doc } of results) {
    if (doc && doc.file_path) {
      found.push(doc);
    } else {
      notFound.push(query);
    }
  }

  return { found, notFound };
}

/**
 * Search for documents and send them as Gmail attachments in a single email.
 */
export async function sendDocumentViaEmail(
  _slack: WebClient,
  channelId: string,
  threadTs: string,
  queries: string[],
  recipientEmail: string,
  organizationId: string | null,
  userId: string,
): Promise<EmailShareResult> {
  if (!organizationId) {
    log.error('No organization ID provided');
    return { success: false, error: 'No organization found for user' };
  }

  const supabase = getSupabaseAdmin();
  log.info({ queries, recipientEmail, organizationId }, 'Searching for documents');

  try {
    // 1. Get Gmail client
    const client = await getGmailClient(userId);
    if (!client) {
      return {
        success: false,
        error: 'Gmail not connected. Please link your Google account at your-app.example.com first.',
      };
    }

    // 2. Find all documents in parallel
    const { found, notFound } = await findDocuments(supabase, queries, organizationId);

    if (found.length === 0) {
      const queryList = queries.map((q) => `"${q}"`).join(', ');
      return {
        success: false,
        error: `I couldn't find any documents matching ${queryList}. Try being more specific with the document names.`,
      };
    }

    log.info({ documents: found.map((d) => d.title) }, 'Found documents');
    if (notFound.length > 0) {
      log.info({ notFound }, 'Could not find documents');
    }

    // 3. Download all files from Supabase Storage in parallel
    const downloads = await Promise.all(
      found.map(async (doc) => {
        let storagePath = doc.file_path;
        if (!storagePath.includes('/') && doc.created_by) {
          storagePath = `${doc.created_by}/${doc.file_path}`;
        }

        const { data: fileData, error: downloadError } = await supabase.storage
          .from('documents')
          .download(storagePath);

        if (downloadError || !fileData) {
          log.error({ err: downloadError, title: doc.title }, 'Download error');
          return null;
        }

        const arrayBuffer = await fileData.arrayBuffer();
        const fileBuffer = Buffer.from(arrayBuffer);
        return {
          doc,
          fileBase64: fileBuffer.toString('base64'),
          fileName: doc.file_name || 'document.pdf',
        };
      }),
    );

    const successfulDownloads = downloads.filter(
      (d): d is NonNullable<typeof d> => d !== null,
    );
    if (successfulDownloads.length === 0) {
      return { success: false, error: 'Failed to download documents from storage' };
    }

    // 4. Build MIME message with multiple attachments
    const senderEmail = client.email;
    const documentTitles = successfulDownloads.map((d) => d.doc.title || d.fileName);
    const subject =
      successfulDownloads.length === 1
        ? successfulDownloads[0].doc.title || queries[0]
        : 'Documents';

    const { data: profile } = await supabase
      .from('profiles')
      .select('first_name, last_name')
      .eq('user_id', userId)
      .single();

    const senderName = profile
      ? `${properCase(profile.first_name || '')} ${properCase(profile.last_name || '')}`.trim()
      : '';

    const recipientName = inferNameFromEmail(recipientEmail);

    const boundary = `boundary_${Date.now()}`;
    const emailBody =
      successfulDownloads.length === 1
        ? `Hey ${recipientName},\n\nPlease find the attached ${documentTitles[0]}.\n\nBest regards,\n${senderName || 'Team'}`
        : `Hey ${recipientName},\n\nPlease find the attached documents: ${formatList(documentTitles)}.\n\nBest regards,\n${senderName || 'Team'}`;

    const mimeParts = [
      senderName ? `From: ${senderName} <${senderEmail}>` : `From: ${senderEmail}`,
      `To: ${recipientEmail}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      emailBody,
    ];

    for (const download of successfulDownloads) {
      const mimeType = getMimeType(download.fileName);
      mimeParts.push(
        '',
        `--${boundary}`,
        `Content-Type: ${mimeType}; name="${download.fileName}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${download.fileName}"`,
        '',
        download.fileBase64,
      );
    }

    mimeParts.push(`--${boundary}--`);

    const mimeMessage = mimeParts.join('\r\n');

    // 5. Base64url-encode the MIME message
    const raw = Buffer.from(mimeMessage)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    // 6. Send via Gmail SDK
    const sendResult = await client.gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });

    log.info({ messageId: sendResult.data.id }, 'Email sent successfully');

    // 7. Log each document in email_approval_requests for tracking
    for (const download of successfulDownloads) {
      await supabase.from('email_approval_requests').insert({
        user_id: userId,
        recipient_email: recipientEmail,
        subject,
        body: `Sent document: ${download.doc.title || download.fileName}`,
        original_request: `Send ${queries.join(', ')} to ${recipientEmail}`,
        source_type: 'slack',
        slack_workspace_id: null,
        slack_channel_id: channelId,
        slack_thread_ts: threadTs,
        status: 'sent',
        sent_at: new Date().toISOString(),
        email_message_id: sendResult.data.id,
      }).then(({ error }) => {
        if (error) log.error({ err: error }, 'Failed to log email send');
      });
    }

    return {
      success: true,
      recipientEmail,
      documentTitles,
      notFound: notFound.length > 0 ? notFound : undefined,
    };
  } catch (err: any) {
    log.error({ err }, 'Email share error');
    return { success: false, error: err.message || 'Unknown error sending email' };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface DocumentResult {
  id: string;
  title: string;
  file_path: string;
  file_name: string;
  file_type: string;
  created_by: string | null;
}

/**
 * Find a document by query using vector search with text-search fallback.
 */
async function findDocument(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  query: string,
  organizationId: string
): Promise<DocumentResult | null> {
  // Try vector search first
  const queryEmbedding = await generateEmbedding(query);
  log.info('Generated embedding, searching...');

  const { data: results, error: searchError } = await supabase.rpc(
    'search_shareable_documents',
    {
      query_embedding: queryEmbedding,
      organization_id_filter: organizationId,
      match_threshold: 0.3,
      match_count: 1,
      doc_type_filter: null,
    }
  );

  log.info({ resultCount: results?.length || 0, err: searchError || undefined }, 'Vector search results');

  let document = results?.[0] ?? null;

  // Fetch created_by for legacy path support
  if (document?.id) {
    const { data: fullDoc } = await supabase
      .from('shareable_documents')
      .select('created_by')
      .eq('id', document.id)
      .single();

    if (fullDoc) {
      document = { ...document, created_by: fullDoc.created_by };
    }
  }

  // Fallback to text search
  if (!document) {
    log.info('No vector results, trying text search...');

    const normalizedQuery = query
      .replace(/soc2/i, 'soc 2')
      .replace(/(\d)/g, ' $1')
      .replace(/\s+/g, ' ')
      .trim();

    const safeQuery = sanitizeForPostgrestFilter(query);
    const safeNormalized = sanitizeForPostgrestFilter(normalizedQuery);

    const { data: fallback } = await supabase
      .from('shareable_documents')
      .select('id, title, description, file_path, file_name, file_type, created_by, organization_id')
      .eq('organization_id', organizationId)
      .or(`title.ilike.%${safeQuery}%,description.ilike.%${safeQuery}%,title.ilike.%${safeNormalized}%,description.ilike.%${safeNormalized}%`)
      .limit(1)
      .maybeSingle();

    log.info({ title: fallback?.title || 'not found' }, 'Text search result');
    document = fallback;
  }

  return document;
}

function properCase(name: string): string {
  if (!name) return '';
  return name
    .split(/[\s-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(name.includes('-') ? '-' : ' ');
}

function inferNameFromEmail(email: string): string {
  const local = email.split('@')[0];
  const firstName = local.split(/[._+-]/)[0];
  return firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
}

function getMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    csv: 'text/csv',
    txt: 'text/plain',
    zip: 'application/zip',
  };
  return mimeTypes[ext || ''] || 'application/octet-stream';
}
