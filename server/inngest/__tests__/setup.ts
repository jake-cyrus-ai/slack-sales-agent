/**
 * Test Setup for Inngest Functions
 * 
 * Provides utilities and mocks for testing Inngest functions locally
 */

import { vi } from 'vitest';
import { inngest } from '../client';

/**
 * Mock Supabase client for testing
 */
export const mockSupabase = {
  from: vi.fn((_table?: string): any => ({
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn(),
    is: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    lt: vi.fn().mockReturnThis(),
  })),
  storage: {
    from: vi.fn(() => ({
      upload: vi.fn(),
      download: vi.fn(),
    })),
  },
  rpc: vi.fn(),
};

/**
 * Mock Anthropic client for testing
 */
export const mockAnthropic = {
  messages: {
    create: vi.fn(async () => ({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{
        type: 'text',
        text: JSON.stringify({
          category: 'customer_prospect',
          confidence: 0.95,
          shouldProcess: true,
          reasoning: 'Test reasoning',
        }),
      }],
      model: 'claude-opus-4-5-20251101',
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    })),
  },
};

/**
 * Mock OpenAI client for testing
 */
export const mockOpenAI = {
  embeddings: {
    create: vi.fn(async () => ({
      data: [{
        embedding: new Array(1536).fill(0).map(() => Math.random()),
        index: 0,
        object: 'embedding',
      }],
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 10, total_tokens: 10 },
    })),
  },
};

/**
 * Mock Slack client for testing
 */
export const mockSlack = {
  chat: {
    postMessage: vi.fn(async () => ({
      ok: true,
      ts: '1234567890.123456',
      channel: 'C123456',
    })),
  },
};

/**
 * Mock fetch for testing
 */
export const mockFetch = vi.fn(async (url: string) => {
  if (url.includes('slack.com/api')) {
    return {
      ok: true,
      json: async () => ({
        ok: true,
        ts: '1234567890.123456',
      }),
    };
  }
  
  return {
    ok: true,
    json: async () => ({}),
  };
});

/**
 * Create a mock Inngest step context for testing
 */
export const createMockStepContext = () => {
  const steps: Array<{ name: string; result: any }> = [];
  const events: Array<{ name: string; data: any }> = [];

  return {
    run: vi.fn(async (name: string, fn: () => Promise<any>) => {
      const result = await fn();
      steps.push({ name, result });
      return result;
    }),
    sendEvent: vi.fn(async (...args: any[]) => {
      if (args.length >= 2) events.push({ name: args[0], data: args[1] });
      return { ids: ['evt_test'] };
    }) as any,
    waitForEvent: vi.fn(async (..._args: any[]): Promise<any> => ({
      data: {
        action: 'approve',
        draftId: 'test-draft-id',
      },
    })) as any,
    invoke: vi.fn(async () => ({})),
    steps,
    events,
  };
};

/**
 * Create a mock event for testing
 */
export const createMockEvent = <T = any>(name: string, data: T) => ({
  name,
  data,
  id: 'evt_test',
  ts: Date.now(),
  user: {},
  v: '1',
});

/**
 * Test data generators
 */
export const testData = {
  email: {
    incoming: {
      userId: 'user-123',
      messageId: 'msg-456',
      from: 'prospect@example.com',
      subject: 'Interested in your product',
      body: 'Hi, I would like to learn more about your product features and pricing.',
      userDomain: 'mycompany.com',
      organizationId: 'org-789',
    },
    qualify: {
      userId: 'user-123',
      messageId: 'msg-456',
      from: 'prospect@example.com',
      subject: 'Interested in your product',
      body: 'Hi, I would like to learn more about your product features and pricing.',
      userDomain: 'mycompany.com',
      organizationId: 'org-789',
    },
    process: {
      userId: 'user-123',
      messageId: 'msg-456',
      from: 'prospect@example.com',
      subject: 'Interested in your product',
      body: 'Hi, I would like to learn more about your product features and pricing.',
      organizationId: 'org-789',
    },
    approval: {
      draftId: 'draft-123',
      action: 'approve' as const,
      slackUserId: 'U123456',
    },
  },
  calendar: {
    sync: {
      userId: 'user-123',
    },
    meetingPrep: {
      userId: 'user-123',
      eventId: 'event-456',
      requireApproval: true,
      slackChannelId: 'C123456',
    },
  },
  document: {
    upload: {
      path: 'documents/test.pdf',
      file: new Blob(['test content']),
      userId: 'user-123',
      organizationId: 'org-789',
    },
    process: {
      documentId: 'doc-123',
      userId: 'user-123',
    },
    embedding: {
      chunkId: 'chunk-123',
      text: 'This is a test document chunk for embedding generation.',
    },
  },
  knowledgeBase: {
    search: {
      query: 'product pricing',
      limit: 10,
      userId: 'user-123',
      organizationId: 'org-789',
    },
  },
};

/**
 * Assertion helpers
 */
export const assertStepRan = (steps: Array<{ name: string; result: any }>, stepName: string) => {
  const step = steps.find(s => s.name === stepName);
  if (!step) {
    throw new Error(`Expected step "${stepName}" to have run, but it didn't`);
  }
  return step;
};

export const assertEventSent = (events: Array<{ name: string; data: any }>, eventName: string) => {
  const event = events.find(e => e.data.name === eventName);
  if (!event) {
    throw new Error(`Expected event "${eventName}" to have been sent, but it wasn't`);
  }
  return event;
};

/**
 * Setup environment variables for testing
 */
export const setupTestEnv = () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.SLACK_BOT_TOKEN = 'test-slack-token';
};

/**
 * Clean up after tests
 */
export const cleanupTestEnv = () => {
  vi.clearAllMocks();
};
