/**
 * Skill Registry — runtime catalog of all available skills.
 *
 * Replaces hardcoded VALID_AGENTS, AGENT_ALIASES, DOMAIN_DESCRIPTIONS,
 * *_PATTERNS arrays, AGENT_TO_WORKFLOW_KIND, and normalizeAgent() from
 * the supervisor with dynamic lookups from self-registering skills.
 */

import type { SkillDefinition, SkillManifest, CompositionRule } from './types.js';

class SkillRegistry {
  private skills = new Map<string, SkillDefinition>();
  private aliases = new Map<string, string>();
  private loaded = false;

  /**
   * Register a single skill definition.
   * Replaces hardcoded agent imports in the supervisor.
   */
  register(skill: SkillDefinition): void {
    this.skills.set(skill.manifest.name, skill);
    for (const alias of skill.manifest.aliases || []) {
      this.aliases.set(alias, skill.manifest.name);
    }
  }

  /**
   * Load all skills, filtering by isAvailable().
   * Called once at startup — idempotent.
   */
  loadAll(skills: SkillDefinition[]): void {
    if (this.loaded) return;
    for (const skill of skills) {
      if (skill.manifest.isAvailable && !skill.manifest.isAvailable()) {
        continue;
      }
      this.register(skill);
    }
    this.loaded = true;
  }

  /** Get a skill by name or alias. Replaces the switch statement in runSubAgent(). */
  resolve(name: string): SkillDefinition | undefined {
    return this.skills.get(name) || this.skills.get(this.aliases.get(name) || '');
  }

  /** All registered canonical skill names. */
  names(): string[] {
    return [...this.skills.keys()];
  }

  /** All registered skill manifests. */
  manifests(): SkillManifest[] {
    return [...this.skills.values()].map((s) => s.manifest);
  }

  /** All valid names including aliases. Replaces VALID_AGENTS. */
  allValidNames(): string[] {
    return [...this.names(), ...this.aliases.keys()];
  }

  /** Resolve alias to canonical name. Replaces normalizeAgent(). */
  normalize(name: string): string {
    return this.aliases.get(name) || name;
  }

  /** Get intent patterns per skill. Replaces hardcoded *_PATTERNS arrays. */
  getSignalPatterns(): Record<string, RegExp[]> {
    const out: Record<string, RegExp[]> = {};
    for (const [name, skill] of this.skills) {
      const intentTrigger = skill.manifest.triggers.find((t) => t.type === 'intent');
      out[name] = intentTrigger?.patterns || [];
    }
    return out;
  }

  /** Short descriptions per skill. Replaces DOMAIN_DESCRIPTIONS. */
  getDomainDescriptions(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, skill] of this.skills) {
      out[name] = skill.manifest.description;
    }
    return out;
  }

  /** Generate classification hints from all manifests for the LLM classification prompt. */
  getClassificationHints(): string {
    return this.manifests()
      .map((m) => `- ${m.classificationHint}`)
      .join('\n');
  }

  /** Classification hints filtered to only skills in the available set. */
  getClassificationHintsFiltered(available: string[]): string {
    const set = new Set(available);
    return this.manifests()
      .filter((m) => set.has(m.name))
      .map((m) => `- ${m.classificationHint}`)
      .join('\n');
  }

  /** Signal patterns filtered to only skills in the available set. */
  getSignalPatternsFiltered(available: string[]): Record<string, RegExp[]> {
    const set = new Set(available);
    const out: Record<string, RegExp[]> = {};
    for (const [name, skill] of this.skills) {
      if (!set.has(name)) continue;
      const intentTrigger = skill.manifest.triggers.find((t) => t.type === 'intent');
      out[name] = intentTrigger?.patterns || [];
    }
    return out;
  }

  /** Composition rules filtered to only add skills in the available set. */
  getCompositionRulesFiltered(available: string[]): Array<CompositionRule & { sourceSkill: string }> {
    const set = new Set(available);
    const rules: Array<CompositionRule & { sourceSkill: string }> = [];
    for (const [name, skill] of this.skills) {
      if (!set.has(name)) continue;
      for (const rule of skill.manifest.compositionRules || []) {
        // Only include rules whose added skills are all available
        const filteredAdd = rule.add.filter((s) => set.has(s));
        if (filteredAdd.length > 0) {
          rules.push({ ...rule, add: filteredAdd, sourceSkill: name });
        }
      }
    }
    return rules;
  }

  /** Workflow kind mapping for usage tracking. Replaces AGENT_TO_WORKFLOW_KIND. */
  getWorkflowKindMap(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, skill] of this.skills) {
      out[name] = skill.manifest.workflowKind;
    }
    return out;
  }

  /** Collect all composition rules from all skills. Replaces applyRoutingRules(). */
  getCompositionRules(): Array<CompositionRule & { sourceSkill: string }> {
    const rules: Array<CompositionRule & { sourceSkill: string }> = [];
    for (const [name, skill] of this.skills) {
      for (const rule of skill.manifest.compositionRules || []) {
        rules.push({ ...rule, sourceSkill: name });
      }
    }
    return rules;
  }
}

/** Singleton registry instance. */
export const registry = new SkillRegistry();
