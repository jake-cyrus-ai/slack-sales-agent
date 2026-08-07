/**
 * Self-hosted memory provider — pgvector + FTS hybrid search in Supabase.
 *
 * Uses hybrid_search_user_memories() RPC combining vector cosine similarity
 * with PostgreSQL full-text search for keyword matching.
 *
 * SCALE: HNSW index handles ~2M rows with <50ms queries.
 * DEDUP: Skips save if a memory with > 0.92 similarity already exists.
 * CAP: Max 500 memories per user (conversations pruned first, facts preserved).
 */

import { supabase } from '../../lib/supabase.js';
import { generateEmbedding } from '../embeddings.js';
import { extractEntities } from './entity-extractor.js';
import type {
  IMemoryService,
  MemoryScope,
  MemorySearchResult,
  MemorySearchOptions,
  MemorySaveOptions,
  MemoryEntry,
} from './types.js';
import { logger } from '../../../lib/logger.js';

const log = logger.child({ component: 'memory-provider' });

const MAX_MEMORIES_PER_USER = 500;
const DEDUP_THRESHOLD = 0.92;

export class SupabaseMemoryProvider implements IMemoryService {

  async search(
    scope: MemoryScope,
    query: string,
    limit = 5,
    options?: MemorySearchOptions,
  ): Promise<MemorySearchResult> {
    try {
      const embedding = await generateEmbedding(query);

      // Primary search: user's own namespace
      const primary = await this.hybridSearch(embedding, query, scope, limit, options?.category);

      // Secondary: org-shared namespace (if requested and org exists)
      if (options?.includeOrgShared && scope.organizationId) {
        const orgScope: MemoryScope = {
          userId: scope.userId,
          organizationId: scope.organizationId,
          skillNamespace: 'org_shared',
        };
        const orgResults = await this.hybridSearch(embedding, query, orgScope, limit);
        return this.mergeResults(primary, orgResults, limit);
      }

      return primary;
    } catch (err: any) {
      log.error({ err }, 'Search error');
      return { results: [], error: err.message };
    }
  }

  async save(
    scope: MemoryScope,
    messages: { role: string; content: string }[],
    options?: MemorySaveOptions,
  ): Promise<void> {
    const content = messages
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');

    if (!content.trim()) return;

    try {
      // Enrich metadata with extracted entities
      const entities = extractEntities(content);
      const entityList = [...entities.people, ...entities.companies, ...entities.amounts, ...entities.emails];
      const enrichedMetadata = {
        ...options?.metadata,
        ...(entityList.length > 0 && { entities: entityList }),
      };

      // Determine if this should be org-shared
      const effectiveNamespace = scope.skillNamespace || 'general';
      const effectiveCategory = options?.category || 'historical_artifact';

      const embedding = await generateEmbedding(content);

      const { data: inserted, error } = await supabase.rpc('save_memory_if_unique', {
        p_user_id: scope.userId,
        p_organization_id: scope.organizationId || null,
        p_skill_namespace: effectiveNamespace,
        p_content: content,
        p_embedding: embedding,
        p_dedup_threshold: DEDUP_THRESHOLD,
        p_metadata: enrichedMetadata,
        p_category: effectiveCategory,
      });

      if (error) {
        log.error({ err: error }, 'Save error');
        return;
      }

      if (!inserted) {
        log.info('Skipping duplicate memory (similarity > 0.92)');
        return;
      }

      // Enforce per-user memory cap — prune oldest conversations first
      this.pruneIfNeeded(scope).catch((err) =>
        log.error({ err }, 'Prune error'),
      );
    } catch (err: any) {
      log.error({ err }, 'Save error');
    }
  }

  async list(scope: MemoryScope, limit = 100): Promise<MemorySearchResult> {
    try {
      let query = supabase
        .from('user_memories')
        .select('id, content, metadata, category, created_at')
        .eq('user_id', scope.userId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (scope.organizationId) {
        query = query.eq('organization_id', scope.organizationId);
      } else {
        query = query.is('organization_id', null);
      }
      if (scope.skillNamespace) {
        query = query.eq('skill_namespace', scope.skillNamespace);
      }

      const { data, error } = await query;

      if (error) {
        log.error({ err: error }, 'List error');
        return { results: [], error: error.message };
      }

      return {
        results: (data || []).map((r: any) => ({
          content: r.content,
          createdAt: r.created_at,
          metadata: r.metadata,
          category: r.category,
        })),
      };
    } catch (err: any) {
      log.error({ err }, 'List error');
      return { results: [], error: err.message };
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private async hybridSearch(
    embedding: number[],
    queryText: string,
    scope: MemoryScope,
    limit: number,
    category?: string,
  ): Promise<MemorySearchResult> {
    const { data, error } = await supabase.rpc('hybrid_search_user_memories', {
      query_embedding: embedding,
      query_text: queryText,
      p_user_id: scope.userId,
      p_organization_id: scope.organizationId || null,
      p_skill_namespace: scope.skillNamespace || null,
      p_category: category || null,
      match_threshold: 0.15,
      match_count: limit,
      alpha: 0.7,
    });

    if (error) {
      log.error({ err: error, details: error.details, hint: error.hint }, 'Hybrid search FAILED, falling back to vector-only');
      // A category-filtered query must fail closed. The legacy vector RPC has
      // no category parameter and could leak historical artifacts back into
      // proactive context if the hybrid RPC is unavailable.
      if (category) return { results: [], error: error.message };
      return this.vectorOnlySearch(embedding, scope, limit);
    }

    return {
      results: (data || []).map((r: any) => ({
        content: r.content,
        score: r.similarity,
        createdAt: r.created_at,
        metadata: r.metadata,
        category: r.category,
      })),
    };
  }

  /** Fallback: original vector-only search via search_user_memories RPC. */
  private async vectorOnlySearch(
    embedding: number[],
    scope: MemoryScope,
    limit: number,
  ): Promise<MemorySearchResult> {
    const { data, error } = await supabase.rpc('search_user_memories', {
      query_embedding: embedding,
      p_user_id: scope.userId,
      p_organization_id: scope.organizationId || null,
      p_skill_namespace: scope.skillNamespace || null,
      match_threshold: 0.15,
      match_count: limit,
    });

    if (error) {
      log.error({ err: error }, 'Vector-only fallback also FAILED');
      return { results: [], error: error.message };
    }

    return {
      results: (data || []).map((r: any) => ({
        content: r.content,
        score: r.similarity,
        createdAt: r.created_at,
      })),
    };
  }

  /** Merge two result sets by score, deduplicate by content, cap at limit. */
  private mergeResults(
    primary: MemorySearchResult,
    secondary: MemorySearchResult,
    limit: number,
  ): MemorySearchResult {
    const seen = new Set<string>();
    const merged: MemoryEntry[] = [];

    // Interleave both result sets
    const all = [...primary.results, ...secondary.results]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    for (const entry of all) {
      // Deduplicate by first 100 chars of content
      const key = entry.content.slice(0, 100).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
      if (merged.length >= limit) break;
    }

    return { results: merged };
  }

  /** Prune oldest memories if user exceeds the cap.
   *  Conversations are pruned first, facts/preferences preserved longer. */
  private async pruneIfNeeded(scope: MemoryScope): Promise<void> {
    let countQuery = supabase
      .from('user_memories')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', scope.userId);

    if (scope.organizationId) {
      countQuery = countQuery.eq('organization_id', scope.organizationId);
    } else {
      countQuery = countQuery.is('organization_id', null);
    }
    if (scope.skillNamespace) {
      countQuery = countQuery.eq('skill_namespace', scope.skillNamespace);
    }

    const { count } = await countQuery;

    if (!count || count <= MAX_MEMORIES_PER_USER) return;

    const excess = count - MAX_MEMORIES_PER_USER;

    // Prune conversation memories first (category NULL or 'conversation'),
    // then other categories, oldest first within each group.
    let oldestQuery = supabase
      .from('user_memories')
      .select('id')
      .eq('user_id', scope.userId)
      .order('category', { ascending: true, nullsFirst: true })
      .order('created_at', { ascending: true })
      .limit(excess);

    if (scope.organizationId) {
      oldestQuery = oldestQuery.eq('organization_id', scope.organizationId);
    } else {
      oldestQuery = oldestQuery.is('organization_id', null);
    }
    if (scope.skillNamespace) {
      oldestQuery = oldestQuery.eq('skill_namespace', scope.skillNamespace);
    }

    const { data: oldest } = await oldestQuery;

    if (oldest?.length) {
      await supabase
        .from('user_memories')
        .delete()
        .in('id', oldest.map((r: any) => r.id));
      log.info({ count: oldest.length, userId: scope.userId }, `Pruned ${oldest.length} old memories`);
    }
  }
}
