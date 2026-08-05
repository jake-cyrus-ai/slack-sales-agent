/**
 * LangGraph Supervisor — loadContext → classify → route → specialists (parallel) → synthesize → END.
 *
 * Phase 3 rewrite: specialist agents fan out in parallel via Send(),
 * no more planNode. Deep agents (prospecting) can be dispatched via Inngest.
 */

import { StateGraph, END, Send } from '@langchain/langgraph';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { SupervisorState, type SupervisorStateType, type EvidenceAssessment } from './state.js';
import type { WorkflowKind } from '../lib/workflow-tracking.js';
import { getClassificationPrompt, buildPromptContext, agentLedContextBlock } from './system-prompt.js';
import { getSnapshot } from './context-graph.js';
import { GranolaClientScope } from '../services/granola-client.js';
import { config } from '../config.js';
import { createLLM, invokeWithRetry } from '../lib/llm-retry.js';
import { trackUsageEvent } from '../lib/usage-tracking.js';
import { startWorkflowRun, completeWorkflowRun } from '../lib/workflow-tracking.js';
import { registry } from '../skills/registry.js';
import { allSkills } from '../skills/definitions/index.js';
import type { SkillContext } from '../skills/types.js';
import { getMemoryService } from '../services/memory/index.js';
import type { MemoryScope } from '../services/memory/types.js';
import { createMemorySearchTool } from '../tools/memory-search.js';
import { createSaveUserFactTool } from '../tools/save-user-fact.js';
import { createDeleteUserFactTool } from '../tools/delete-user-fact.js';
import { createRecordFeedbackTool } from '../tools/record-feedback.js';
import { createSkillAgent } from '../skills/create-skill-agent.js';
import type { SourceInfo } from '../slack/formatter.js';
import { checkUserIntegrations, type UserIntegrations } from '../services/integration-check.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ component: 'supervisor' });
import { supabase } from '../lib/supabase.js';

// LangGraph response objects carry usage_metadata at runtime but it isn't
// typed in the public SDK interface; narrow it here instead of using `any`.
interface UsageMetadata { input_tokens?: number; output_tokens?: number }
interface WithUsageMetadata { usage_metadata?: UsageMetadata }
// Content blocks in AI message arrays also lack precise types in the SDK.
interface TextContentBlock { type: string; text?: string }

// ─── Public interface ──────────────────────────────────────────────────────

export interface SupervisorInput {
  messages: Array<{ role: string; content: string }>;
  currentMessage: string;
  userId: string;
  organizationId: string | null;
  userName: string | null;
  userEmail: string | null;
  userCompany: string | null;
  userTitle?: string | null;
  slackContext?: { channelId: string; threadTs: string; botToken?: string };
  /** Web/widget channel — when set, slackContext is synthesized internally. */
  channel?: { type: 'widget' | 'web'; sessionId: string };
  domainSignals?: Record<string, number> | null;
  /** Force a specific domain — skips classification entirely and routes straight to that agent. */
  forceDomain?: string | null;
  userPreferences?: string | null;
  userTimezone?: string | null;
  onProgress?: (status: string) => void;
}

export interface PendingApproval {
  type: 'email_send' | 'email_draft' | 'calendar_delete';
  id: string;
  metadata: Record<string, unknown>;
}

export interface SupervisorResult {
  response: string;
  sources?: SourceInfo[];
  confidence?: number;
  hasConflicts?: boolean;
  /** Disconnected integrations detected during classification — used for connect buttons */
  missingIntegrations?: Array<{ label: string; level: 'user' | 'org' }>;
  /** Pending approvals from tool calls (email drafts, calendar deletes) — used for web approval cards */
  pendingApprovals?: PendingApproval[];
}

/**
 * Run the supervisor graph end-to-end and return a formatted response.
 *
 * The graph is compiled once on first call. This is safe: CompiledStateGraph
 * is a stateless execution plan (DAG of nodes/edges). Each stream() call
 * creates its own isolated execution context with fresh state. Sub-agents
 * are also created fresh per request in runSubAgent().
 */
let _compiledGraph: ReturnType<typeof buildGraph> | null = null;
function getGraph() {
  if (!_compiledGraph) {
    registry.loadAll(allSkills);
    _compiledGraph = buildGraph();
  }
  return _compiledGraph;
}

export async function runSupervisor(input: SupervisorInput): Promise<SupervisorResult> {
  const graph = getGraph();
  const onProgress = input.onProgress || (() => {});

  // Synthesize slackContext for web/widget callers that don't have a real Slack thread
  const slackCtx = input.slackContext || {
    channelId: `web:${input.channel?.sessionId || 'anon'}`,
    threadTs: input.channel?.sessionId || 'anon',
    botToken: '',
  };

  // Convert conversation history to LangChain messages
  const langchainMessages = input.messages.map((m) =>
    m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)
  );

  // Append currentMessage if not already present as the last human message
  const lastHuman = langchainMessages.filter((m) => m._getType() === 'human').pop();
  if (input.currentMessage && (!lastHuman || lastHuman.content !== input.currentMessage)) {
    langchainMessages.push(new HumanMessage(input.currentMessage));
  }

  const initialState = {
    messages: langchainMessages,
    userId: input.userId,
    organizationId: input.organizationId,
    userName: input.userName,
    userEmail: input.userEmail,
    userCompany: input.userCompany,
    userTitle: input.userTitle || null,
    classification: null,
    subAgentResponse: null,
    subAgentResponses: {},
    slackContext: { channelId: slackCtx.channelId, threadTs: slackCtx.threadTs },
    domainSignals: input.domainSignals || null,
    forceDomain: input.forceDomain || null,
    userPreferences: input.userPreferences || null,
    userTimezone: input.userTimezone || null,
    evidenceAssessment: null,
    contextSnapshot: null,
    priorMemory: null,
    availableSkills: [],
    unavailableSkillContext: '',
    availableSkillContext: '',
    missingIntegrations: [],
  };

  const STATUS_MAP: Record<string, string> = {
    sales: 'Checking your email and contacts :mag:',
    calendar: 'Checking your calendar :calendar:',
    transcript: 'Searching meeting notes :memo:',
    enablement: 'Searching the knowledge base :mag:',
    prospecting: 'Researching :mag:',
    salesforce: 'Querying Salesforce :cloud:',
    attio: 'Querying Attio CRM :card_index_dividers:',
  };

  // Stream graph execution to get per-node progress updates
  let finalState: SupervisorStateType = { ...initialState };
  const stream = await graph.stream(initialState, {
    streamMode: 'updates',
    configurable: { botToken: slackCtx.botToken },
  });
  for await (const event of stream) {
    const [nodeName] = Object.keys(event);
    const nodeState = event[nodeName];

    // Stream yields node OUTPUTS (after completion). Only send progress for
    // classify (which tells us what's about to run). Specialist/synthesize outputs
    // arrive after their work is done — sending progress updates here races with
    // the final response being posted to Slack and can overwrite it.
    if (nodeName === 'classify' && nodeState.classification) {
      const domains = nodeState.classification.domains || [];
      if (nodeState.classification.needsClarification) {
        onProgress('Thinking...');
      } else if (domains.length > 1) {
        onProgress('Working across multiple areas :mag:');
      } else {
        onProgress(STATUS_MAP[domains[0]] || 'Thinking...');
      }
    }

    finalState = { ...finalState, ...nodeState };
  }

  const assessment: EvidenceAssessment | null = finalState.evidenceAssessment || null;

  // Only surface connect buttons for integrations the classified domains actually need.
  // Without this filter, every response would show buttons for ALL disconnected integrations
  // (e.g. "Connect Granola" on a settings question).
  const classifiedDomains = new Set(finalState.classification?.domains || []);
  const relevantIntegrationLabels = new Set<string>();
  for (const manifest of registry.manifests()) {
    if (manifest.requiredIntegration && classifiedDomains.has(manifest.name)) {
      relevantIntegrationLabels.add(manifest.requiredIntegration.label);
    }
  }
  const filtered = finalState.missingIntegrations?.filter((mi: { label: string }) => relevantIntegrationLabels.has(mi.label));
  const missingIntegrations = filtered?.length ? filtered : undefined;

  const pendingApprovals = extractPendingApprovals(finalState.messages || []);

  return {
    response: finalState.subAgentResponse || 'Sorry, I was unable to process your request. Please try again.',
    sources: assessment?.sources?.slice(0, 5).map((s) => ({
      title: s.title,
      similarity: s.relevance === 'direct' ? 0.9 : s.relevance === 'supporting' ? 0.7 : 0.4,
    })) || [],
    confidence: assessment?.confidenceScore,
    hasConflicts: assessment?.hasConflicts || false,
    missingIntegrations,
    ...(pendingApprovals.length > 0 && { pendingApprovals }),
  };
}

/** Scan ToolMessage content for approval IDs (email drafts, calendar deletes). */
function extractPendingApprovals(messages: import('@langchain/core/messages').BaseMessage[]): PendingApproval[] {
  const approvals: PendingApproval[] = [];
  for (const msg of messages) {
    if (typeof msg._getType !== 'function' || msg._getType() !== 'tool') continue;
    const raw = typeof msg.content === 'string' ? msg.content : '';
    if (!raw.includes('approvalId') && !raw.includes('pendingActionId')) continue;

    try {
      const parsed = JSON.parse(raw);
      if (parsed.approvalId) {
        approvals.push({
          type: parsed.status === 'draft_ready' ? 'email_draft' : 'email_send',
          id: parsed.approvalId,
          metadata: {
            to: parsed.to || parsed.to_email,
            subject: parsed.subject,
            body: parsed.body,
          },
        });
      } else if (parsed.pendingActionId) {
        approvals.push({
          type: 'calendar_delete',
          id: parsed.pendingActionId,
          metadata: {
            eventSummary: parsed.event?.summary,
            eventStart: parsed.event?.start,
            eventEnd: parsed.event?.end,
          },
        });
      }
    } catch {
      // Not valid JSON, skip
    }
  }
  return approvals;
}

// ─── Domain signal computation (soft hints for LLM) ──────────────────────────

/** Compute domain signals only for available skills. */
function computeDomainSignalsFiltered(text: string, available: string[]): Record<string, number> {
  const lower = text.toLowerCase();
  const patterns = registry.getSignalPatternsFiltered(available);
  const signals: Record<string, number> = {};

  for (const [name, regexes] of Object.entries(patterns)) {
    signals[name] = regexes.filter((p) => p.test(lower)).length;
  }

  return signals;
}

export function computeDomainSignals(text: string): Record<string, number> {
  const lower = text.toLowerCase();
  const patterns = registry.getSignalPatterns();
  const signals: Record<string, number> = {};

  for (const [name, regexes] of Object.entries(patterns)) {
    signals[name] = regexes.filter((p) => p.test(lower)).length;
  }

  // Cross-domain boosts: pre-classification hints for common multi-skill patterns.
  // These boost signal scores so the LLM classifier sees them as hints.

  // "What's the latest with X" → hint at both sales + transcript
  if (/\bwhat(?:'s| is) (?:the )?(?:latest|status|update) (?:with|on|from)\b/i.test(text) && signals.sales > 0) {
    signals.transcript = Math.max(signals.transcript || 0, 1);
  }

  // "next meeting" + research/linkedin → hint at calendar + prospecting
  if (/\b(?:next|upcoming)\s+(?:meeting|call|sync)\b/i.test(text) && /\b(?:linkedin|background|research|look\s*up|who)\b/i.test(text)) {
    signals.calendar = Math.max(signals.calendar || 0, 1);
    signals.prospecting = Math.max(signals.prospecting || 0, 1);
  }

  // Entity references without action verbs → hint at sales + prospecting
  const hasEntityRef = /\b(?:thinking about|wondering about|curious about|tell me about)\b/i.test(text);
  if (hasEntityRef) {
    signals.sales = Math.max(signals.sales || 0, 1);
    signals.prospecting = Math.max(signals.prospecting || 0, 1);
  }

  return signals;
}

/**
 * Trivial fast-path: only fires when a single domain has 3+ pattern matches
 * and all other domains have 0 matches.
 */
function trivialFastPath(signals: Record<string, number>): string | null {
  const entries = Object.entries(signals);
  const nonZero = entries.filter(([, v]) => v > 0);

  // Case 1: Single domain with 2+ matches, everything else is 0
  if (nonZero.length === 1) {
    const [domain, score] = nonZero[0];
    if (score >= 2) return domain;
    return null;
  }

  // Case 2: Dominant domain with 3+ matches and 2+ lead over runner-up
  if (nonZero.length > 1) {
    const sorted = nonZero.sort((a, b) => b[1] - a[1]);
    const [topDomain, topScore] = sorted[0];
    const runnerUpScore = sorted[1][1];
    if (topScore >= 3 && topScore - runnerUpScore >= 2) return topDomain;
  }

  return null;
}

/**
 * Greeting fast-path: short messages that are clearly conversational
 * (greetings, thanks, etc.) skip classification entirely.
 */
const GREETING_PATTERN = /^(hey|hi|hello|thanks|thank you|ty|gm|good morning|good afternoon|good evening|yo|sup|what'?s up|howdy)[\s!?.,:)*]*$/iu;

function isGreeting(text: string): boolean {
  return text.length <= 30 && GREETING_PATTERN.test(text.trim());
}

/**
 * Confirmation detection: short affirmative messages that should continue the prior domain.
 */
const CONFIRMATION_PATTERN = /^(y(ep|up|es|eah)?|sure|ok(ay)?|go( ahead)?|do it|sounds good|perfect|absolutely|confirmed?|lgtm|ship it|let'?s go|👍)[\s!?.,:)*]*$/iu;

function isConfirmation(text: string): boolean {
  return text.length <= 40 && CONFIRMATION_PATTERN.test(text.trim());
}

/**
 * Detect which CRM-specific domain was active in recent conversation context.
 * Returns 'attio' or 'salesforce' if the prior assistant message referenced that domain.
 */
function detectPriorCrmDomain(messages: BaseMessage[]): string | null {
  // Walk backwards through messages to find last assistant message
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const type = typeof m._getType === 'function' ? m._getType() : 'unknown';
    if (type === 'ai' || type === 'assistant') {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      if (/\battio\b/i.test(content)) return 'attio';
      if (/\bsalesforce\b|\bsfdc\b/i.test(content)) return 'salesforce';
      break; // Only check the most recent assistant message
    }
  }
  return null;
}

// ─── Post-classification routing rules (deterministic, zero-token-cost) ──────

/**
 * Apply composition rules from skill manifests to patch LLM classification.
 * Runs AFTER the LLM classifies, so it only corrects misses — doesn't fight the LLM.
 * Replaces the old hardcoded applyRoutingRules() with registry-driven rules.
 */
function applyCompositionRules(
  classification: {
    domains: string[];
    primaryDomain: string;
    reasoning: string;
    confidence: number;
    needsClarification: boolean;
    clarificationQuestion: string | undefined;
    sequential: boolean;
  },
  text: string,
): typeof classification {
  const domains = new Set(classification.domains);
  const hadDomains = classification.domains.length;

  for (const rule of registry.getCompositionRules()) {
    if (!rule.when.test(text)) continue;
    if (rule.requiresSkill && !domains.has(rule.requiresSkill)) continue;

    for (const skill of rule.add) domains.add(skill);
    if (rule.sequential) classification.sequential = true;
  }

  // Remove needsClarification if composition rules added more domains
  if (domains.size > hadDomains && classification.needsClarification) {
    classification.needsClarification = false;
    classification.clarificationQuestion = undefined;
  }

  classification.domains = Array.from(domains);
  if (!classification.domains.includes(classification.primaryDomain)) {
    classification.primaryDomain = classification.domains[0];
  }

  return classification;
}

/** Apply composition rules filtered to only add available skills. */
function applyCompositionRulesFiltered(
  classification: {
    domains: string[];
    primaryDomain: string;
    reasoning: string;
    confidence: number;
    needsClarification: boolean;
    clarificationQuestion: string | undefined;
    sequential: boolean;
  },
  text: string,
  available: string[],
): typeof classification {
  const domains = new Set(classification.domains);
  const hadDomains = classification.domains.length;

  for (const rule of registry.getCompositionRulesFiltered(available)) {
    if (!rule.when.test(text)) continue;
    if (rule.requiresSkill && !domains.has(rule.requiresSkill)) continue;

    for (const skill of rule.add) domains.add(skill);
    if (rule.sequential) classification.sequential = true;
  }

  if (domains.size > hadDomains && classification.needsClarification) {
    classification.needsClarification = false;
    classification.clarificationQuestion = undefined;
  }

  classification.domains = Array.from(domains);
  if (!classification.domains.includes(classification.primaryDomain)) {
    classification.primaryDomain = classification.domains[0];
  }

  return classification;
}

// ─── Email intent detection ──────────────────────────────────────────────────

export type EmailIntent = 'draft' | 'send' | null;

export function detectEmailIntent(text: string): EmailIntent {
  return detectEmailIntentFromText(text);
}

export function detectEmailIntentFromText(text: string): EmailIntent {
  const lower = text.toLowerCase();
  if (/\b(?:send|fire off|shoot|dispatch)\s+(?:an?\s+)?(?:email|message|reply)/i.test(lower)) return 'send';
  if (/\b(?:draft|write|compose|prepare)\s+(?:an?\s+)?(?:email|message|reply)/i.test(lower)) return 'draft';
  if (/\b(?:reply to|respond to|get back to)\b/i.test(lower)) return 'send';
  return null;
}

// ─── Sequential chaining helper ─────────────────────────────────────────────

/**
 * After a specialist completes, check if there's a next agent in a sequential chain.
 * For parallel execution (default), always routes to 'synthesize'.
 * For sequential execution, routes to the next agent in classification.domains.
 */
function afterSpecialist(agentName: string) {
  return (state: SupervisorStateType): string => {
    const { classification } = state;
    if (!classification?.sequential) return 'synthesize';

    const domains = classification.domains;
    const idx = domains.indexOf(agentName);
    if (idx >= 0 && idx < domains.length - 1) {
      return domains[idx + 1]; // Route to next agent in sequence
    }
    return 'synthesize';
  };
}

// ─── Graph construction ────────────────────────────────────────────────────

function buildGraph() {
  const graph = new StateGraph(SupervisorState)
    .addNode('loadContext', loadContextNode)
    .addNode('classify', classifyNode)
    .addNode('clarify', clarifyNode)
    .addNode('synthesize', synthesizeNode);

  // Dynamically register skill nodes from the registry
  for (const name of registry.names()) {
    graph.addNode(name, (state: SupervisorStateType, config: RunnableConfig) => runSubAgent(state, name, config));
  }

  graph
    .addEdge('__start__', 'loadContext')
    .addEdge('loadContext', 'classify')
    .addConditionalEdges('classify', routeFromClassification)
    .addEdge('clarify', END);

  // Dynamic conditional edges for all skills (cast needed: nodes are registered dynamically)
  for (const name of registry.names()) {
    graph.addConditionalEdges(
      name as Parameters<typeof graph.addConditionalEdges>[0],
      afterSpecialist(name),
    );
  }

  graph.addEdge('synthesize', END);

  return graph.compile();
}

// ─── Nodes ─────────────────────────────────────────────────────────────────

/**
 * Phase 4: Pre-load context snapshot before classification.
 * Runs user/deal/account fetches in parallel. Results cached 5min.
 */
async function loadContextNode(state: SupervisorStateType) {
  let snapshot = null;
  let priorMemory: string | null = null;

  // Run context snapshot and integration checks in parallel
  const [snapshotResult, integrations] = await Promise.all([
    // Context snapshot (org-scoped)
    state.organizationId
      ? getSnapshot({ org_id: state.organizationId, user_id: state.userId })
          .then((s) => { log.info('Context snapshot loaded'); return s; })
          .catch((err) => { log.error({ err }, 'Context snapshot failed (non-fatal)'); return null; })
      : Promise.resolve(null),
    // Integration status check for skill gating
    checkUserIntegrations(state.userId, state.organizationId)
      .catch((err) => {
        log.error({ err, organizationId: state.organizationId, userId: state.userId }, 'Integration check failed — fail-closed, no integrations available');
        return { google: false, granola: false, salesforce: false, attio: false } as UserIntegrations;
      }),
  ]);
  snapshot = snapshotResult;

  // Compute available skills based on connected integrations
  const { availableSkills, unavailableSkillContext, availableSkillContext, missingIntegrations } = computeAvailableSkills(integrations);
  log.info({ availableSkills, organizationId: state.organizationId }, `Available skills: [${availableSkills.join(', ')}]`);
  if (unavailableSkillContext) {
    log.info({ unavailableSkillContext, organizationId: state.organizationId }, `Gated skills: ${unavailableSkillContext}`);
  }

  // Proactive memory recall — search for context related to the user's message
  // before classification so skill agents have prior context available.
  if (state.userId) {
    try {
      const lastMessage = state.messages[state.messages.length - 1];
      const query = typeof lastMessage?.content === 'string'
        ? lastMessage.content
        : '';

      if (query && query.length > 5) {
        const memoryService = getMemoryService();
        // Proactive recall uses shared namespace only (no skillNamespace).
        // Skill-specific memories are accessed by their owning skill via memory_search tool.
        const scope: MemoryScope = {
          userId: state.userId,
          organizationId: state.organizationId,
          skillNamespace: undefined,
        };
        // Search general memories + facts in parallel for better recall
        const [generalResult, factResult] = await Promise.all([
          memoryService.search(scope, query, 3, { includeOrgShared: true }),
          memoryService.search(scope, query, 3, { category: 'fact' }),
        ]);

        // Merge and deduplicate by content prefix
        const seen = new Set<string>();
        const allResults = [...generalResult.results, ...factResult.results]
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
          .filter((m) => {
            const key = m.content.slice(0, 80).toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, 5);

        if (allResults.length > 0) {
          priorMemory = allResults
            .map((m) => {
              const source = m.metadata?.source ? ` (${m.metadata.source})` : '';
              const when = m.createdAt ? ` [${new Date(m.createdAt).toLocaleDateString()}]` : '';
              return `• ${m.content}${source}${when}`;
            })
            .join('\n');
          log.info({ count: allResults.length, query: query.slice(0, 80) }, `Proactive memory: found ${allResults.length} memories`);
          for (const m of allResults) {
            log.debug({ score: m.score?.toFixed(3), category: m.category ?? 'none', source: m.metadata?.source ?? 'unknown', content: m.content.slice(0, 120) }, 'Proactive memory result');
          }
        }
      }
    } catch (err) {
      log.error({ err }, 'Proactive memory recall failed (non-fatal)');
    }
  }

  // Check autonomous mode and inject automation context
  let enrichedAvailableContext = availableSkillContext;
  if (state.organizationId) {
    try {
      const { getOrgFeatureFlags } = await import('../../inngest/utils/feature-flags.js');
      const orgFlags = await getOrgFeatureFlags(state.organizationId);
      const autonomousEnabled = orgFlags.autonomous_mode?.enabled === true;
      const agentLedBlock = agentLedContextBlock(autonomousEnabled, orgFlags.guardrails);
      if (agentLedBlock) {
        enrichedAvailableContext = (enrichedAvailableContext || '') + agentLedBlock;
      }
    } catch (err) {
      log.error({ err }, 'Autonomous workflow context check failed (non-fatal)');
    }
  }

  return { contextSnapshot: snapshot, priorMemory, availableSkills, unavailableSkillContext, availableSkillContext: enrichedAvailableContext, missingIntegrations };
}

/**
 * Determine which skills are available based on connected integrations.
 * Skills without a requiredIntegration are always available.
 */
function computeAvailableSkills(integrations: UserIntegrations): {
  availableSkills: string[];
  unavailableSkillContext: string | null;
  availableSkillContext: string | null;
  missingIntegrations: Array<{ label: string; level: 'user' | 'org' }>;
} {
  const available: string[] = [];
  const unavailableLines: string[] = [];
  const availableDescriptions: string[] = [];
  const missing: Array<{ label: string; level: 'user' | 'org' }> = [];

  for (const manifest of registry.manifests()) {
    const req = manifest.requiredIntegration;
    if (!req) {
      // No integration required — always available
      available.push(manifest.name);
      availableDescriptions.push(`- ${manifest.description}`);
      continue;
    }

    if (integrations[req.id]) {
      available.push(manifest.name);
      availableDescriptions.push(`- ${manifest.description} (via ${req.label})`);
    } else {
      // Note: if a skill was excluded by isAvailable() (env-var gate),
      // it won't appear in registry.manifests() at all — no user-facing message needed.
      const levelHint = req.level === 'org'
        ? 'org-level integration'
        : 'user-level integration';
      unavailableLines.push(
        `- ${manifest.name} (requires ${req.label}, ${levelHint}): ${req.connectHint}`
      );
      // Deduplicate by label (e.g., calendar + sales both require Google)
      if (!missing.some((m) => m.label === req.label)) {
        missing.push({ label: req.label, level: req.level });
      }
    }
  }

  return {
    availableSkills: available,
    unavailableSkillContext: unavailableLines.length > 0
      ? unavailableLines.join('\n')
      : null,
    availableSkillContext: availableDescriptions.length > 0
      ? availableDescriptions.join('\n')
      : null,
    missingIntegrations: missing,
  };
}

async function classifyNode(state: SupervisorStateType) {
  // Force-domain fast-path: skip classification entirely when caller knows the domain(s).
  // Supports comma-separated domains for sequential chains, e.g. "enablement,sales"
  if (state.forceDomain) {
    const domains = state.forceDomain.split(',').map((d) => d.trim()).filter(Boolean);
    const isSequential = domains.length > 1;
    log.info({ domains, isSequential }, `Force-domain fast-path: [${domains.join(', ')}]${isSequential ? ' (sequential)' : ''}`);
    return {
      classification: {
        domains,
        primaryDomain: domains[0],
        reasoning: `force-domain — caller specified [${domains.join(', ')}] directly`,
        confidence: 1.0,
        needsClarification: false,
        sequential: isSequential,
      },
    };
  }

  const humanMessages = state.messages.filter((m: BaseMessage) => typeof m._getType === 'function' && m._getType() === 'human');
  const lastMessage = humanMessages[humanMessages.length - 1] || state.messages[state.messages.length - 1];
  const text = typeof lastMessage?.content === 'string'
    ? lastMessage.content
    : JSON.stringify(lastMessage?.content || '');

  // Greeting fast-path: skip classification entirely for short greetings
  if (isGreeting(text)) {
    log.info({ text }, 'Greeting fast-path');
    return {
      classification: {
        domains: ['conversational'],
        primaryDomain: 'conversational',
        reasoning: 'greeting fast-path — short conversational message',
        confidence: 0.95,
        needsClarification: false,
      },
    };
  }

  // Confirmation continuity: short affirmatives stay with the prior CRM domain
  if (isConfirmation(text)) {
    const priorDomain = detectPriorCrmDomain(state.messages);
    if (priorDomain) {
      log.info({ text, priorDomain }, `Confirmation fast-path: continuing with "${priorDomain}"`);
      return {
        classification: {
          domains: [priorDomain],
          primaryDomain: priorDomain,
          reasoning: `confirmation fast-path — continuing prior ${priorDomain} exchange`,
          confidence: 0.95,
          needsClarification: false,
        },
      };
    }
  }

  // Compute domain signals from regex patterns (soft hints, never hard-route)
  const signals = computeDomainSignals(text);
  const mergedSignals = mergeSignals(signals, state.domainSignals);
  // Skill gating: use only available skills for classification
  const available = state.availableSkills?.length > 0
    ? state.availableSkills
    : registry.names(); // fallback: all skills if not computed yet

  // Strip signals for unavailable skills so the classifier doesn't see misleading hints
  const availableSet = new Set(available);

  // Trivial fast-path: unambiguous single-domain signal (only available skills)
  const trivial = trivialFastPath(mergedSignals);
  if (trivial && available.includes(trivial)) {
    log.info({ domain: trivial }, 'Trivial fast-path (strong signal)');
    return {
      classification: {
        domains: [trivial],
        primaryDomain: trivial,
        reasoning: 'trivial fast-path — overwhelming single-domain signal',
        confidence: 0.9,
        needsClarification: false,
      },
    };
  }

  // LLM classification with signals as context — only available skills
  const llm = createLLM({ model: 'claude-haiku-4-5-20251001' });

  const classificationHints = registry.getClassificationHintsFiltered(available);

  // Build unavailable skills notice for the classifier
  let unavailableNotice = '';
  if (state.unavailableSkillContext) {
    unavailableNotice = `\n\nUNAVAILABLE skills (do NOT classify to these — the required integrations are not connected):\n${state.unavailableSkillContext}\nIf the user's request requires an unavailable skill, classify as "conversational".`;
  }

  const lastMessages = state.messages.slice(-5);
  const conversationContext = lastMessages
    .map((m) => {
      const role = m._getType() === 'human' ? 'User' : 'Sales Agent';
      return `${role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`;
    })
    .join('\n');

  const response = await llm.invoke([
    {
      role: 'system',
      content: [
        {
          type: 'text' as const,
          text: getClassificationPrompt({ domainSignals: mergedSignals, userTimezone: state.userTimezone, classificationHints }) + unavailableNotice,
          cache_control: { type: 'ephemeral' as const },
        },
      ],
    },
    {
      role: 'user',
      content: `Conversation context:\n${conversationContext}\n\nClassify the latest user message.`,
    },
  ]);

  const responseText = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);

  if (state.organizationId) {
    const usage = (response as WithUsageMetadata).usage_metadata;
    trackUsageEvent({
      orgId: state.organizationId,
      userId: state.userId,
      eventType: 'prompt',
      eventName: 'classification',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      tokensIn: usage?.input_tokens ?? 0,
      tokensOut: usage?.output_tokens ?? 0,
    });
  }

  let classification = {
    domains: ['enablement'] as string[],
    primaryDomain: 'enablement',
    reasoning: 'default fallback',
    confidence: 0.5,
    needsClarification: false,
    clarificationQuestion: undefined as string | undefined,
    sequential: false,
  };

  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);

      // Accept both new (agents/primaryAgent) and legacy (domains/primaryDomain) format
      const rawAgents: string[] = Array.isArray(parsed.agents)
        ? parsed.agents
        : Array.isArray(parsed.domains)
          ? parsed.domains
          : parsed.domain
            ? [parsed.domain]
            : ['enablement'];

      const validNames = registry.allValidNames();
      const normalizedAgents = rawAgents
        .map((name: string) => registry.normalize(name))
        .filter((a: string) => validNames.includes(a));

      const rawPrimary = parsed.primaryAgent || parsed.primaryDomain || parsed.domain || 'enablement';

      if (normalizedAgents.length === 0) {
        log.warn({ rawAgents }, 'All classified domains were invalid, falling back to enablement');
      }

      classification = {
        domains: normalizedAgents.length > 0 ? normalizedAgents : ['enablement'],
        primaryDomain: registry.normalize(rawPrimary),
        reasoning: parsed.reasoning || 'LLM classification',
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
        needsClarification: Boolean(parsed.needsClarification),
        clarificationQuestion: parsed.clarificationQuestion || undefined,
        sequential: Boolean(parsed.sequential),
      };

      // Strip 'conversational' when mixed with tool-requiring agents
      if (classification.domains.length > 1 && classification.domains.includes('conversational')) {
        classification.domains = classification.domains.filter((d: string) => d !== 'conversational');
        if (classification.primaryDomain === 'conversational') {
          classification.primaryDomain = classification.domains[0];
        }
      }
    }
  } catch (parseErr) {
    log.error({ err: parseErr, responseSnippet: responseText?.slice(0, 200) }, '[ALERT] Classification JSON parse failed, defaulting to enablement');
  }

  // Confidence-based clarification guard
  if (classification.confidence < 0.4 && !classification.needsClarification) {
    classification.needsClarification = true;
    classification.clarificationQuestion =
      classification.clarificationQuestion ||
      `I could help with this in a few ways. Did you want me to:\n` +
      classification.domains.map((d) => `- ${registry.getDomainDescriptions()[d] || d}`).join('\n');
  }

  // Apply composition rules from skill manifests to patch LLM misses (filtered to available skills)
  classification = applyCompositionRulesFiltered(classification, text, available);

  // Final safety net: strip any unavailable skills that slipped through
  classification.domains = classification.domains.filter((d: string) => availableSet.has(d));
  if (classification.domains.length === 0) {
    classification.domains = ['conversational'];
  }
  if (!availableSet.has(classification.primaryDomain)) {
    classification.primaryDomain = classification.domains[0];
  }

  log.info(
    { domains: classification.domains, primaryDomain: classification.primaryDomain, confidence: classification.confidence, clarify: classification.needsClarification, sequential: classification.sequential },
    `Classified as [${classification.domains.join(', ')}]: ${classification.reasoning}`
  );

  return { classification };
}

function routeFromClassification(state: SupervisorStateType): string | Send[] {
  const { classification } = state;
  if (!classification) return 'enablement';

  if (classification.needsClarification) return 'clarify';

  // Filter domains to only available skills (safety net — classifyNode already filters)
  const available = new Set(
    state.availableSkills?.length > 0 ? state.availableSkills : registry.names()
  );
  const domains = classification.domains.filter((d) => available.has(d));

  if (domains.length === 0) return 'conversational';
  if (domains.length === 1) return domains[0];

  // Sequential: run first agent, then chain to next via afterSpecialist edges
  if (classification.sequential) return domains[0];

  // Parallel: fan out all agents simultaneously
  return domains.map((agent) => new Send(agent, state));
}

async function clarifyNode(state: SupervisorStateType) {
  const question = state.classification?.clarificationQuestion
    || "I'm not sure what you're looking for. Could you tell me more about what you need help with?";

  return { subAgentResponse: question };
}

// ─── Skill runner ────────────────────────────────────────────────────────────

async function runSubAgent(
  state: SupervisorStateType,
  skillName: string,
  config?: RunnableConfig,
) {
  const { userId, organizationId, slackContext, messages, userName, userEmail, userCompany, userTitle, userPreferences, userTimezone } = state;
  const user = { name: userName, email: userEmail, company: userCompany, title: userTitle || null };
  const promptCtx = buildPromptContext(userTimezone);

  // Bot token is passed via configurable (not in LangGraph state) to avoid
  // credential exposure in checkpoints/logs.
  const botToken: string = (config?.configurable as Record<string, unknown>)?.botToken as string || '';

  // Shared MCP client scope — all Granola tools within this skill run
  // reuse a single connection instead of each creating their own (~1-2s saved per extra call).
  const granolaScope = new GranolaClientScope();

  // Build SkillContext
  const memoryService = getMemoryService();
  const skillCtx: SkillContext = {
    userId, organizationId, user, promptCtx,
    userPreferences: userPreferences || null,
    slackContext: { ...slackContext, botToken }, granolaScope, userTimezone,
    memoryService,
    unavailableSkillContext: state.unavailableSkillContext,
    availableSkillContext: state.availableSkillContext,
  };

  // Inject prior agent responses for sequential chains
  let agentMessages = messages;
  if (state.classification?.sequential && Object.keys(state.subAgentResponses || {}).length > 0) {
    const priorContext = Object.entries(state.subAgentResponses)
      .map(([agent, response]) => `[${agent} findings]:\n${response}`)
      .join('\n\n');
    agentMessages = [
      ...messages,
      new HumanMessage(`Context from prior research:\n${priorContext}`),
    ];
  }

  // Inject proactive memory recall (searched in loadContextNode).
  // Uses HumanMessage with clear framing so the LLM treats this as context, not user intent.
  // Note: cannot use SystemMessage here — Anthropic requires system messages to be first,
  // and createReactAgent already adds its own system prompt via messageModifier.
  if (state.priorMemory) {
    agentMessages = [
      new HumanMessage(`[System context — prior memory recall. Use if relevant, ignore if not.]\n${state.priorMemory}`),
      ...agentMessages,
    ];
  }

  // Registry lookup replaces the old switch statement
  const skill = registry.resolve(skillName);
  if (!skill) {
    log.error({ skillName }, 'Unknown skill, falling back to enablement');
    const fallback = registry.resolve('enablement')!;
    return runSkillAgent(fallback, 'enablement', skillCtx, agentMessages, state);
  }
  return runSkillAgent(skill, skillName, skillCtx, agentMessages, state);
}

async function runSkillAgent(
  skill: import('../skills/types.js').SkillDefinition,
  skillName: string,
  skillCtx: SkillContext,
  agentMessages: import('@langchain/core/messages').BaseMessage[],
  state: SupervisorStateType,
) {
  const { userId, organizationId } = skillCtx;

  // Memory tool injection: if skill declares canRead, augment its tools with memory_search + save_user_fact
  let injectedTools: StructuredToolInterface[] | undefined;
  if (skill.manifest.memory?.canRead) {
    const memScope: MemoryScope = {
      userId: skillCtx.userId,
      organizationId: skillCtx.organizationId,
      skillNamespace: skill.manifest.memory.useSkillNamespace ? skill.manifest.name : undefined,
    };
    const baseTools = skill.tools(skillCtx);
    injectedTools = [
      ...baseTools,
      createMemorySearchTool(skillCtx.memoryService, memScope),
      createSaveUserFactTool(skillCtx.userId, skillCtx.organizationId),
      createDeleteUserFactTool(skillCtx.userId, skillCtx.organizationId),
      createRecordFeedbackTool(skillCtx.userId, skillCtx.organizationId),
    ];
  }

  const finalTools = injectedTools || skill.tools(skillCtx);
  const agent = skill.createAgent
    ? skill.createAgent(skillCtx, finalTools)
    : createSkillAgent(skill, skillCtx, finalTools);

  // Start workflow run
  const workflowKindMap = registry.getWorkflowKindMap();
  let workflowRunId: string | null = null;
  if (organizationId) {
    workflowRunId = await startWorkflowRun({
      orgId: organizationId,
      userId,
      workflowKind: workflowKindMap[skillName] as WorkflowKind,
    });
  }

  const SUB_AGENT_TIMEOUT_MS = 90_000;
  const recursionLimit = skill.manifest.recursionLimit || 10;

  try {
    const result = await invokeWithRetry(agent, agentMessages, recursionLimit, SUB_AGENT_TIMEOUT_MS, skillName);

    const aiMessages = result.messages.filter((m: BaseMessage) => m._getType() === 'ai');

    // Find the last AI message with actual text content (not just tool_use blocks)
    let responseText = '';
    for (let i = aiMessages.length - 1; i >= 0; i--) {
      const content = aiMessages[i]?.content;
      if (typeof content === 'string' && content.trim()) {
        responseText = content;
        break;
      }
      if (Array.isArray(content)) {
        const textParts = content
          .filter((block: TextContentBlock) => block.type === 'text' && block.text?.trim())
          .map((block: TextContentBlock) => block.text);
        if (textParts.length > 0) {
          responseText = textParts.join('\n');
          break;
        }
      }
    }
    if (!responseText) {
      responseText = `I searched for information but couldn't formulate a complete answer. Please try rephrasing your question.`;
    }

    // Fire-and-forget prompt tracking
    if (organizationId) {
      let totalIn = 0;
      let totalOut = 0;
      for (const m of aiMessages) {
        const usage = (m as WithUsageMetadata).usage_metadata;
        if (usage) {
          totalIn += usage.input_tokens ?? 0;
          totalOut += usage.output_tokens ?? 0;
        }
      }
      trackUsageEvent({
        orgId: organizationId,
        userId,
        eventType: 'prompt',
        eventName: `sub_agent_${skillName}`,
        provider: 'anthropic',
        model: skill.manifest.model || 'claude-sonnet-4-20250514',
        tokensIn: totalIn,
        tokensOut: totalOut,
        workflowRunId,
      });
    }

    if (workflowRunId) {
      completeWorkflowRun({ workflowRunId, status: 'succeeded' });
    }

    // Auto-save to long-term memory for skills with canWrite
    if (skill.manifest.memory?.canWrite && responseText) {
      const lastHuman = agentMessages.filter((m: BaseMessage) => m._getType() === 'human').pop();
      const userText = typeof lastHuman?.content === 'string' ? lastHuman.content : '';
      if (userText) {
        const memScope: MemoryScope = {
          userId: skillCtx.userId,
          organizationId: skillCtx.organizationId,
          skillNamespace: skill.manifest.memory.useSkillNamespace ? skill.manifest.name : undefined,
        };
        const memMessages = [
          { role: 'user', content: userText },
          { role: 'assistant', content: responseText },
        ];
        const saveSource = skillCtx.slackContext?.channelId ? 'slack' : 'web';
        log.info({ skillName, source: saveSource, userSnippet: userText.slice(0, 80), responseSnippet: responseText.slice(0, 80) }, `Auto-saving ${skillName} turn`);
        skillCtx.memoryService.save(memScope, memMessages, {
          category: 'conversation',
          metadata: {
            source: saveSource,
            channelId: skillCtx.slackContext?.channelId,
            threadTs: skillCtx.slackContext?.threadTs,
          },
        }).catch((err) => {
          log.error({ err, skillName }, `Auto-save failed for ${skillName} (will retry next turn)`);
        });
      }
    }

    return { subAgentResponses: { [skillName]: responseText }, messages: result.messages };
  } catch (err: unknown) {
    if (workflowRunId) {
      completeWorkflowRun({ workflowRunId, status: 'failed', errorMessage: err instanceof Error ? err.message : String(err) });
    }
    log.error({ err, skillName }, `${skillName} skill error`);

    // Sanitize error for user — never expose internal details
    const errObj = err as Record<string, unknown>;
    let userMessage: string;
    if (errObj?.lc_error_code === 'GRAPH_RECURSION_LIMIT') {
      userMessage = "I got a bit tangled up processing that — could you try rephrasing?";
    } else if (err instanceof Error && err.message.includes('timed out')) {
      userMessage = "That took longer than expected. Could you try again or simplify your request?";
    } else {
      userMessage = "I ran into an issue processing your request. Please try again.";
    }

    return {
      subAgentResponses: {
        [skillName]: userMessage,
      },
    };
  } finally {
    // Close shared Granola MCP connection (no-op if never used)
    await skillCtx.granolaScope.closeAll();
  }
}

// ─── Signal merging helper ──────────────────────────────────────────────────

function mergeSignals(
  local: Record<string, number>,
  upstream: Record<string, number> | null | undefined
): Record<string, number> {
  if (!upstream) return local;
  const merged: Record<string, number> = { ...local };
  for (const [key, value] of Object.entries(upstream)) {
    merged[key] = (merged[key] || 0) + value;
  }
  return merged;
}

// ─── Synthesis node ─────────────────────────────────────────────────────────

async function synthesizeNode(state: SupervisorStateType) {
  const responses = state.subAgentResponses || {};
  const agents = Object.keys(responses);

  if (agents.length === 0) {
    return { subAgentResponse: null };
  }

  const lastHuman = state.messages.filter((m: BaseMessage) => m._getType() === 'human').pop();
  const userQuery = typeof lastHuman?.content === 'string'
    ? lastHuman.content
    : JSON.stringify(lastHuman?.content || '');

  let responseText: string;

  if (agents.length === 1) {
    responseText = responses[agents[0]];
  } else if (state.classification?.sequential) {
    // Sequential chains need LLM deduplication — later agents depend on earlier ones
    try {
      const llm = createLLM({ model: 'claude-sonnet-4-20250514', maxTokens: 4096 });

      const toolOutputs = extractToolOutputTexts(state.messages);
      const toolBlock = toolOutputs.length > 0
        ? `\n\nRaw tool outputs (use these to assess evidence quality):\n${toolOutputs.join('\n---\n')}`
        : '';

      const agentBlocks = agents
        .map((d) => `--- ${d.toUpperCase()} AGENT ---\n${responses[d]}`)
        .join('\n\n');

      const SYNTHESIS_TIMEOUT_MS = 30_000;
      const result = await Promise.race([
        llm.invoke([
          {
            role: 'system',
            content: `You are synthesizing answers from multiple specialist agents into one coherent response for a B2B sales user.

Rules:
- Combine all unique findings into a single, well-organized answer.
- Remove duplicate information that appears in multiple agent responses.
- Preserve all unique facts, data points, and actionable items from each agent.
- If agents provide conflicting information, present the most recent authoritative source as primary and note the discrepancy.
- Maintain the concise, confident tone of a top-performing AE.
- Do NOT mention that multiple agents were involved — present a unified answer.
- Flag any claims that lack strong backing from the tool data.

Agent responses:
${agentBlocks}${toolBlock}`,
          },
          { role: 'user', content: userQuery },
        ]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Synthesis timed out after 30s')), SYNTHESIS_TIMEOUT_MS)
        ),
      ]);

      if (state.organizationId) {
        const usage = (result as WithUsageMetadata).usage_metadata;
        trackUsageEvent({
          orgId: state.organizationId,
          userId: state.userId,
          eventType: 'prompt',
          eventName: 'synthesis',
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          tokensIn: usage?.input_tokens ?? 0,
          tokensOut: usage?.output_tokens ?? 0,
        });
      }

      responseText = typeof result.content === 'string'
        ? result.content
        : JSON.stringify(result.content);
    } catch (err) {
      log.error({ err }, 'Synthesis LLM error, falling back to concatenation');
      responseText = agents
        .map((d) => `**${registry.getDomainDescriptions()[d] || d}:**\n${responses[d]}`)
        .join('\n\n');
    }
  } else {
    // Parallel agents: simple concatenation — sub-agents already produce final prose
    responseText = agents
      .map((d) => responses[d])
      .join('\n\n---\n\n');
  }

  // Run LLM evidence assessment on tool outputs — skip for single-agent or high-confidence to save 3-5s
  const toolOutputs = extractToolOutputTexts(state.messages);
  const confidence = state.classification?.confidence ?? 0;
  if (toolOutputs.length === 0 || agents.length === 1 || confidence >= 0.85) {
    return { subAgentResponse: responseText };
  }

  try {
    const assessment = await runEvidenceAssessment(userQuery, responseText, toolOutputs, state.organizationId, state.userId);
    return { subAgentResponse: responseText, evidenceAssessment: assessment };
  } catch (err) {
    log.error({ err }, 'Evidence assessment error (non-fatal)');
    return { subAgentResponse: responseText };
  }
}

function extractToolOutputTexts(messages: BaseMessage[]): string[] {
  const outputs: string[] = [];
  for (const m of messages) {
    if (typeof m._getType === 'function' && m._getType() === 'tool') {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      if (text && text.length > 10) {
        outputs.push(text.length > 2000 ? text.slice(0, 2000) + '...(truncated)' : text);
      }
    }
  }
  return outputs;
}

const EVIDENCE_ASSESSMENT_PROMPT = `You are evaluating the evidence quality of an AI sales assistant's response.

Given the user's query, the assistant's response, and the raw tool outputs, assess:

1. Confidence: How well-supported is the response by the tool data?
   - "high": All key claims directly backed by tool data
   - "medium": Most claims backed but some gaps or inferences
   - "low": Response makes claims not well-supported by tool data
   Also provide a numeric score from 0.0 to 1.0.

2. Sources: List the key data sources found in tool outputs (emails, meetings, calendar events, documents, etc.) with their type, how recent they are, and how directly relevant they are to the query.

3. Conflicts: Are any data points from different sources contradicting each other? If so, identify the topic, what the newer source says, what the older source says, and which is most likely current.

4. Key findings: What are the most important facts established by the tool data?

5. Weak points: What claims in the response lack strong backing from the tool data? (null if everything is well-supported)

Respond with JSON only matching this exact schema:
{
  "confidence": "high" | "medium" | "low",
  "confidenceScore": 0.0-1.0,
  "hasConflicts": boolean,
  "sources": [{ "title": string, "type": string, "recency": "current"|"recent"|"older"|"stale", "relevance": "direct"|"supporting"|"tangential" }],
  "conflicts": [{ "topic": string, "newer": string, "older": string, "assessment": string }],
  "keyFindings": [string],
  "weakPoints": string | null
}`;

async function runEvidenceAssessment(
  query: string,
  response: string,
  toolOutputs: string[],
  organizationId: string | null,
  userId: string,
): Promise<EvidenceAssessment | null> {
  const llm = createLLM({ model: 'claude-haiku-4-5-20251001', maxTokens: 1024 });

  const result = await llm.invoke([
    {
      role: 'system',
      content: [
        { type: 'text' as const, text: EVIDENCE_ASSESSMENT_PROMPT, cache_control: { type: 'ephemeral' as const } },
      ],
    },
    {
      role: 'user',
      content: `User query: "${query}"

Tool outputs:
${toolOutputs.join('\n---\n')}

Assistant's response:
${response}`,
    },
  ]);

  if (organizationId) {
    const usage = (result as WithUsageMetadata).usage_metadata;
    trackUsageEvent({
      orgId: organizationId,
      userId,
      eventType: 'prompt',
      eventName: 'evidence_assessment',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      tokensIn: usage?.input_tokens ?? 0,
      tokensOut: usage?.output_tokens ?? 0,
    });
  }

  const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium',
      confidenceScore: typeof parsed.confidenceScore === 'number' ? Math.min(1, Math.max(0, parsed.confidenceScore)) : 0.5,
      hasConflicts: Boolean(parsed.hasConflicts),
      sources: Array.isArray(parsed.sources) ? parsed.sources.slice(0, 10) : [],
      conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts.slice(0, 5) : [],
      keyFindings: Array.isArray(parsed.keyFindings) ? parsed.keyFindings.slice(0, 10) : [],
      weakPoints: typeof parsed.weakPoints === 'string' ? parsed.weakPoints : null,
    };
  } catch {
    log.error('Failed to parse evidence assessment JSON');
    return null;
  }
}
