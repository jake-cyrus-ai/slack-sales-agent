/**
 * Conversational skill — greetings, thanks, meta-questions, casual chat.
 *
 * Uses the default ReAct agent (createSkillAgent) with memory tools injected
 * so it can save user facts when users share info about themselves.
 * Simple greetings ("Hey!") are handled by the greeting fast-path and
 * never reach this skill's agent.
 */

import { basePrompt } from '../../agent/system-prompt.js';
import type { SkillDefinition } from '../types.js';

export const conversationalSkill: SkillDefinition = {
  manifest: {
    name: 'conversational',
    description: 'Greetings, thanks, meta-questions, or casual chat',
    classificationHint:
      '"conversational": Greetings, thanks, goodbyes, acknowledgments, meta-questions about what you can do, emoji reactions, or casual small talk that does NOT require any tool access. Examples: "Hey!", "Good morning", "Thanks!", "What can you do?", "Got it", "Who are you?", "\uD83D\uDC4D"',
    triggers: [
      {
        type: 'intent',
        patterns: [], // Uses greeting fast-path, not pattern matching
      },
    ],
    model: 'claude-haiku-4-5-20251001',
    temperature: 0.7,
    maxTokens: 300,
    recursionLimit: 6,
    workflowKind: 'conversational',
    memory: { canRead: true },
  },

  tools: () => [], // Memory tools (save_user_fact, memory_search) are injected by the supervisor

  promptFragment: (ctx) => {
    let prompt = `${basePrompt(ctx.user, ctx.promptCtx, ctx.userPreferences, [])}

Keep greetings and casual replies short (2-3 sentences max).
Never use bullet lists for greetings — just be natural and conversational.
Never fabricate capabilities you don't have.

MEMORY: When the user asks what you know about them, their role, background, or any personal context — ALWAYS call memory_search first before answering. Do not answer from the system prompt alone. Your memory may have facts saved from previous conversations.

FORGET/DELETE: When the user asks you to forget, delete, or remove something — use delete_user_fact to remove it. Do NOT save the opposite as a new fact. "Forget that I'm X" means DELETE the fact about X, not save "user is not X" or "user is the opposite of X".`;

    if (ctx.availableSkillContext) {
      prompt += `

Your current capabilities (based on connected integrations):
${ctx.availableSkillContext}
When the user asks "What can you do?", mention only these capabilities naturally.`;
    }

    if (ctx.unavailableSkillContext) {
      prompt += `

The following integrations are NOT connected for this user:
${ctx.unavailableSkillContext}

If the user asks about capabilities that require a disconnected integration:
1. Acknowledge you can't do that yet
2. Explain which integration would enable it
3. Tell them how to connect it (the hint above tells you whether it's a user-level or org-level integration)
Be concise and helpful — don't over-explain.`;
    }

    return prompt;
  },

  // No custom createAgent — uses the default ReAct agent (createSkillAgent)
  // which supports the injected memory tools (save_user_fact, memory_search).
};
