/**
 * Update Email Style Tool — allows the agent to modify the user's email
 * writing style preferences (writing_style_profile, learned_preferences,
 * signature_preferences) in the user_context table.
 *
 * Changes made here are immediately reflected in the UI settings and
 * used by both the chat agent and autonomous email agent.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ tool: 'update_email_style' });

export function createUpdateEmailStyleTool(userId: string) {
  return new DynamicStructuredTool({
    name: 'update_email_style',
    description:
      'Update the user\'s email writing style preferences. Use when the user asks to change how their emails are written — tone, formality, sign-off, openings, phrases to avoid, etc. Changes are saved permanently and reflected in the UI settings.',
    schema: z.object({
      tone: z.string().optional().describe('Overall tone, e.g. "casual and direct", "professional but friendly"'),
      formality: z.string().optional().describe('Formality level: "casual", "semi-formal", "formal"'),
      sentence_length: z.string().optional().describe('Preferred sentence length: "short", "medium", "long"'),
      sign_off: z.string().optional().describe('Email sign-off phrase, e.g. "Best,", "Cheers,", "Thanks,"'),
      use_first_name_only: z.boolean().optional().describe('Sign with first name only (true) or full name (false)'),
      openings_to_add: z.array(z.string()).optional().describe('Opening phrases to add to preferred openings'),
      openings_to_remove: z.array(z.string()).optional().describe('Opening phrases to remove from preferred openings'),
      phrases_to_avoid: z.array(z.string()).optional().describe('Phrases to avoid in emails'),
      tone_notes: z.string().optional().describe('Free-form tone guidance, e.g. "be more empathetic", "use humor"'),
    }),
    func: async (input) => {
      log.info({ userId, input }, 'Updating email style');

      try {
        // 1. Fetch existing user_context row
        const { data: existing } = await supabase
          .from('user_context')
          .select('*')
          .eq('user_id', userId)
          .maybeSingle();

        const currentProfile = (existing?.writing_style_profile as any) || {};
        const currentLearned = (existing?.learned_preferences as any) || {};
        const currentSigPrefs = (existing?.signature_preferences as any) || {};

        // 2. Deep merge updates into writing_style_profile
        const updatedProfile = { ...currentProfile };
        if (input.tone !== undefined) updatedProfile.tone = input.tone;
        if (input.formality !== undefined) updatedProfile.formality = input.formality;
        if (input.sentence_length !== undefined) updatedProfile.sentence_length = input.sentence_length;

        // Handle openings: add/remove from typical_openings array
        if (input.openings_to_add?.length || input.openings_to_remove?.length) {
          const currentOpenings: string[] = updatedProfile.typical_openings || [];
          let newOpenings = [...currentOpenings];
          if (input.openings_to_remove?.length) {
            const removeLower = input.openings_to_remove.map(o => o.toLowerCase());
            newOpenings = newOpenings.filter(o => !removeLower.includes(o.toLowerCase()));
          }
          if (input.openings_to_add?.length) {
            for (const opening of input.openings_to_add) {
              if (!newOpenings.some(o => o.toLowerCase() === opening.toLowerCase())) {
                newOpenings.push(opening);
              }
            }
          }
          updatedProfile.typical_openings = newOpenings.slice(0, 10);
        }

        // 3. Deep merge updates into learned_preferences
        const updatedLearned = { ...currentLearned };
        if (input.phrases_to_avoid?.length) {
          const currentAvoid: string[] = updatedLearned.phrases_to_avoid || [];
          const merged = [...currentAvoid];
          for (const phrase of input.phrases_to_avoid) {
            if (!merged.some(p => p.toLowerCase() === phrase.toLowerCase())) {
              merged.push(phrase);
            }
          }
          updatedLearned.phrases_to_avoid = merged.slice(0, 20);
        }
        if (input.tone_notes !== undefined) updatedLearned.tone_notes = input.tone_notes;

        // 4. Update signature_preferences
        const updatedSigPrefs = { ...currentSigPrefs };
        if (input.sign_off !== undefined) updatedSigPrefs.sign_off = input.sign_off;
        if (input.use_first_name_only !== undefined) updatedSigPrefs.use_first_name = input.use_first_name_only;

        // 5. Upsert to user_context
        const updatePayload = {
          writing_style_profile: updatedProfile,
          learned_preferences: updatedLearned,
          signature_preferences: updatedSigPrefs,
          updated_at: new Date().toISOString(),
        };

        if (existing) {
          const { error } = await supabase
            .from('user_context')
            .update(updatePayload)
            .eq('user_id', userId);

          if (error) {
            log.error({ err: error }, 'Update error');
            return JSON.stringify({ error: `Failed to update: ${error.message}` });
          }
        } else {
          const { error } = await supabase
            .from('user_context')
            .insert({ user_id: userId, ...updatePayload });

          if (error) {
            log.error({ err: error }, 'Insert error');
            return JSON.stringify({ error: `Failed to save: ${error.message}` });
          }
        }

        // 6. Build confirmation of what changed
        const changes: string[] = [];
        if (input.tone) changes.push(`tone → "${input.tone}"`);
        if (input.formality) changes.push(`formality → "${input.formality}"`);
        if (input.sentence_length) changes.push(`sentence length → "${input.sentence_length}"`);
        if (input.sign_off) changes.push(`sign-off → "${input.sign_off}"`);
        if (input.use_first_name_only !== undefined) changes.push(`sign with first name only → ${input.use_first_name_only}`);
        if (input.openings_to_add?.length) changes.push(`added openings: ${input.openings_to_add.join(', ')}`);
        if (input.openings_to_remove?.length) changes.push(`removed openings: ${input.openings_to_remove.join(', ')}`);
        if (input.phrases_to_avoid?.length) changes.push(`phrases to avoid: ${input.phrases_to_avoid.join(', ')}`);
        if (input.tone_notes) changes.push(`tone notes → "${input.tone_notes}"`);

        // Build current style summary so the LLM can apply it immediately
        // (the system prompt won't reflect changes until the next message)
        const styleSummary: string[] = [];
        if (updatedProfile.tone) styleSummary.push(`Tone: ${updatedProfile.tone}`);
        if (updatedProfile.formality) styleSummary.push(`Formality: ${updatedProfile.formality}`);
        if (updatedProfile.sentence_length) styleSummary.push(`Sentence length: ${updatedProfile.sentence_length}`);
        if (updatedProfile.typical_openings?.length) styleSummary.push(`Openings: ${updatedProfile.typical_openings.join(', ')}`);
        if (updatedLearned.phrases_to_avoid?.length) styleSummary.push(`Avoid: ${updatedLearned.phrases_to_avoid.join(', ')}`);
        if (updatedLearned.tone_notes) styleSummary.push(`Tone notes: ${updatedLearned.tone_notes}`);
        if (updatedSigPrefs.sign_off) styleSummary.push(`Sign-off: ${updatedSigPrefs.sign_off} (appended automatically)`);

        return JSON.stringify({
          success: true,
          message: `Updated your email style: ${changes.join('; ')}`,
          changes,
          currentStyle: styleSummary.length > 0
            ? `Apply these preferences when drafting emails in this conversation: ${styleSummary.join('; ')}`
            : undefined,
        });
      } catch (err: any) {
        log.error({ err }, 'Error updating email style');
        return JSON.stringify({ error: err.message });
      }
    },
  });
}
