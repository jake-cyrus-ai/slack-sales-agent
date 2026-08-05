/**
 * Memory search tool — provider-agnostic long-term memory search.
 *
 * Replaces the hardcoded mem0-search.ts tool. Backed by IMemoryService
 * so the provider can be swapped without touching skill code.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { IMemoryService, MemoryScope } from '../services/memory/types.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'memory_search' });

export function createMemorySearchTool(memoryService: IMemoryService, scope: MemoryScope) {
  return new DynamicStructuredTool({
    name: 'memory_search',
    description:
      'Search long-term memory from past conversations. Use when you need context about previous discussions, preferences the user has mentioned before, or historical information. Returns memories with source and date context.',
    schema: z.object({
      query: z.string().describe('What to search for in past conversation memory'),
      category: z
        .enum(['conversation', 'fact', 'preference', 'org_shared'])
        .optional()
        .describe('Optional: filter by memory type. "fact" = explicit user facts, "org_shared" = team-wide knowledge, "conversation" = past chat turns'),
    }),
    func: async ({ query, category }) => {
      log.info({ query, category: category ?? 'all' }, 'Searching memory');
      const result = await memoryService.search(scope, query, 5, {
        category,
        includeOrgShared: true,
      });
      log.info({ count: result.results.length }, 'Found memories');
      for (const r of result.results) {
        log.debug({ score: r.score?.toFixed(3), category: r.category ?? 'none', source: r.metadata?.source ?? 'unknown', content: r.content.slice(0, 120) }, 'Memory result');
      }

      // Format with metadata context for the LLM
      const formatted = result.results.map((r) => ({
        content: r.content,
        score: r.score,
        when: r.createdAt,
        source: r.metadata?.source,
        category: r.category,
      }));
      return JSON.stringify({ results: formatted });
    },
  });
}
