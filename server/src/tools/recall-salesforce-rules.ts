/**
 * Recall Salesforce Rules Tool — searches for saved business rules
 * that apply to the operation the agent is about to perform.
 *
 * Queries user_memories with skill_namespace='salesforce_rules'
 * using hybrid vector + full-text search.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getMemoryService } from '../services/memory/index.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'recall_salesforce_rules' });

export function createRecallSalesforceRulesTool(userId: string, organizationId: string | null) {
  return new DynamicStructuredTool({
    name: 'recall_salesforce_rules',
    description:
      'Search for saved Salesforce business rules. Call this BEFORE creating or updating any Salesforce record to check for rules that affect the fields you are about to set. Also call when the user asks about their existing rules or automations.',
    schema: z.object({
      query: z.string().describe('Describe what you are about to do or what rules to find (e.g., "setting close date on opportunity", "pricing formula for employees", "opportunity defaults")'),
    }),
    func: async ({ query }) => {
      log.info({ query }, 'Recalling salesforce rules');

      try {
        const memoryService = getMemoryService();
        const scope = { userId, organizationId, skillNamespace: 'salesforce_rules' };

        const result = await memoryService.search(scope, query, 10);

        if (!result.results || result.results.length === 0) {
          return JSON.stringify({
            _meta: { tool: 'recall_salesforce_rules' },
            message: 'No saved business rules found.',
            rules: [],
            count: 0,
          });
        }

        log.info({ count: result.results.length }, 'Found rules');
        return JSON.stringify({
          _meta: { tool: 'recall_salesforce_rules' },
          rules: result.results.map(r => ({
            rule: r.content,
            score: r.score,
            savedAt: r.createdAt,
          })),
          count: result.results.length,
        });
      } catch (err: any) {
        log.error({ err }, 'Error recalling salesforce rules');
        return JSON.stringify({
          _meta: { tool: 'recall_salesforce_rules' },
          error: err.message,
          rules: [],
          count: 0,
        });
      }
    },
  });
}
