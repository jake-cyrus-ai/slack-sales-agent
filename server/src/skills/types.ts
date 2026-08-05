/**
 * Skill-based architecture types.
 *
 * A skill is a self-contained unit of capability — it owns its tools,
 * its prompt, its triggers, and its agent creation logic. The supervisor
 * reads from a skill registry instead of hardcoded constants.
 */

import type { DynamicStructuredTool, StructuredToolInterface } from '@langchain/core/tools';
import type { UserInfo, PromptContext } from '../agent/system-prompt.js';
import type { GranolaClientScope } from '../services/granola-client.js';
import type { IMemoryService } from '../services/memory/types.js';

// ─── Trigger types ───────────────────────────────────────────────────────────

export interface SkillTrigger {
  type: 'intent' | 'event' | 'schedule' | 'explicit' | 'compose';
  /** Regex patterns that hint at this skill (for 'intent' triggers) */
  patterns?: RegExp[];
  /** Inngest event name (for 'event' triggers) */
  eventName?: string;
  /** Cron expression (for 'schedule' triggers) */
  cron?: string;
}

// ─── Composition rules ──────────────────────────────────────────────────────

/** Declares when other skills should co-activate alongside this skill. */
export interface CompositionRule {
  /** Regex pattern that triggers this rule (tested against user message) */
  when: RegExp;
  /** Additional skills to activate alongside the source skill */
  add: string[];
  /** If set, rule only fires when this skill is already in the classification */
  requiresSkill?: string;
  /** Force sequential execution when this rule fires */
  sequential?: boolean;
  /** Execution order when sequential (lower = earlier) */
  priority?: number;
}

// ─── Skill memory config ────────────────────────────────────────────────────

/** Declarative memory configuration for a skill manifest. */
export interface SkillMemoryConfig {
  /** Skill gets a memory_search tool auto-injected by the supervisor */
  canRead?: boolean;
  /** Supervisor auto-saves conversation turn after successful execution */
  canWrite?: boolean;
  /** Isolate this skill's memories from others (default: shared namespace) */
  useSkillNamespace?: boolean;
}

// ─── Skill context ──────────────────────────────────────────────────────────

/** Runtime context passed to skill factories at invocation time. */
export interface SkillContext {
  userId: string;
  organizationId: string | null;
  user: UserInfo;
  promptCtx: PromptContext;
  userPreferences: string | null;
  slackContext: { channelId: string; threadTs: string; botToken?: string };
  granolaScope: GranolaClientScope;
  userTimezone?: string | null;
  memoryService: IMemoryService;
  /** Human-readable context about disconnected integrations, for agent guidance */
  unavailableSkillContext?: string | null;
  /** Human-readable context about connected capabilities, for "what can you do?" answers */
  availableSkillContext?: string | null;
}

// ─── Prompt sections ─────────────────────────────────────────────────────────

/** Optional base-prompt sections that can be gated per-skill.
 *  Core sections (identity, voice, user info, preferences) are always included. */
export type PromptSection = 'tools' | 'dates';

// ─── Skill manifest ─────────────────────────────────────────────────────────

/** Static metadata — the skill's contract with the orchestrator. */
export interface SkillManifest {
  /** Unique identifier, matches the LangGraph node name */
  name: string;
  /** Short description for clarification messages */
  description: string;
  /** Full description with examples for LLM classification prompt */
  classificationHint: string;
  /** What activates this skill */
  triggers: SkillTrigger[];
  /** Cross-domain routing rules — when other skills should co-activate */
  compositionRules?: CompositionRule[];
  /** LLM model override (default: claude-sonnet-4-20250514) */
  model?: string;
  /** Temperature override (default: 0) */
  temperature?: number;
  /** Max tokens for the LLM */
  maxTokens?: number;
  /** ReAct loop iteration limit (default: 10) */
  recursionLimit?: number;
  /** Workflow kind for usage tracking */
  workflowKind: string;
  /** Legacy names that resolve to this skill (e.g., 'knowledge' → enablement) */
  aliases?: string[];
  /** Sync gate — skill only registers if this returns true */
  isAvailable?: () => boolean;
  /** Integration that must be connected for this skill to be available per-user.
   *  Skills without this field are always available (e.g., conversational, enablement). */
  requiredIntegration?: {
    /** Integration identifier checked against UserIntegrations */
    id: 'google' | 'granola' | 'salesforce' | 'attio';
    /** Whether this is a user-level or org-level integration */
    level: 'user' | 'org';
    /** Human-readable label (e.g., "Google Calendar", "Salesforce") */
    label: string;
    /** Guidance on how to connect (user-level vs org-level messaging) */
    connectHint: string;
  };
  /** Declarative memory access — read, write, and namespace isolation */
  memory?: SkillMemoryConfig;
  /** Which optional base-prompt sections this skill needs.
   *  Default: ['tools', 'dates'] (backward compatible — includes all optional sections). */
  promptSections?: PromptSection[];
}

// ─── Skill definition ───────────────────────────────────────────────────────

/** Full skill definition — manifest + runtime factories. */
export interface SkillDefinition {
  manifest: SkillManifest;
  /** Returns the tools array for this skill */
  tools: (ctx: SkillContext) => StructuredToolInterface[];
  /** Returns the system prompt string for this skill */
  promptFragment: (ctx: SkillContext) => string;
  /** Optional custom agent factory. When omitted, the supervisor uses
   *  createSkillAgent() which reads model/temp/maxTokens from manifest.
   *  Only needed for non-standard agents (salesforce graph, conversational). */
  createAgent?: (ctx: SkillContext, tools?: StructuredToolInterface[]) => ReturnType<typeof import('@langchain/langgraph/prebuilt').createReactAgent>;
}
