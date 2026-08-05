/**
 * Memory service interface — provider-agnostic long-term memory.
 *
 * Skills declare memory needs in their manifest. The supervisor injects
 * a properly-scoped memory service via SkillContext.
 */

export interface MemoryScope {
  userId: string;
  organizationId?: string | null;
  /** Optional skill-level namespace for memory isolation */
  skillNamespace?: string;
}

export interface MemoryMetadata {
  source?: 'slack' | 'web' | 'api';
  category?: 'conversation' | 'fact' | 'preference' | 'org_shared';
  channelId?: string;
  threadTs?: string;
  conversationId?: string;
  entities?: string[];
  [key: string]: unknown;
}

export interface MemorySaveOptions {
  metadata?: MemoryMetadata;
  category?: string;
}

export interface MemorySearchOptions {
  category?: string;
  /** Also search the org_shared namespace for team-wide memories. */
  includeOrgShared?: boolean;
}

export interface MemoryEntry {
  content: string;
  score?: number;
  createdAt?: string;
  metadata?: MemoryMetadata;
  category?: string;
}

export interface MemorySearchResult {
  results: MemoryEntry[];
  error?: string;
}

export interface IMemoryService {
  /** Search long-term memory within the given scope. */
  search(scope: MemoryScope, query: string, limit?: number, options?: MemorySearchOptions): Promise<MemorySearchResult>;
  /** Save a conversation turn to long-term memory. */
  save(scope: MemoryScope, messages: { role: string; content: string }[], options?: MemorySaveOptions): Promise<void>;
  /** List all memories for a user within the given scope (admin use). */
  list(scope: MemoryScope, limit?: number): Promise<MemorySearchResult>;
}
