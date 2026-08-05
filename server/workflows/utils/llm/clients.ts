/**
 * LLM Client Utilities
 * 
 * Centralized LLM client configuration for Vercel Workflow functions.
 * Provides pre-configured clients for OpenAI, Anthropic, and other AI services.
 */

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../../../lib/logger";

const log = logger.child({ util: "llm-clients" });

/**
 * Hard timeout for every LLM request. Without it the Anthropic/OpenAI SDKs can
 * hang indefinitely, which stalls the wrapping Vercel Workflow step and holds a
 * concurrency slot — freezing all processing for that user.
 */
const LLM_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Get OpenAI client instance (lazy module singleton — avoids a new connection
 * pool per call).
 */
let _openaiClient: OpenAI | null = null;
export function getOpenAIClient(): OpenAI {
  if (_openaiClient) return _openaiClient;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is not set");
  }

  _openaiClient = new OpenAI({ apiKey });
  return _openaiClient;
}

/**
 * Get Anthropic client instance (lazy module singleton — avoids a new
 * connection pool per call).
 */
let _anthropicClient: Anthropic | null = null;
export function getAnthropicClient(): Anthropic {
  if (_anthropicClient) return _anthropicClient;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is not set");
  }

  _anthropicClient = new Anthropic({ apiKey });
  return _anthropicClient;
}

/**
 * Generate embedding using OpenAI
 */
export async function generateEmbedding(
  text: string,
  model: string = "text-embedding-3-small"
): Promise<number[]> {
  const openai = getOpenAIClient();
  
  const response = await openai.embeddings.create(
    { model, input: text },
    { timeout: LLM_REQUEST_TIMEOUT_MS },
  );
  
  return response.data[0].embedding;
}

/**
 * Generate chat completion using OpenAI
 */
export async function generateChatCompletion(
  messages: OpenAI.ChatCompletionMessageParam[],
  options: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    tools?: OpenAI.ChatCompletionTool[];
  } = {}
): Promise<OpenAI.ChatCompletion> {
  const openai = getOpenAIClient();
  
  return await openai.chat.completions.create(
    {
      model: options.model || "gpt-4-turbo-preview",
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens,
      tools: options.tools,
    },
    { timeout: LLM_REQUEST_TIMEOUT_MS },
  );
}

/**
 * Generate message using Anthropic Claude
 */
export async function generateClaudeMessage(
  messages: Anthropic.MessageParam[],
  options: {
    // Required — there is no default. A silent default (previously Opus) means a
    // forgotten model parameter blows up cost ~15x and latency with no signal.
    model: string;
    system?: string;
    maxTokens?: number;
    temperature?: number;
    tools?: Anthropic.Tool[];
  },
): Promise<Anthropic.Message> {
  const anthropic = getAnthropicClient();

  return await anthropic.messages.create(
    {
      model: options.model,
      messages,
      system: options.system,
      max_tokens: options.maxTokens || 4096,
      temperature: options.temperature ?? 1.0,
      tools: options.tools,
    },
    { timeout: LLM_REQUEST_TIMEOUT_MS },
  );
}

/**
 * Parse JSON from LLM response, handling markdown code blocks
 */
export function parseJSONResponse<T = any>(response: string): T {
  // Remove markdown code blocks if present
  let cleaned = response.trim();
  
  // Remove ```json or ``` wrappers
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    log.error({ response: cleaned }, "Failed to parse JSON response");
    throw new Error(`Invalid JSON response from LLM: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}
