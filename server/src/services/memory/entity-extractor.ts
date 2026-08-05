/**
 * Lightweight regex-based entity extraction for memory metadata.
 *
 * Extracts people, companies, amounts, and emails from text.
 * No LLM calls — fast enough to run on every memory save.
 */

export interface ExtractedEntities {
  people: string[];
  companies: string[];
  amounts: string[];
  emails: string[];
}

// Common titles to strip from person name matches
const TITLE_PREFIX = /^(?:Mr|Mrs|Ms|Dr|Prof)\.?\s*/i;

/** Extract capitalized multi-word names (2+ words starting with uppercase). */
function extractPeople(text: string): string[] {
  // Match sequences of 2-3 capitalized words not at start of sentence
  const matches = text.match(/(?<=[.!?\s,;:(]|^)\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/g);
  if (!matches) return [];

  const seen = new Set<string>();
  return matches
    .map((m) => m.trim().replace(TITLE_PREFIX, ''))
    .filter((name) => {
      // Skip common false positives
      if (/^(?:The|This|That|These|Those|When|What|Where|How|Here|There|Just|Also|Please|Thank|Thanks|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December)/.test(name)) {
        return false;
      }
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Extract company-like patterns: Inc, Corp, LLC, or known suffixes. */
function extractCompanies(text: string): string[] {
  const patterns = [
    // Explicit suffixes
    /([A-Z][A-Za-z&\s]+(?:Inc|Corp|LLC|Ltd|Co|Group|Labs|AI|HQ)\.?)\b/g,
    // CamelCase single words (likely product/company names)
    /\b([A-Z][a-z]+[A-Z][A-Za-z]+)\b/g,
  ];

  const seen = new Set<string>();
  const results: string[] = [];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1].trim();
      const key = name.toLowerCase();
      if (!seen.has(key) && name.length > 2) {
        seen.add(key);
        results.push(name);
      }
    }
  }

  return results;
}

/** Extract monetary amounts and percentages. */
function extractAmounts(text: string): string[] {
  const patterns = [
    /\$[\d,]+(?:\.\d{1,2})?[KkMmBb]?\b/g,        // $500, $1.5M, $10,000
    /\b\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?\b/g,       // 1,000,000
    /\b\d+(?:\.\d+)?%/g,                            // 50%, 3.5%
    /\b\d+(?:\.\d+)?[KkMmBb]\b/g,                   // 500K, 1.5M
  ];

  const seen = new Set<string>();
  const results: string[] = [];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const amount = match[0];
      if (!seen.has(amount)) {
        seen.add(amount);
        results.push(amount);
      }
    }
  }

  return results;
}

/** Extract email addresses. */
function extractEmails(text: string): string[] {
  const matches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
  return matches ? [...new Set(matches)] : [];
}

/**
 * Extract key entities from text for memory metadata enrichment.
 * Fast, regex-based — no LLM calls.
 */
export function extractEntities(text: string): ExtractedEntities {
  return {
    people: extractPeople(text),
    companies: extractCompanies(text),
    amounts: extractAmounts(text),
    emails: extractEmails(text),
  };
}
