/**
 * Shareable Documents Tool — pgvector search on customer-facing docs.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { generateEmbedding } from '../services/embeddings.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'shareable_docs_search' });

export function createShareableDocsTool(userId: string, organizationId: string | null) {
  return new DynamicStructuredTool({
    name: 'shareable_docs_search',
    description:
      'Search for customer-facing documents like SOC2 reports, case studies, datasheets, MSAs, privacy policies, presentations, and comparison sheets. Use when asked about documents to share with customers or specific collateral.',
    schema: z.object({
      query: z.string().describe('What document are you looking for'),
      docType: z
        .enum([
          'soc2',
          'pen-test',
          'msa',
          'terms',
          'privacy',
          'datasheet',
          'case-study',
          'comparison',
          'presentation',
          'one-pager',
        ])
        .optional()
        .describe('Optional document type filter'),
    }),
    func: async ({ query, docType }) => {
      log.info({ query, docType: docType || 'all' }, 'Searching shareable docs');

      // Org must be explicitly provided — never fall back to implicit resolution.
      if (!organizationId) {
        log.warn({ userId }, 'No org context — refusing to search');
        return JSON.stringify({ error: 'Organization context required for document search.', results: [] });
      }
      const orgId = organizationId;

      try {
        const queryEmbedding = await generateEmbedding(query);

        const { data: results, error: searchError } = await supabase.rpc('search_shareable_documents', {
          query_embedding: queryEmbedding,
          organization_id_filter: orgId,
          match_threshold: 0.4,
          match_count: 5,
          doc_type_filter: docType || null,
        });

        let rows: any[] = [];

        if (searchError) {
          log.error({ err: searchError }, 'RPC error, trying fallback');

          // Fallback: text search. `shareable_documents` has no `download_url`
          // column — we store `file_path` and generate signed URLs on demand.
          let fallbackQuery = supabase
            .from('shareable_documents')
            .select('id, title, description, doc_type, file_name, file_path')
            .eq('organization_id', orgId);

          if (docType) fallbackQuery = fallbackQuery.eq('doc_type', docType);

          const { data: fallbackResults } = await fallbackQuery.limit(5);

          const queryLower = query.toLowerCase();
          rows = (fallbackResults || [])
            .filter(
              (d: any) =>
                d.title?.toLowerCase().includes(queryLower) ||
                d.description?.toLowerCase().includes(queryLower)
            )
            .map((d: any) => ({ ...d, similarity: 0.5 }));
        } else {
          rows = results || [];
        }

        if (rows.length === 0) {
          return JSON.stringify({ message: 'No matching documents found.', results: [] });
        }

        const formatted = await Promise.all(
          rows.map(async (r: any, i: number) => {
            let downloadUrl: string | null = null;
            if (r.file_path) {
              const { data: signed, error: signErr } = await supabase.storage
                .from('documents')
                .createSignedUrl(r.file_path, 3600);
              if (signErr) {
                log.warn({ err: signErr, filePath: r.file_path }, 'Failed to sign download URL');
              } else {
                downloadUrl = signed?.signedUrl ?? null;
              }
            }
            return {
              rank: i + 1,
              id: r.id,
              title: r.title,
              description: r.description,
              docType: r.doc_type,
              fileName: r.file_name,
              downloadUrl,
              similarity: Math.round((r.similarity ?? 0.5) * 100) + '%',
            };
          })
        );

        log.info({ count: formatted.length }, 'Found documents');
        return JSON.stringify({ results: formatted });
      } catch (err: any) {
        log.error({ err }, 'Error searching shareable docs');
        return JSON.stringify({ error: err.message, results: [] });
      }
    },
  });
}
