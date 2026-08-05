/**
 * Gmail Search Tool — search and read email messages.
 * Ported from search-gmail/index.ts.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getGoogleTokens, googleApiFetchWithRetry } from '../services/token-manager.js';
import { ToolAuthorizationError, ToolAPIError, withToolErrorHandling } from '../lib/tool-errors.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'gmail_search' });

// Domains and keywords to exclude when filtering for sales-only emails
const INVESTOR_DOMAINS = [
  'nea.com', 'bvp.com', 'sequoiacap.com', 'a16z.com', 'greylock.com',
  'bessemer.com', 'khoslaventures.com', 'indexventures.com', 'benchmark.com',
  'accel.com', 'generalcatalyst.com', 'lsvp.com', 'insightpartners.com',
  'tigerglobal.com', 'coatue.com', 'ycombinator.com', 'firstround.com',
  'foundersfund.com', 'usv.com', 'kpcb.com', 'matrixpartners.com',
  'sparkcp.com', 'felicis.com', 'redpoint.com', 'bain.com',
];

function buildSalesExclusions(): string {
  const domainExclusions = INVESTOR_DOMAINS.map((d) => `-from:${d}`).join(' ');
  const subjectExclusions = [
    '-subject:investment', '-subject:fundraise', '-subject:fundraising',
    '-subject:"term sheet"', '-subject:"cap table"', '-subject:"due diligence"',
    '-subject:hiring', '-subject:"job application"', '-subject:recruiting',
    '-subject:candidate', '-subject:resume', '-subject:"open role"',
    '-subject:newsletter', '-subject:unsubscribe',
  ].join(' ');
  return `${domainExclusions} ${subjectExclusions}`;
}

export function createGmailSearchTool(userId: string) {
  return new DynamicStructuredTool({
    name: 'gmail_search',
    description:
      'Search the user\'s Gmail for emails matching a query. Use this when asked about emails, correspondence, or communication history with a person or company. You can search by email address, name, subject, or keywords. Set salesOnly=true when searching for deal/pipeline/prospect activity to automatically exclude investor, hiring, and newsletter emails.',
    schema: z.object({
      query: z.string().describe('Gmail search query (e.g. "from:jane@ramp.com" or "subject:proposal" or "ramp")'),
      maxResults: z.number().optional().default(5).describe('Maximum number of results (default 5)'),
      salesOnly: z.boolean().optional().default(false).describe('When true, exclude investor/VC, hiring, and newsletter emails from results. Use this for deal-related and pipeline queries.'),
    }),
    func: withToolErrorHandling('gmail_search', async ({ query, maxResults, salesOnly }) => {
      const effectiveQuery = salesOnly ? `${query} ${buildSalesExclusions()}` : query;
      log.info({ query: effectiveQuery, maxResults, salesOnly }, 'Searching Gmail');

      const tokens = await getGoogleTokens(userId);
      if (!tokens) {
        throw new ToolAuthorizationError('gmail_search', 'Gmail not connected. User has not linked their Google account.');
      }

      // Search messages
      const searchUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(effectiveQuery)}&maxResults=${maxResults}`;
      const searchRes = await googleApiFetchWithRetry(userId, searchUrl, {}, tokens);

      if (!searchRes.ok) {
        const body = await searchRes.text().catch(() => '');
        log.error({ status: searchRes.status, googleError: body.slice(0, 500) }, 'Gmail search failed');
        throw new ToolAPIError('gmail_search', `Gmail search failed: ${searchRes.status}`, searchRes.status);
      }

      const searchData = await searchRes.json();
      if (!searchData.messages || searchData.messages.length === 0) {
        return JSON.stringify({ message: 'No emails found matching this query.', results: [] });
      }

      // Fetch metadata for each message
      const threads: any[] = [];
      for (const msg of searchData.messages) {
        try {
          const msgRes = await googleApiFetchWithRetry(
            userId,
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
            {},
            tokens,
          );
          if (!msgRes.ok) continue;

          const msgData = await msgRes.json();
          const headers = msgData.payload?.headers || [];
          const getHeader = (name: string) =>
            headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

          threads.push({
            messageId: msg.id,
            subject: getHeader('Subject') || '(No Subject)',
            from: getHeader('From'),
            date: getHeader('Date'),
            snippet: msgData.snippet,
            threadId: msgData.threadId,
          });
        } catch {
          // Skip individual message errors
        }
      }

      log.info({ count: threads.length }, 'Found email threads');
      return JSON.stringify({ results: threads, count: threads.length });
    }),
  });
}
