/**
 * Context Knowledge Base Tool — pgvector similarity search.
 * Ported from search-context-kb/index.ts.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { generateEmbedding } from '../services/embeddings.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'context_kb_search' });

// ─── KB search result cache (5-min TTL) ─────────────────────────────────────

const KB_CACHE_TTL_MS = 5 * 60 * 1000;

type KBCacheEntry = {
  expiresAt: number;
  value: string;
};

const KB_CACHE_MAX = 200;
const kbResultCache = new Map<string, KBCacheEntry>();

export function createContextKBTool(userId: string, organizationId: string | null) {
  return new DynamicStructuredTool({
    name: 'context_kb_search',
    description:
      'Search the internal knowledge base for sales playbooks, competitive intel, pricing strategy, objection handling, product positioning, and company processes. Use when asked about internal knowledge, how to handle a situation, or company-specific information.',
    schema: z.object({
      query: z.string().describe('Search query — be specific about what information you need'),
      category: z
        .enum([
          'agent-playbook',
          'playbook',
          'competitive-intel',
          'product-info',
          'sales-methodology',
          'process',
          'industry-knowledge',
          'customer-memo',
          'legal',
          'security',
          'contract',
          'other',
        ])
        .optional()
        .describe('Optional category filter to narrow results'),
      tags: z
        .array(z.string())
        .optional()
        .describe('Optional tags to boost relevant results. Use tags like: battlecard, pricing, product-overview, objection-handling, case-study, security-compliance, onboarding, roi-calculator, technical-spec, integration, faq, process, template, competitive-analysis, industry-report'),
    }),
    func: async ({ query, category, tags }) => {
      log.info({ query, category: category || 'all', tags: tags || [] }, 'Searching knowledge base');

      // Org must be explicitly provided — never fall back to implicit resolution.
      if (!organizationId) {
        log.warn({ userId }, 'No org context — refusing to search');
        return JSON.stringify({ error: 'Organization context required for knowledge base search.', results: [] });
      }
      const orgId = organizationId;

      // Check cache after org resolution so key is always orgId-scoped
      const tagKey = tags ? [...tags].sort().join(',') : 'none';
      const cacheKey = `${orgId}:${query.toLowerCase().trim()}:${category || 'all'}:${tagKey}`;
      const now = Date.now();
      const cached = kbResultCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        log.info({ query }, 'Cache hit');
        return cached.value;
      }

      try {
        // Generate embedding for the query
        const queryEmbedding = await generateEmbedding(query);

        // Vector similarity search via RPC (searches document_embeddings → chunks → documents)
        const { data: results, error: searchError } = await supabase.rpc('search_documents', {
          query_embedding: queryEmbedding,
          organization_id_filter: orgId,
          match_threshold: 0.4,
          match_count: 5,
          category_filter: category || null,
          tag_filter: tags && tags.length > 0 ? tags : null,
        });

        if (searchError) {
          log.error({ err: searchError }, 'RPC error, trying fallback');

          // Fallback: text-based search against document_chunks
          let fallbackQuery = supabase
            .from('document_chunks')
            .select('id, content, document_id, documents!inner(filename, category)')
            .eq('documents.organization_id', orgId)
            .eq('documents.in_knowledge_base', true);

          if (category) fallbackQuery = fallbackQuery.eq('documents.category', category);

          const { data: fallbackResults } = await fallbackQuery.limit(20);

          const queryLower = query.toLowerCase();
          const filtered = (fallbackResults || [])
            .filter(
              (item: any) =>
                item.content?.toLowerCase().includes(queryLower) ||
                (item.documents as any)?.filename?.toLowerCase().includes(queryLower)
            )
            .slice(0, 5)
            .map((item: any) => ({
              title: (item.documents as any)?.filename,
              category: (item.documents as any)?.category,
              content: item.content,
              similarity: 0.5,
            }));

          return JSON.stringify({ results: filtered });
        }

        if (!results || results.length === 0) {
          return JSON.stringify({ message: 'No relevant knowledge found.', results: [] });
        }

        const formatted = results.map((r: any, i: number) => ({
          rank: i + 1,
          title: r.filename,
          category: r.category,
          tags: r.tags || [],
          content: r.content.substring(0, 1000) + (r.content.length > 1000 ? '...' : ''),
          similarity: Math.round(r.similarity * 100) + '%',
        }));

        log.info({ count: formatted.length }, 'Found results');
        const resultJson = JSON.stringify({ results: formatted });

        // Cache successful results (FIFO eviction at max size)
        if (kbResultCache.size >= KB_CACHE_MAX) {
          const oldestKey = kbResultCache.keys().next().value;
          if (oldestKey !== undefined) kbResultCache.delete(oldestKey);
        }
        kbResultCache.set(cacheKey, {
          expiresAt: Date.now() + KB_CACHE_TTL_MS,
          value: resultJson,
        });

        return resultJson;
      } catch (err: any) {
        log.error({ err }, 'Error searching knowledge base');
        return JSON.stringify({ error: err.message, results: [] });
      }
    },
  });
}
