/**
 * Exa Research Tool — web, people, and company research via Exa API.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { config } from '../config.js';
import { ToolAuthorizationError, withToolErrorHandling } from '../lib/tool-errors.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'exa_research' });

/**
 * Strip Slack formatting from text before passing to Exa.
 * Slack wraps URLs as <https://url|label> which confuses search APIs.
 */
export function stripSlackFormatting(text: string): string {
  return text
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/gi, '$2') // <url|label> → label
    .replace(/<(https?:\/\/[^>]+)>/gi, '$1')            // <url> → url
    .replace(/<@[A-Z0-9]+>/gi, '')                       // <@U123> → remove
    .replace(/<mailto:([^|>]+)\|[^>]*>/gi, '$1')         // mailto → plain email
    .replace(/\s+/g, ' ')
    .trim();
}

export function createExaResearchTool() {
  return new DynamicStructuredTool({
    name: 'exa_research',
    description:
      'Research people, companies, or topics on the web using Exa. Use for researching prospects, competitors, market trends, or looking up someone\'s background. For people searches, it can find LinkedIn profiles and bios. For company searches, it finds company info and news.',
    schema: z.object({
      query: z.string().describe('What to research (e.g. "CTO of Stripe" or "Ramp series C funding")'),
      type: z
        .enum(['web', 'person', 'company'])
        .optional()
        .default('web')
        .describe('Type of search: web (general), person (LinkedIn/bio), or company (company info)'),
    }),
    func: withToolErrorHandling('exa_research', async ({ query: rawQuery, type }) => {
      const query = stripSlackFormatting(rawQuery);
      log.info({ query, type }, 'Researching via Exa');

      if (!config.exaApiKey) {
        throw new ToolAuthorizationError('exa_research', 'Exa API key not configured.');
      }

      const { default: Exa } = await import('exa-js');
      const exa = new Exa(config.exaApiKey);

      let results;

      if (type === 'person') {
        results = await exa.searchAndContents(query, {
          type: 'neural',
          numResults: 5,
          text: true,
          includeDomains: ['linkedin.com'],
        });
      } else if (type === 'company') {
        // Company category doesn't support date filters — use semantic search only
        results = await exa.searchAndContents(query, {
          type: 'neural',
          numResults: 5,
          text: true,
          category: 'company',
        });
      } else {
        results = await exa.searchAndContents(query, {
          type: 'neural',
          numResults: 5,
          text: true,
        });
      }

      const formatted = (results.results || []).map((r: any) => ({
        title: r.title,
        url: r.url,
        text: r.text?.substring(0, 500),
        publishedDate: r.publishedDate,
      }));

      log.info({ count: formatted.length }, 'Found results');
      return JSON.stringify({ results: formatted });
    }),
  });
}
