/**
 * Delete User Fact Tool — lets agents forget/remove previously saved facts.
 *
 * When a user says "forget that...", "delete...", "that's wrong...",
 * the agent calls this tool to remove matching facts from both
 * user_preferences and user_memories.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'delete_user_fact' });

export function createDeleteUserFactTool(userId: string, organizationId: string | null) {
  return new DynamicStructuredTool({
    name: 'delete_user_fact',
    description:
      'Delete/forget a previously saved fact about the user. Use when the user says "forget that...", "delete...", "remove...", "that\'s wrong", or wants to correct something you saved. Searches for matching facts by keyword and deletes them. Do NOT use save_user_fact to "unsave" something — use this tool instead.',
    schema: z.object({
      query: z.string().describe('Keywords to match against saved facts (e.g., "quota-carrying seller", "AI engineer", "healthcare")'),
    }),
    func: async ({ query }) => {
      log.info({ query, userId }, 'Searching for facts to delete');

      try {
        // 1. Find matching facts in user_preferences
        const { data: allFacts } = await supabase
          .from('user_preferences')
          .select('id, preference_key, preference_value')
          .eq('user_id', userId)
          .like('preference_key', 'user_fact_%');

        const queryLower = query.toLowerCase();
        const matchingFacts = (allFacts || []).filter((row: any) => {
          const val = row.preference_value?.value;
          return val && val.toLowerCase().includes(queryLower);
        });

        if (matchingFacts.length === 0) {
          log.info({ query }, 'No matching facts found');
          return JSON.stringify({
            deleted: false,
            message: `I don't have any saved facts matching "${query}".`,
          });
        }

        // 2. Delete from user_preferences
        const idsToDelete = matchingFacts.map((r: any) => r.id);
        const { error: prefError } = await supabase
          .from('user_preferences')
          .delete()
          .in('id', idsToDelete);

        if (prefError) {
          log.error({ err: prefError }, 'Preference delete error');
          return JSON.stringify({ error: `Failed to delete: ${prefError.message}` });
        }

        // 3. Delete matching fact memories from user_memories
        const deletedContents = matchingFacts.map((r: any) => r.preference_value?.value).filter(Boolean);
        for (const content of deletedContents) {
          const { error: memError } = await supabase
            .from('user_memories')
            .delete()
            .eq('user_id', userId)
            .eq('category', 'fact')
            .ilike('content', `%${content}%`);

          if (memError) {
            log.warn({ err: memError }, 'Memory cleanup warning');
          }
        }

        const deletedList = matchingFacts
          .map((r: any) => r.preference_value?.value)
          .filter(Boolean)
          .join('", "');

        log.info({ count: matchingFacts.length, deletedList }, 'Deleted facts');

        return JSON.stringify({
          deleted: true,
          count: matchingFacts.length,
          message: `Deleted ${matchingFacts.length} fact(s): "${deletedList}"`,
        });
      } catch (err: any) {
        log.error({ err }, 'Error deleting user fact');
        return JSON.stringify({ error: err.message });
      }
    },
  });
}
