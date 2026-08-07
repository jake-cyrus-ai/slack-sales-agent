/**
 * Save User Fact Tool — intelligently creates, updates, or skips facts.
 *
 * When saving a fact, searches existing facts via vector similarity.
 * If a similar fact exists, uses a fast Haiku LLM call to decide
 * whether to UPDATE (refinement) or CREATE (genuinely new fact).
 *
 * Facts are stored in user_preferences with a `user_fact_` prefix key
 * and mirrored to user_memories for vector searchability.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { getMemoryService } from '../services/memory/index.js';
import { createLLM } from '../lib/llm-retry.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'save_user_fact' });

export function createSaveUserFactTool(userId: string, organizationId: string | null) {
  return new DynamicStructuredTool({
    name: 'save_user_fact',
    description:
      'Save or update a fact about the user for future conversations. If a similar fact already exists, it will be automatically updated instead of creating a duplicate. Use PROACTIVELY whenever the user shares something meaningful about themselves — their expertise, role, background, preferences, goals, industry, accounts, or working style. You do NOT need to wait for phrases like "remember that" — if the user reveals a useful fact about themselves, save it. Examples: "I know a lot about AI", "I sell to healthcare", "I used to work at Google", "I prefer short emails". IMPORTANT: Always save as a POSITIVE statement about what the user IS — never save negations like "user is NOT a seller". If the user says "I\'m not X, I\'m Y", save only "user is Y". To delete/forget a fact, use delete_user_fact instead.',
    schema: z.object({
      fact: z.string().describe('The fact to remember, stated clearly'),
      category: z
        .enum(['role', 'preference', 'account', 'context'])
        .describe(
          'Category: "role" (job title, team, responsibilities), "preference" (how they like things done), "account" (key accounts, deals, relationships), "context" (industry, territory, selling motion)',
        ),
    }),
    func: async ({ fact, category }) => {
      log.info({ fact, category, userId }, 'Saving user fact');

      try {
        const memoryService = getMemoryService();

        // 1. Search existing facts via vector similarity (across all categories)
        const searchResult = await memoryService.search(
          { userId, organizationId },
          fact,
          1, // top 1 match
          { category: 'relationship_fact' },
        );

        const topMatch = searchResult.results[0];

        // 2. Exact duplicate check
        if (topMatch && topMatch.content.replace(/^fact:\s*/i, '').toLowerCase().trim() === fact.toLowerCase().trim()) {
          log.info({ fact }, 'Exact duplicate skipped');
          return JSON.stringify({
            action: 'skipped',
            saved: false,
            message: `I already have that noted: "${fact}"`,
          });
        }

        // 3. If similar fact found, ask Haiku to decide: update or create?
        if (topMatch) {
          const existingFact = topMatch.content.replace(/^fact:\s*/i, '');
          const decision = await shouldUpdateFact(existingFact, fact);
          log.info({ existingFact, fact, decision }, 'LLM dedup decision');

          if (decision === 'update') {
            return await updateExistingFact(userId, organizationId, existingFact, fact, category);
          }
          // decision === 'create' → fall through to insert
        }

        // 4. No match or LLM said create → INSERT new fact
        return await insertNewFact(userId, organizationId, fact, category);
      } catch (err: any) {
        log.error({ err }, 'Error saving user fact');
        return JSON.stringify({ error: err.message });
      }
    },
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Fast Haiku call to decide if the new fact is a refinement of an existing fact
 * (should UPDATE) or something genuinely different (should CREATE).
 * Cost: ~$0.001, latency: <1s
 */
async function shouldUpdateFact(existingFact: string, newFact: string): Promise<'update' | 'create'> {
  try {
    const llm = createLLM({ model: 'claude-haiku-4-5-20251001', maxTokens: 10 });
    const result = await llm.invoke([
      {
        role: 'system',
        content: 'You decide if a new fact about a user is an update/refinement of an existing fact, or a genuinely different fact. Respond with ONLY the word "update" or "create". Nothing else.',
      },
      {
        role: 'user',
        content: `Existing fact: "${existingFact}"\nNew fact: "${newFact}"\n\nIs the new fact a refinement/correction of the existing fact (update), or a genuinely different piece of information (create)?`,
      },
    ]);

    const answer = (typeof result.content === 'string' ? result.content : '').toLowerCase().trim();
    return answer.includes('update') ? 'update' : 'create';
  } catch (err) {
    log.warn({ err }, 'LLM decision failed, defaulting to create');
    return 'create';
  }
}

async function updateExistingFact(
  userId: string,
  organizationId: string | null,
  existingFact: string,
  newFact: string,
  newCategory: string,
): Promise<string> {
  log.info({ existingFact, newFact }, 'Updating existing fact');

  // Find the matching row in user_preferences by content
  const { data: rows } = await supabase
    .from('user_preferences')
    .select('id, preference_key, preference_value')
    .eq('user_id', userId)
    .like('preference_key', 'user_fact_%');

  const match = rows?.find((r: any) =>
    r.preference_value?.value?.toLowerCase().trim() === existingFact.toLowerCase().trim(),
  );

  if (match) {
    // UPDATE the existing row
    const { error } = await supabase
      .from('user_preferences')
      .update({
        preference_value: { value: newFact, category: newCategory, source: 'explicit', organizationId },
        updated_at: new Date().toISOString(),
      })
      .eq('id', match.id);

    if (error) {
      log.error({ err: error }, 'Update error');
      return JSON.stringify({ error: `Failed to update: ${error.message}` });
    }
  } else {
    // Couldn't find the exact row — insert instead
    log.warn('Could not find matching preference row, inserting new');
    return insertNewFact(userId, organizationId, newFact, newCategory);
  }

  // Refresh memory mirror: delete old, insert new (fire-and-forget)
  Promise.resolve(
    supabase
      .from('user_memories')
      .delete()
      .eq('user_id', userId)
      .eq('category', 'relationship_fact')
      .ilike('content', `%${existingFact}%`),
  )
    .then(() => {
      log.info({ existingFact: existingFact.slice(0, 80) }, 'Deleted old memory mirror');
      return getMemoryService().save(
        { userId, organizationId },
        [{ role: 'fact', content: newFact }],
        { category: newCategory === 'preference' ? 'preference' : 'relationship_fact', metadata: { source: 'api', category: newCategory === 'preference' ? 'preference' : 'relationship_fact' } },
      );
    })
    .then(() => log.info({ newFact: newFact.slice(0, 80) }, 'Created new memory mirror'))
    .catch((err) => log.error({ err }, 'Memory mirror update failed'));

  return JSON.stringify({
    action: 'updated',
    saved: true,
    previous: existingFact,
    message: `Updated: "${existingFact}" → "${newFact}"`,
  });
}

async function insertNewFact(
  userId: string,
  organizationId: string | null,
  fact: string,
  category: string,
): Promise<string> {
  const { error } = await supabase
    .from('user_preferences')
    .insert({
      user_id: userId,
      preference_key: `user_fact_${category}_${Date.now()}`,
      preference_value: { value: fact, category, source: 'explicit', organizationId },
      confidence_score: 1.0,
      learned_from_conversations: false,
    });

  if (error) {
    log.error({ err: error }, 'Save error');
    return JSON.stringify({ error: `Failed to save: ${error.message}` });
  }

  // Mirror fact into user_memories for vector searchability
  log.info({ fact: fact.slice(0, 100) }, 'Mirroring new fact');
  getMemoryService().save(
    { userId, organizationId },
    [{ role: 'fact', content: fact }],
    { category: category === 'preference' ? 'preference' : 'relationship_fact', metadata: { source: 'api', category: category === 'preference' ? 'preference' : 'relationship_fact' } },
  ).catch((err) => log.error({ err }, 'Memory mirror failed'));

  return JSON.stringify({
    action: 'created',
    saved: true,
    message: `Got it — I'll remember that: "${fact}"`,
  });
}
