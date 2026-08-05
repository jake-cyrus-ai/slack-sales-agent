/**
 * Web Browse Tool — visit a public URL and extract page content.
 *
 * Use when you need live, real-time data from a specific webpage that
 * Exa may not have indexed (pricing pages, job boards, recent blog posts).
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { withToolErrorHandling } from '../lib/tool-errors.js';
import { browseAndExtract } from '../lib/browserbase.js';

export function createWebBrowseTool() {
  return new DynamicStructuredTool({
    name: 'web_browse',
    description:
      'Visit a specific URL and extract the page content. Use this when you have a known URL ' +
      '(e.g. a prospect\'s website, careers page, pricing page, or blog) and need to read its ' +
      'current content. Slower than exa_research — only use when you need live data from a ' +
      'specific page, not for general search. Do NOT use for LinkedIn or sites requiring login.',
    schema: z.object({
      url: z
        .string()
        .url()
        .describe('The full URL to visit (e.g. "https://acme.com/pricing")'),
    }),
    func: withToolErrorHandling('web_browse', async ({ url }) => {
      const result = await browseAndExtract(url);

      if (result.error) {
        return JSON.stringify({
          error: result.error,
          results: [],
        });
      }

      return JSON.stringify({
        results: [
          {
            url: result.url,
            title: result.title,
            text: result.text,
          },
        ],
      });
    }),
  });
}
