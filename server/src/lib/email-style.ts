/**
 * Shared email writing style utilities.
 *
 * Formats writing_style_profile, learned_preferences, and other user_context
 * fields into prompt sections for email composition. Used by both the
 * autonomous email agent and the chat agent (via buildPreferenceInstructions).
 */

export interface UserContextRow {
  communication_style: string | null;
  role_description: string | null;
  custom_context: string | null;
  writing_style_profile: any | null;
  learned_preferences: any | null;
  signature_preferences: any | null;
  tone_examples: string[] | null;
  metadata: any | null;
}

/**
 * Build prompt sections describing the user's email writing style.
 * Returns a formatted string with WRITING STYLE, USER PREFERENCES,
 * and LEARNED FROM YOUR PAST EDITS sections as applicable.
 */
export function buildEmailContextSections(userContext: {
  writingStyleProfile: any;
  learnedPreferences: any;
  communicationStyle: string;
  roleDescription: string | null;
  customContext: string | null;
  signOffPhrase: string;
  feedbackLearnings?: string[];
}): string {
  const sections: string[] = [];

  if (userContext.writingStyleProfile) {
    const p = userContext.writingStyleProfile;
    const bullets: string[] = [];
    if (p.tone) bullets.push(`Tone: ${p.tone}`);
    if (p.sentence_length) bullets.push(`Sentence length: ${p.sentence_length}`);
    if (p.typical_openings?.length) bullets.push(`Openings: ${p.typical_openings.join(", ")}`);
    if (p.typical_sign_offs?.length) bullets.push(`Sign-offs: ${p.typical_sign_offs.join(", ")}`);
    if (p.vocabulary_tendencies?.length) bullets.push(`Vocabulary: ${p.vocabulary_tendencies.join(", ")}`);
    if (p.phrases_to_avoid?.length) bullets.push(`Avoid: ${p.phrases_to_avoid.join(", ")}`);
    if (p.formality) bullets.push(`Formality: ${p.formality}`);
    if (p.structure_notes) bullets.push(`Structure: ${p.structure_notes}`);
    if (p.style_prompt_fragment) bullets.push(p.style_prompt_fragment);
    if (bullets.length > 0) {
      sections.push(`WRITING STYLE (from your examples):\n${bullets.map(b => `- ${b}`).join("\n")}`);
    }
  }

  sections.push(`USER PREFERENCES:
Communication Style: ${userContext.communicationStyle || "professional"}
Role: ${userContext.roleDescription || "Sales representative"}
Sign-off: ${userContext.signOffPhrase || "Best,"} (appended automatically — do NOT include in email body)
${userContext.customContext ? `Additional context: ${userContext.customContext}` : ""}`);

  if (userContext.learnedPreferences) {
    const lp = userContext.learnedPreferences;
    const bullets: string[] = [];
    if (lp.opening_phrases?.length) bullets.push(`Openings you like: ${lp.opening_phrases.join(", ")}`);
    if (lp.sign_off_preferences?.length) bullets.push(`Sign-offs you prefer: ${lp.sign_off_preferences.join(", ")}`);
    if (lp.phrases_to_avoid?.length) bullets.push(`Phrases to avoid: ${lp.phrases_to_avoid.join(", ")}`);
    if (lp.substitutions?.length) {
      lp.substitutions.slice(0, 5).forEach((s: any) => bullets.push(`Prefer "${s.to}" instead of "${s.from}"`));
    }
    if (lp.tone_notes) bullets.push(`Tone: ${lp.tone_notes}`);
    if (bullets.length > 0) {
      sections.push(`LEARNED FROM YOUR PAST EDITS:\n${bullets.map(b => `- ${b}`).join("\n")}`);
    }
  }

  if (userContext.feedbackLearnings?.length) {
    sections.push(`FEEDBACK-BASED RULES (follow these strictly):\n${userContext.feedbackLearnings.map(l => `- ${l}`).join("\n")}`);
  }

  return sections.join("\n\n");
}
