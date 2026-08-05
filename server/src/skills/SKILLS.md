# Sales Agent Skills Architecture

This document is a guide for developers working on Sales Agent's skill-based agent system. It covers what each skill does, how skills are created, and how to add new ones.

## How It Works

Sales Agent uses a **supervisor → skill** architecture. When a user sends a message:

1. **Classify** — An LLM routes the message to one or more skills based on intent
2. **Route** — Skills run in parallel (default) or sequentially (if composition rules dictate)
3. **Execute** — Each skill creates a ReAct agent with its own tools and prompt
4. **Synthesize** — If multiple skills ran, their responses are merged into one answer

Skills are self-describing — each declares its tools, prompt, model, triggers, memory config, and composition rules in a single file. The supervisor reads from a **SkillRegistry** instead of hardcoded constants.

## Architecture Diagram

```
User Message
    |
    v
[Supervisor Graph]
    |
    +-- loadContext (pre-fetch user/deal/account context, cached 5min)
    |
    +-- classify (LLM routes to 1+ skills, or greeting fast-path)
    |
    +-- [Skill Nodes] (parallel or sequential)
    |       |
    |       +-- Memory injection (auto-inject memory_search if canRead)
    |       +-- Agent creation (shared factory or custom)
    |       +-- Tool execution (ReAct loop)
    |       +-- Memory save (auto-save if canWrite)
    |
    +-- synthesize (merge multi-skill responses)
    |
    v
Response
```

## Skill Definitions

### Sales

**File:** `definitions/sales.skill.ts`

| | |
|-|-|
| **Purpose** | Email, calendar, contacts, CRM, deal activity |
| **Model** | Sonnet (default) |
| **Memory** | Read + Write |
| **Factory** | Shared (`createSkillAgent`) |
| **Workflow** | `deal_followup` |

**Tools:** Gmail search/draft/send, calendar search/create, contact lookup, context KB, Granola search/get, Salesforce tools (when available)

**Composition rules:**
- "What's the latest with X" → also activates **transcript**
- "Thinking about / tell me about X" → also activates **prospecting**

---

### Calendar

**File:** `definitions/calendar.skill.ts`

| | |
|-|-|
| **Purpose** | Schedule lookup, event creation/update/delete |
| **Model** | Sonnet (default) |
| **Memory** | None |
| **Factory** | Shared (`createSkillAgent`) |
| **Workflow** | `calendar_query` |

**Tools:** calendar_search, calendar_create, calendar_update, calendar_delete

**Composition rules:**
- "Next meeting" + "research/linkedin/who is" → also activates **prospecting** (sequential)
- Calendar context + "follow-up/email/send" → also activates **sales**

---

### Transcript

**File:** `definitions/transcript.skill.ts`

| | |
|-|-|
| **Purpose** | Granola meeting notes search and retrieval |
| **Model** | Haiku |
| **Memory** | None |
| **Factory** | Shared (`createSkillAgent`) |
| **Workflow** | `transcript_query` |

**Tools:** granola_search_meetings, granola_get_meeting (no granola_query — it's too slow)

**Composition rules:**
- "Prep me for meeting/call" → also activates **prospecting** + **sales**

---

### Enablement

**File:** `definitions/enablement.skill.ts`

| | |
|-|-|
| **Purpose** | Knowledge base, shareable docs, Google Drive |
| **Model** | Haiku |
| **Memory** | Read only |
| **Factory** | Shared (`createSkillAgent`) |
| **Workflow** | `knowledge_query` |
| **Aliases** | `knowledge` |

**Tools:** context_kb_search, shareable_docs_search, drive_search

**Composition rules:**
- KB topic + "meeting/call/discussed" → also activates **transcript**

---

### Prospecting

**File:** `definitions/prospecting.skill.ts`

| | |
|-|-|
| **Purpose** | Web research on people, companies, stakeholders |
| **Model** | Sonnet (default) |
| **Memory** | Read + Write |
| **Factory** | Shared (`createSkillAgent`) |
| **Workflow** | `deep_research` |
| **Aliases** | `research` |

**Tools:** exa_research, slack_history (+ memory_search auto-injected)

**Composition rules:**
- "Research X then draft/send" → also activates **sales** (sequential)

---

### Salesforce

**File:** `definitions/salesforce.skill.ts`

| | |
|-|-|
| **Purpose** | Salesforce CRM queries and updates |
| **Model** | Haiku |
| **Memory** | None |
| **Factory** | Custom (`buildSalesforceGraph`) |
| **Workflow** | `salesforce_query` |
| **Availability** | Only when `isSalesforceConfigured()` returns true (env vars) |

**Tools:** All SFDC tools (account lookup, opportunities, contacts, etc.)

**Note:** Uses its own LangGraph instead of the shared factory because it has a separate graph builder in `server/src/salesforce/agent/graph.ts`.

---

### Attio

**File:** `definitions/attio.skill.ts`

| | |
|-|-|
| **Purpose** | Attio CRM queries, deals, notes, tasks |
| **Model** | Haiku |
| **Memory** | None |
| **Factory** | Custom (`buildAttioGraph`) |
| **Workflow** | `attio_query` |
| **Availability** | Always registered (per-org DB check at runtime) |

**Tools:** 10 read tools (company/people lookup, deals, lists, notes, tasks, emails, meetings, calls) + 4 write tools (update-deal, create-deal, create-task, create-note)

**Note:** Unlike Salesforce (server-level env vars), Attio availability is per-org (DB credentials). Always registered; tools handle missing credentials at runtime.

---

### Conversational

**File:** `definitions/conversational.skill.ts`

| | |
|-|-|
| **Purpose** | Greetings, thanks, meta-questions, casual chat |
| **Model** | Haiku |
| **Temperature** | 0.7 (higher for natural tone) |
| **Max Tokens** | 300 |
| **Memory** | None |
| **Factory** | Custom (raw LLM invoke, no ReAct) |
| **Workflow** | `conversational` |

**Tools:** None

**Note:** Uses a greeting fast-path (regex match, skips LLM classification entirely for short messages like "Hey!" or "Thanks"). Uses raw `ChatAnthropic.invoke()` instead of `createReactAgent` because no tools are needed. Custom `createAgent` wraps the result in `AIMessage` for uniform handling by the supervisor.

---

## Memory System

Skills opt into long-term memory via manifest config:

```typescript
memory: {
  canRead: true,   // Supervisor auto-injects memory_search tool
  canWrite: true,  // Supervisor auto-saves conversation turn after execution
}
```

| Skill | Read | Write | Rationale |
|-------|------|-------|-----------|
| Sales | Yes | Yes | Cross-session deal context |
| Prospecting | Yes | Yes | Research builds over time |
| Enablement | Yes | No | Reads context, but KB queries aren't worth saving |
| Others | No | No | Stateless or real-time data |

Memory is org-scoped via composite ID (`userId::orgId`) to prevent cross-org leakage.

## Adding a New Skill

1. **Create** `definitions/your-skill.skill.ts`:

```typescript
import type { SkillDefinition } from '../types.js';

export const yourSkill: SkillDefinition = {
  manifest: {
    name: 'your-skill',
    description: 'What it does in one line',
    classificationHint: '"your-skill": When to route here. Examples: "..."',
    triggers: [{
      type: 'intent',
      patterns: [/\b(?:keyword1|keyword2)\b/i],
    }],
    model: 'claude-haiku-4-5-20251001', // or omit for Sonnet default
    workflowKind: 'your_workflow_kind',
    // memory: { canRead: true, canWrite: true }, // optional
    // compositionRules: [...], // optional
    // aliases: ['legacy-name'], // optional
    // isAvailable: () => someCheck(), // optional, must be sync
  },

  tools: (ctx) => yourTools(ctx.userId, ctx.organizationId),

  promptFragment: (ctx) => yourPrompt(ctx.user, ctx.promptCtx, ctx.userPreferences),

  // Only needed for non-standard agents (custom graphs, no-tool LLM invoke)
  // createAgent: (ctx, tools?) => buildYourGraph(...),
};
```

2. **Register** in `definitions/index.ts`:

```typescript
import { yourSkill } from './your-skill.skill.js';

export const allSkills: SkillDefinition[] = [
  // ... existing skills
  yourSkill,
  conversationalSkill, // keep conversational last
];
```

3. **Build and verify**: `pnpm exec tsc --noEmit --project server/tsconfig.json`

4. **Test**: Send a message that matches your skill's triggers and verify routing.

The skill will automatically get:
- Registered in the supervisor's LangGraph
- Dynamic signal patterns for classification hints
- Composition rules applied post-classification
- Memory injection if declared
- Usage tracking via workflow kind
- Agent creation via the shared factory (unless you provide `createAgent`)

## Key Files

| File | Purpose |
|------|---------|
| `types.ts` | SkillDefinition, SkillManifest, SkillContext interfaces |
| `registry.ts` | SkillRegistry singleton — dynamic skill catalog |
| `create-skill-agent.ts` | Shared agent factory (model/temp from manifest, cache control) |
| `definitions/index.ts` | Barrel export of all skills |
| `definitions/*.skill.ts` | Individual skill definitions |

## Model Selection Guide

| Use Case | Model | Why |
|----------|-------|-----|
| Complex reasoning, multi-tool orchestration | Sonnet (default) | Better at planning tool call sequences |
| Simple retrieval, CRM queries, KB search | Haiku | Faster, cheaper, sufficient for structured data |
| Casual conversation | Haiku + temp 0.7 | Fast, natural tone |
