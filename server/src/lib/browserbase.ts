/**
 * Browserbase — cloud browser sessions for live web page extraction.
 *
 * Shared utility used by both the LangChain web_browse tool and
 * the Inngest org-context research flow.
 */

import { logger } from '../../lib/logger.js';
import { config } from '../config.js';

const log = logger.child({ util: 'browserbase' });

/** Maximum characters to return from a page extraction. */
const MAX_TEXT_LENGTH = 8_000;

/** Session timeout in seconds (1 min = minimum billing unit). */
const SESSION_TIMEOUT = 60;

export interface BrowseResult {
  url: string;
  title: string;
  text: string;
  error?: string;
}

/**
 * Browse a URL using Browserbase and extract visible page text.
 *
 * Creates a remote browser session, navigates to the URL, extracts
 * innerText from the main content area, and tears down the session.
 */
export async function browseAndExtract(url: string): Promise<BrowseResult> {
  if (!config.browserbaseApiKey || !config.browserbaseProjectId) {
    return { url, title: '', text: '', error: 'Browserbase not configured' };
  }

  const { default: Browserbase } = await import('@browserbasehq/sdk');
  const { chromium } = await import('playwright-core');

  const bb = new Browserbase({ apiKey: config.browserbaseApiKey });

  const session = await bb.sessions.create({
    projectId: config.browserbaseProjectId,
    timeout: SESSION_TIMEOUT,
  });

  log.info({ url, sessionId: session.id }, 'Browserbase session created');

  const browser = await chromium.connectOverCDP(session.connectUrl);

  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0];

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Try to extract from main content area first, fall back to body
    const text: string = await page.evaluate(() => {
      const main =
        document.querySelector('main') ||
        document.querySelector('[role="main"]') ||
        document.querySelector('article');
      return (main || document.body).innerText ?? '';
    });

    const title: string = await page.title();

    log.info({ url, titleLen: title.length, textLen: text.length }, 'Page extracted');

    return {
      url,
      title,
      text: text.trim().substring(0, MAX_TEXT_LENGTH),
    };
  } catch (err: any) {
    log.error({ err, url }, 'Browserbase extraction failed');
    return { url, title: '', text: '', error: err.message };
  } finally {
    await browser.close();
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
