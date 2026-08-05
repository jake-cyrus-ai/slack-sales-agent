/**
 * Delete Salesforce Rule Tool — removes a saved business rule by keyword match.
 *
 * Searches user_memories with skill_namespace='salesforce_rules' for rules
 * matching the query, then deletes the best match.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getMemoryService } from '../services/memory/index.js';
import { supabase } from '../lib/supabase.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'delete_salesforce_rule' });

export function createDeleteSalesforceRuleTool(userId: string, organizationId: string | null) {
  return new DynamicStructuredTool({
    name: 'delete_salesforce_rule',
    description:
      'Delete/forget a saved Salesforce business rule. Use when the user says "forget the...", "remove the...", "delete the rule about...", or wants to stop a rule from being applied.',
    schema: z.object({
      query: z.string().describe('Keyword or phrase identifying the rule to delete (e.g., "pricing formula", "close date rule", "stage default")'),
    }),
    func: async ({ query }) => {
      log.info({ query }, 'Deleting salesforce rule');

      try {
        // First, find the matching rule via memory search
        const memoryService = getMemoryService();
        const scope = { userId, organizationId, skillNamespace: 'salesforce_rules' };
        const searchResult = await memoryService.search(scope, query, 3);

        if (!searchResult.results || searchResult.results.length === 0) {
          return JSON.stringify({
            _meta: { tool: 'delete_salesforce_rule' },
            message: `No saved rules found matching "${query}".`,
          });
        }

        // Take the top match and delete it from user_memories directly
        const topMatch = searchResult.results[0];
        const contentToDelete = topMatch.content;

        // Delete from user_memories where content matches and namespace is salesforce_rules.
        // Use { count: 'exact' } so we can verify rows were actually removed — supabase-js
        // returns count: null otherwise, which would mask content drift (e.g., whitespace
        // or unicode mismatch between the search result and the stored value).
        let deleteQuery = supabase
          .from('user_memories')
          .delete({ count: 'exact' })
          .eq('user_id', userId)
          .eq('skill_namespace', 'salesforce_rules')
          .eq('content', contentToDelete);

        if (organizationId) {
          deleteQuery = deleteQuery.eq('organization_id', organizationId);
        }

        const { error, count } = await deleteQuery;

        if (error) {
          log.error({ err: error }, 'Delete error');
          return JSON.stringify({
            _meta: { tool: 'delete_salesforce_rule' },
            error: `Failed to delete rule: ${error.message}`,
          });
        }

        if (!count || count === 0) {
          log.warn({ contentToDelete }, 'Found a match in search but delete affected 0 rows');
          return JSON.stringify({
            _meta: { tool: 'delete_salesforce_rule' },
            message: `Found a matching rule in search but could not delete it — the stored content may have drifted. No rules removed.`,
          });
        }

        log.info({ count, contentToDelete }, 'Deleted rule(s)');
        return JSON.stringify({
          _meta: { tool: 'delete_salesforce_rule' },
          message: `Deleted rule: "${contentToDelete.replace(/^\w+:\s*/, '')}"`,
          deletedRule: contentToDelete.replace(/^\w+:\s*/, ''),
        });
      } catch (err: any) {
        log.error({ err }, 'Error deleting salesforce rule');
        return JSON.stringify({
          _meta: { tool: 'delete_salesforce_rule' },
          error: err.message,
        });
      }
    },
  });
}
