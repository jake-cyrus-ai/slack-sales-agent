/**
 * Memory service factory — singleton access to the memory provider.
 *
 * Uses self-hosted pgvector in Supabase (replaces Mem0 cloud).
 * All memory data lives in our own database — no external API calls.
 */

import { SupabaseMemoryProvider } from './supabase-provider.js';
import type { IMemoryService } from './types.js';

let instance: IMemoryService | null = null;

/** Get the singleton memory service (pgvector in Supabase). */
export function getMemoryService(): IMemoryService {
  if (!instance) {
    instance = new SupabaseMemoryProvider();
  }
  return instance;
}

export type { IMemoryService, MemoryScope, MemoryEntry, MemorySearchResult, MemoryMetadata, MemorySaveOptions, MemorySearchOptions } from './types.js';
