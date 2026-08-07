/**
 * Save Salesforce Rule Tool — stores user-scoped business rules for the
 * Salesforce agent to recall and apply when creating/updating records.
 *
 * Rules are stored in user_memories with skill_namespace='salesforce_rules'
 * for isolation from general memory. Deduplicates via vector similarity.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getMemoryService } from '../services/memory/index.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'save_salesforce_rule' });

export function createSaveSalesforceRuleTool(userId: string, organizationId: string | null) {
  return new DynamicStructuredTool({
    name: 'save_salesforce_rule',
    description:
      'Save a Salesforce business rule that the user explicitly teaches you. ONLY use when the user states a recurring rule, formula, or default — signals include: "remember that...", "our formula is...", "always set X to...", "the rule is...", "from now on...", "X is always...". Do NOT use for general conversation, one-time instructions, questions, or data lookups.',
    schema: z.object({
      rule: z.string().describe('The business rule, stated clearly (e.g., "Close date is always the last day of the following month", "Pricing formula is [35 * (# of EE) + 89] * 12")'),
      appliesToObject: z.enum(['Opportunity', 'Account', 'Contact', 'Task', 'Any']).optional()
        .describe('Which Salesforce object this rule applies to (if specific)'),
      appliesToField: z.string().optional()
        .describe('Which field this rule affects (e.g., "CloseDate", "Amount", "StageName")'),
    }),
    func: async ({ rule, appliesToObject, appliesToField }) => {
      log.info({ rule, appliesToObject: appliesToObject || 'Any', appliesToField: appliesToField || 'any' }, 'Saving salesforce rule');

      try {
        const memoryService = getMemoryService();
        const scope = { userId, organizationId, skillNamespace: 'salesforce_rules' };

        // Prefix rule with object/field context for better recall
        const content = appliesToObject && appliesToObject !== 'Any'
          ? `[${appliesToObject}${appliesToField ? '.' + appliesToField : ''}] ${rule}`
          : rule;

        // Dedup: check if a very similar rule already exists
        const existing = await memoryService.search(scope, rule, 1);
        if (existing.results[0]?.score && existing.results[0].score > 0.92) {
          log.info({ score: existing.results[0].score, existingContent: existing.results[0].content }, 'Similar rule exists');
          return JSON.stringify({
            _meta: { tool: 'save_salesforce_rule' },
            message: `A similar rule already exists: "${existing.results[0].content}". No duplicate created.`,
            existingRule: existing.results[0].content,
          });
        }

        await memoryService.save(
          scope,
          [{ role: 'user', content }],
          { category: 'preference' },
        );

        log.info({ content }, 'Saved rule');
        return JSON.stringify({
          _meta: { tool: 'save_salesforce_rule' },
          message: `Saved business rule: "${rule}"`,
          appliesToObject: appliesToObject || 'Any',
          appliesToField: appliesToField || null,
        });
      } catch (err: any) {
        log.error({ err }, 'Error saving salesforce rule');
        return JSON.stringify({
          _meta: { tool: 'save_salesforce_rule' },
          error: err.message,
        });
      }
    },
  });
}
