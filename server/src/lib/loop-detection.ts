/**
 * Tool loop detection for LangGraph ReAct agents.
 *
 * Detects when an agent repeatedly calls the same tool with identical arguments
 * (a stuck loop) and intervenes:
 *  - Warning at WARN_AFTER consecutive identical calls
 *  - Hard stop at STOP_AFTER consecutive identical calls
 *
 * Also detects ping-pong patterns (A-B-A-B).
 *
 * Integrates via createReactAgent's `preModelHook` parameter.
 */

import { SystemMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';

// ─── Thresholds ──────────────────────────────────────────────────────────────

const WARN_AFTER = 3;
const STOP_AFTER = 5;
const HISTORY_WINDOW = 20; // Max messages to scan backwards

// ─── Helpers ─────────────────────────────────────────────────────────────────

function callHash(name: string, args: any): string {
  return `${name}:${JSON.stringify(args)}`;
}

/**
 * Extract recent tool call hashes from message history.
 * Walks backwards through messages, pairing AIMessage tool_calls with their ToolMessage responses.
 */
function extractRecentCallHashes(messages: BaseMessage[]): string[] {
  const hashes: string[] = [];
  const window = messages.slice(-HISTORY_WINDOW);

  for (const msg of window) {
    // AIMessage with tool_calls contains the name + args
    if (msg._getType() === 'ai') {
      const toolCalls = (msg as any).tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (tc.name) {
            hashes.push(callHash(tc.name, tc.args ?? {}));
          }
        }
      }
    }
  }

  return hashes;
}

/**
 * Count consecutive identical hashes at the end of the array.
 */
function countTrailingRepeats(hashes: string[]): number {
  if (hashes.length === 0) return 0;
  const last = hashes[hashes.length - 1];
  let count = 0;
  for (let i = hashes.length - 1; i >= 0; i--) {
    if (hashes[i] === last) count++;
    else break;
  }
  return count;
}

/**
 * Detect ping-pong pattern (A-B-A-B) at the end of the array.
 * Returns the number of complete cycles (2 = A-B-A-B).
 */
function countPingPongCycles(hashes: string[]): number {
  if (hashes.length < 4) return 0;
  const a = hashes[hashes.length - 2];
  const b = hashes[hashes.length - 1];
  if (a === b) return 0; // Not a ping-pong, it's a direct repeat

  let cycles = 0;
  for (let i = hashes.length - 1; i >= 1; i -= 2) {
    if (hashes[i] === b && hashes[i - 1] === a) {
      cycles++;
    } else {
      break;
    }
  }
  return cycles;
}

/**
 * Count how many times any single hash appears across the whole window.
 * Returns the max frequency found. Catches non-consecutive duplicates (A-B-A).
 */
function maxHashFrequency(hashes: string[]): { hash: string; count: number } {
  const freq = new Map<string, number>();
  let maxHash = '';
  let maxCount = 0;
  for (const h of hashes) {
    const c = (freq.get(h) || 0) + 1;
    freq.set(h, c);
    if (c > maxCount) {
      maxCount = c;
      maxHash = h;
    }
  }
  return { hash: maxHash, count: maxCount };
}

// ─── Hook factory ────────────────────────────────────────────────────────────

const LOOP_WARNING = `WARNING: You are repeating the same tool call with identical arguments. The tool already returned a result for this exact call — repeating it will not produce new information. Either:
1. Formulate your answer from the information you already have
2. Try a DIFFERENT tool or DIFFERENT parameters
3. Tell the user what you found so far and what you cannot determine`;

const PINGPONG_WARNING = `WARNING: You are alternating between the same two tool calls repeatedly (ping-pong pattern). This loop will not produce new information. Stop calling these tools and formulate your answer from the data you already have.`;

const SCATTERED_LOOP_WARNING = `WARNING: You have called the same tool with identical arguments multiple times in this turn (even if not consecutively). The tool result will be the same each time — use the data you already have instead of re-calling.`;

/**
 * Create a preModelHook for createReactAgent that detects tool call loops.
 *
 * Returns a function compatible with LangGraph's preModelHook signature:
 *   (state) => { llmInputMessages?: BaseMessage[] }
 */
export function createLoopDetectionHook() {
  return (state: { messages: BaseMessage[]; llmInputMessages: BaseMessage[] }) => {
    const hashes = extractRecentCallHashes(state.messages);
    if (hashes.length === 0) return {};

    const repeats = countTrailingRepeats(hashes);
    const pingPongCycles = countPingPongCycles(hashes);

    // Hard stop: too many consecutive identical calls
    if (repeats >= STOP_AFTER) {
      throw new Error(
        `Tool loop detected: the same tool call was repeated ${repeats} times consecutively. Stopping to prevent token waste.`,
      );
    }

    // Hard stop: too many ping-pong cycles
    if (pingPongCycles >= STOP_AFTER) {
      throw new Error(
        `Tool ping-pong loop detected: two tools alternated ${pingPongCycles} times. Stopping to prevent token waste.`,
      );
    }

    // Warning: approaching loop threshold
    if (repeats >= WARN_AFTER) {
      return {
        llmInputMessages: [
          ...state.llmInputMessages,
          new SystemMessage(LOOP_WARNING),
        ],
      };
    }

    // Warning: ping-pong pattern
    if (pingPongCycles >= 2) {
      return {
        llmInputMessages: [
          ...state.llmInputMessages,
          new SystemMessage(PINGPONG_WARNING),
        ],
      };
    }

    // Warning: non-consecutive duplicates (A-B-A pattern)
    const { count: maxFreq } = maxHashFrequency(hashes);
    if (maxFreq >= WARN_AFTER) {
      return {
        llmInputMessages: [
          ...state.llmInputMessages,
          new SystemMessage(SCATTERED_LOOP_WARNING),
        ],
      };
    }

    return {};
  };
}
