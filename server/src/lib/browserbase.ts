/**
 * Lightweight public web-page extraction for research skills.
 *
 * Shared utility used by both the LangChain web_browse tool and
 * the Vercel Workflow org-context research flow.
 */

import { logger } from '../../lib/logger.js';

const log = logger.child({ util: 'web-extract' });

/** Maximum characters to return from a page extraction. */
const MAX_TEXT_LENGTH = 8_000;

export interface BrowseResult {
  url: string;
  title: string;
  text: string;
  error?: string;
}

/**
 * Fetch a public URL and extract visible page text.
 *
 * Fetches a public page and extracts readable text. This intentionally avoids
 * shipping a browser binary in the serverless workflow bundle. Operators can
 * replace this adapter with a managed browser service if JavaScript rendering
 * is required.
 */
export async function browseAndExtract(url: string): Promise<BrowseResult> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'SlackSalesAgent/1.0 (+https://github.com/jake-cyrus-ai/slack-sales-agent)' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      ?.replace(/\s+/g, ' ')
      .trim() ?? '';
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();

    log.info({ url, titleLen: title.length, textLen: text.length }, 'Page extracted');

    return {
      url,
      title,
      text: text.trim().substring(0, MAX_TEXT_LENGTH),
    };
  } catch (err: any) {
    log.error({ err, url }, 'Web extraction failed');
    return { url, title: '', text: '', error: err.message };
  }
}

/**
 * Browse multiple URLs in parallel (up to concurrency limit).
 * Useful for org-context research where we visit several competitor pages.
 */
export async function browseMultiple(
  urls: string[],
  concurrency = 3,
): Promise<BrowseResult[]> {
  const results: BrowseResult[] = [];

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(browseAndExtract));

    for (let j = 0; j < batchResults.length; j++) {
      const r = batchResults[j];
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        results.push({ url: batch[j], title: '', text: '', error: r.reason?.message });
      }
    }
  }

  return results;
}
