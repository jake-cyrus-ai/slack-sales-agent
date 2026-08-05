/**
 * Salesforce Agent — messages-based LangGraph state annotation.
 *
 * Uses the standard messages reducer so the graph is conversational and
 * composable as a subgraph inside larger graphs.
 */

import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';

export const SalesforceAgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
});

export type SalesforceAgentStateType = typeof SalesforceAgentState.State;
