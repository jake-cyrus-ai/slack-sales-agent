import { config } from '../config.js';

// ─── Embedding cache (30-min TTL, max 500 entries, ~3MB) ────────────────────

const EMBEDDING_CACHE_TTL_MS = 30 * 60 * 1000;
const EMBEDDING_CACHE_MAX = 500;

type EmbeddingCacheEntry = {
  expiresAt: number;
  value: number[];
};

const embeddingCache = new Map<string, EmbeddingCacheEntry>();

function normalizeKey(text: string): string {
  return text.toLowerCase().trim();
}

/** @internal Exposed for tests only. */
export function __resetEmbeddingCacheForTests(): void {
  embeddingCache.clear();
}

/**
 * Generate an embedding vector using OpenAI text-embedding-3-small (1536 dimensions).
 * Results are cached for 30 minutes (embeddings are deterministic for the same model+input).
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const cacheKey = normalizeKey(text);
  const now = Date.now();

  const cached = embeddingCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    // Move to end of Map for LRU eviction (most recently used = last)
    embeddingCache.delete(cacheKey);
    embeddingCache.set(cacheKey, cached);
    return cached.value;
  }

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Embedding generation failed: ${err}`);
  }

  const data = await response.json();
  const embedding: number[] = data.data[0].embedding;

  // Evict oldest entries if cache is full
  if (embeddingCache.size >= EMBEDDING_CACHE_MAX) {
    const oldestKey = embeddingCache.keys().next().value;
    if (oldestKey !== undefined) embeddingCache.delete(oldestKey);
  }

  embeddingCache.set(cacheKey, {
    expiresAt: now + EMBEDDING_CACHE_TTL_MS,
    value: embedding,
  });

  return embedding;
}
