/**
 * Auto-preference learning — analyzes recent conversations to detect
 * communication preferences (response length, formality, detail level, style).
 *
 * Debounced: skips if last analysis was < 24h ago.
 * Ported from supabase/functions/analyze-user-preferences edge function.
 */

import { workflow } from '../../client.js';
import { ChatAnthropic } from '@langchain/anthropic';
import { getSupabaseAdmin } from '../../utils/supabase';
import { resolveOrgForUser } from '../../utils/tenant-resolver';
import { logger } from '../../../lib/logger';

const log = logger.child({ fn: 'analyze-preferences' });

export const analyzePreferences = workflow.createFunction(
  {
    id: 'analyze-user-preferences',
    concurrency: { limit: 5 },
    retries: 1,
  },
  { event: 'learning/analyze-preferences' },
  async ({ event, step }) => {
        const { userId } = event.data as { userId: string };

    const orgId = await step.run('resolve-org', () => resolveOrgForUser(userId));

    return await step.run('analyze', async () => {
            const supabase = getSupabaseAdmin();

      // Debounce: skip if last analysis was < 24h ago
      // Note: user_preferences has no organization_id column — user_id is the correct scope
      const { data: recentPref } = await supabase
        .from('user_preferences')
        .select('updated_at')
        .eq('user_id', userId)
        .eq('learned_from_conversations', true)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (recentPref?.updated_at) {
        const lastUpdate = new Date(recentPref.updated_at).getTime();
        const hoursSince = (Date.now() - lastUpdate) / (1000 * 60 * 60);
        if (hoursSince < 24) {
          return { status: 'debounced', hoursSinceLastAnalysis: Math.round(hoursSince) };
        }
      }

      // Fetch recent conversations (last 30 days, max 20)
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      let convQuery = supabase
        .from('conversations')
        .select('id')
        .eq('user_id', userId);
      if (orgId) convQuery = convQuery.eq('organization_id', orgId);
      const { data: conversations } = await convQuery
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(20);

      if (!conversations?.length) {
        return { status: 'skipped', reason: 'no_conversations' };
      }

      // Fetch messages for each conversation (first 10 exchanges = 20 messages)
      const samples: string[] = [];
      for (const conv of conversations) {
        const { data: messages } = await supabase
          .from('chat_messages')
          .select('role, content')
          .eq('conversation_id', conv.id)
          .order('created_at', { ascending: true })
          .limit(20);

        if (messages?.length) {
          const formatted = messages
            .map((m: any) => `${m.role}: ${m.content}`)
            .join('\n');
          samples.push(formatted);
        }
      }

      if (!samples.length) {
        return { status: 'skipped', reason: 'no_messages' };
      }

      // Analyze with Haiku (cheap, fast, deterministic)
      const llm = new ChatAnthropic({
        model: 'claude-haiku-4-5-20251001',
        anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
        temperature: 0.3,
      });

      const response = await llm.invoke([
        {
          role: 'system',
          content: `You are a user persona analyst. Analyze conversation samples between a user and an AI sales assistant. Build a profile of who this user is and how they work.

Return ONLY a JSON object (no markdown, no explanation) with these keys. Each value should be an object with { value, confidence (0.0-1.0), reasoning }:

COMMUNICATION STYLE:
- response_length: "brief" or "detailed"
- formality: "casual" or "professional"
- detail_level: "high_level" or "technical"
- response_style: "direct" or "exploratory"

SALES PERSONA (free text values):
- role_context: What the user does and who they sell to (e.g., "Enterprise AE selling to mid-market fintech companies")
- industry_focus: Industries/verticals they mention most (e.g., "fintech, healthtech, enterprise SaaS")
- selling_motion: "enterprise" (multi-stakeholder, longer cycles) or "smb" (fast cycles, volume) or "mixed"
- meeting_prep_style: "brief" (wants quick bullet points) or "thorough" (wants deep research, attendee profiles, talking points)
- email_tone: "formal" or "conversational" or "direct" — how they draft/request emails
- key_accounts: Companies, deals, or prospects mentioned repeatedly (e.g., "Ramp, Acme Corp, Notion")

Only include a dimension if you have enough signal (confidence >= 0.6). Omit keys you can't determine. For free-text values, be specific and concise.`,
        },
        {
          role: 'user',
          content: `Analyze these ${samples.length} conversation samples:\n\n${samples.slice(0, 10).join('\n---\n')}`,
        },
      ]);

      const analysisText = typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content);

      // Strip markdown code fences if present
      const jsonText = analysisText.replace(/^```json?\s*\n?|\n?```$/g, '').trim();
      let analysis: Record<string, any>;
      try {
        analysis = JSON.parse(jsonText);
      } catch {
        log.error({ analysisText }, "Failed to parse Haiku response");
        return { status: 'error', reason: 'parse_failure' };
      }

      // Upsert preferences with confidence >= 0.6
      // Note: user_preferences has no organization_id column — user_id is the correct scope
      let upserted = 0;
      for (const [key, val] of Object.entries(analysis)) {
        if (!val?.value || (val.confidence ?? 0) < 0.6) continue;

        const { error } = await supabase
          .from('user_preferences')
          .upsert(
            {
              user_id: userId,
              preference_key: key,
              preference_value: {
                value: val.value,
                confidence: val.confidence,
                reasoning: val.reasoning,
              },
              confidence_score: val.confidence,
              learned_from_conversations: true,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'user_id,preference_key' },
          );

        if (error) {
          log.error({ err: error, key }, "Upsert error");
        } else {
          upserted++;
        }
      }

      log.info({ conversationCount: samples.length, userId, preferencesUpserted: upserted }, "Analyzed conversations");
      return { status: 'analyzed', conversations: samples.length, preferencesUpserted: upserted };
    });
  },
);
