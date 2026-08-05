/**
 * List Salesforce Rules Tool — returns all saved business rules
 * without requiring a search query. Uses memoryService.list() with
 * skill_namespace='salesforce_rules'.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getMemoryService } from '../services/memory/index.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'list_salesforce_rules' });

export function createListSalesforceRulesTool(userId: string, organizationId: string | null) {
  return new DynamicStructuredTool({
    name: 'list_salesforce_rules',
    description:
      'List all saved Salesforce business rules. Call when the user asks to see, review, or audit their rules (e.g., "show me my rules", "what rules do I have", "list my automations").',
    schema: z.object({
      limit: z.number().optional().describe('Max rules to return (default 50)'),
    }),
    func: async ({ limit = 50 }) => {
      log.info({ limit }, 'Listing all salesforce rules');

      try {
        const memoryService = getMemoryService();
        const scope = { userId, organizationId, skillNamespace: 'salesforce_rules' };

        const result = await memoryService.list(scope, limit);

        if (!result.results || result.results.length === 0) {
          return JSON.stringify({
            _meta: { tool: 'list_salesforce_rules' },
            message: 'No saved business rules found.',
            rules: [],
            count: 0,
          });
        }

        log.info({ count: result.results.length }, 'Listed rules');
        return JSON.stringify({
          _meta: { tool: 'list_salesforce_rules' },
          rules: result.results.map(r => ({
            rule: r.content,
            savedAt: r.createdAt,
          })),
          count: result.results.length,
        });
      } catch (err: any) {
        log.error({ err }, 'Error listing salesforce rules');
        return JSON.stringify({
          _meta: { tool: 'list_salesforce_rules' },
          error: err.message,
          rules: [],
          count: 0,
        });
      }
    },
  });
}
