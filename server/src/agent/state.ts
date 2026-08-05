/**
 * LangGraph shared state annotation.
 */

import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';
import type { ContextSnapshot } from './context-graph.js';

export interface EvidenceSource {
  title: string;
  type: string;
  recency: 'current' | 'recent' | 'older' | 'stale';
  relevance: 'direct' | 'supporting' | 'tangential';
}

export interface EvidenceConflict {
  topic: string;
  newer: string;
  older: string;
  assessment: string;
}

export interface EvidenceAssessment {
  confidence: 'high' | 'medium' | 'low';
  confidenceScore: number;
  hasConflicts: boolean;
  sources: EvidenceSource[];
  conflicts: EvidenceConflict[];
  keyFindings: string[];
  weakPoints: string | null;
}

export const SupervisorState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  userId: Annotation<string>(),
  organizationId: Annotation<string | null>(),
  userName: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  userEmail: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  userCompany: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  userTitle: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  classification: Annotation<{
    domains: string[];
    primaryDomain: string;
    reasoning: string;
    confidence: number;
    needsClarification: boolean;
    clarificationQuestion?: string;
    sequential?: boolean;
  } | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  subAgentResponse: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  subAgentResponses: Annotation<Record<string, string>>({
    reducer: (prev, next) => ({ ...prev, ...next }),
    default: () => ({}),
  }),
  slackContext: Annotation<{
    channelId: string;
    threadTs: string;
  }>(),
  domainSignals: Annotation<Record<string, number> | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  forceDomain: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  userPreferences: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  userTimezone: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  evidenceAssessment: Annotation<EvidenceAssessment | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  contextSnapshot: Annotation<ContextSnapshot | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  priorMemory: Annotation<string | null>({
    reducer: (_prev, next) => next ?? _prev,
    default: () => null,
  }),
  /** Skills available for this user based on connected integrations */
  availableSkills: Annotation<string[]>({
    reducer: (_prev, next) => next ?? _prev,
    default: () => [],
  }),
  /** Human-readable context about disconnected integrations for agent guidance */
  unavailableSkillContext: Annotation<string | null>({
    reducer: (_prev, next) => next ?? _prev,
    default: () => null,
  }),
  /** Human-readable context about connected capabilities for agent guidance */
  availableSkillContext: Annotation<string | null>({
    reducer: (_prev, next) => next ?? _prev,
    default: () => null,
  }),
  /** Structured info about disconnected integrations for connect buttons */
  missingIntegrations: Annotation<Array<{ label: string; level: 'user' | 'org' }>>({
    reducer: (_prev, next) => next ?? _prev,
    default: () => [],
  }),
});

export type SupervisorStateType = typeof SupervisorState.State;
