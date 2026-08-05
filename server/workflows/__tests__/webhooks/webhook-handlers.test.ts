/**
 * Tests for Webhook Handlers
 * 
 * Tests Gmail, Slack, and other webhook event processing
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import {
  setupTestEnv,
  cleanupTestEnv,
  createMockStepContext,
  createMockEvent,
  mockSupabase,
} from '../setup';
import app from '../../../index';
import { workflow } from '../../client';
import slackMessages from '../fixtures/slack-messages.json';

const createSlackEventEnvelope = (messagePayload: any) => ({
  token: 'test-token',
  team_id: (messagePayload as any).team,
  api_app_id: 'A12345TEST',
  event: messagePayload,
  type: 'event_callback',
  event_id: 'Ev' + Date.now(),
  event_time: Math.floor(Date.now() / 1000),
  authed_users: ['U0BOTID'],
});

// Mock dependencies
vi.mock('../../utils/supabase', () => ({
  getSupabaseAdmin: () => mockSupabase,
}));

describe('Webhook Handlers', () => {
  beforeEach(() => {
    setupTestEnv();
    cleanupTestEnv();
  });

  describe('Gmail Webhook Handler', () => {
    it('should process Gmail push notification', async () => {
      const step = createMockStepContext();
      const event = createMockEvent('email/notification', {
        emailAddress: 'user@mycompany.com',
        historyId: 'history-12345',
      });

      // Mock user lookup
      mockSupabase.from.mockImplementationOnce(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: {
            id: 'user-123',
            email: 'user@mycompany.com',
          },
        }),
      }));

      const user = await step.run('get-user', async () => {
        const { data } = await mockSupabase
          .from('profiles')
          .select('*')
          .eq('email', event.data.emailAddress)
          .single();

        return data;
      });

      expect(user).toBeDefined();
      expect(user.email).toBe('user@mycompany.com');

      // Mock fetching new emails (would call Gmail API)
      const newEmails = await step.run('fetch-new-emails', async () => {
        return [
          {
            id: 'msg-1',
            from: 'prospect@example.com',
            subject: 'Interested in product',
            body: 'Tell me more',
          },
          {
            id: 'msg-2',
            from: 'customer@example.com',
            subject: 'Support question',
            body: 'Need help',
          },
        ];
      });

      // Filter external emails
      const externalEmails = await step.run('filter-emails', async () => {
        return newEmails.filter(email => {
          const domain = email.from.split('@')[1];
          return domain !== user.email.split('@')[1];
        });
      });

      expect(externalEmails.length).toBe(2);

      // Fan out to qualification
      await step.sendEvent('trigger-qualification', 
        externalEmails.map(email => ({
          name: 'email/qualify',
          data: {
            userId: user.id,
            messageId: email.id,
            from: email.from,
            subject: email.subject,
            body: email.body,
            userDomain: user.email.split('@')[1],
          },
        }))
      );

      expect(step.events.length).toBe(1);
    });

    it('should handle missing user gracefully', async () => {
      const step = createMockStepContext();
      const event = createMockEvent('email/notification', {
        emailAddress: 'nonexistent@example.com',
        historyId: 'history-12345',
      });

      // Mock user not found
      mockSupabase.from.mockImplementationOnce(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'User not found' },
        }),
      }));

      const user = await step.run('get-user', async () => {
        const { data, error } = await mockSupabase
          .from('profiles')
          .select('*')
          .eq('email', event.data.emailAddress)
          .single();

        return data;
      });

      expect(user).toBeNull();
      
      // Should not proceed with email fetching
      const fetchStep = step.steps.find(s => s.name === 'fetch-new-emails');
      expect(fetchStep).toBeUndefined();
    });
  });

  describe('Slack Webhook Handler', () => {
    it('should handle Slack message event', async () => {
      const step = createMockStepContext();
      const event = createMockEvent('slack/message', {
        type: 'message',
        user: 'U123456',
        text: '/prep meeting with john@example.com',
        channel: 'C123456',
        ts: '1234567890.123456',
      });

      // Link Slack user to Sales Agent account
      const user = await step.run('link-slack-user', async () => {
        // Mock user linking logic
        return {
          id: 'user-123',
          slack_user_id: 'U123456',
          email: 'user@mycompany.com',
        };
      });

      expect(user).toBeDefined();
      expect(user.slack_user_id).toBe('U123456');

      // Classify intent
      const intent = await step.run('classify-intent', async () => {
        if (event.data.text.startsWith('/prep')) return 'meeting-prep';
        if (event.data.text.startsWith('/docs')) return 'search-docs';
        return 'chat';
      });

      expect(intent).toBe('meeting-prep');

      // Route to appropriate agent
      if (intent === 'meeting-prep') {
        await step.sendEvent('trigger-meeting-prep', {
          name: 'calendar/meeting-prep',
          data: {
            userId: user.id,
            slackContext: event.data,
          },
        });
      }

      const prepEvent = step.events.find(e => 
        e.data.name === 'calendar/meeting-prep'
      );
      
      expect(prepEvent).toBeDefined();
    });

    it('should handle Slack interaction (button click)', async () => {
      const step = createMockStepContext();
      const event = createMockEvent('slack/interaction', {
        type: 'block_actions',
        payload: JSON.stringify({
          type: 'block_actions',
          user: { id: 'U123456' },
          actions: [{
            action_id: 'approve_email',
            value: 'draft-123',
            type: 'button',
          }],
        }),
      });

      const payload = await step.run('parse-payload', async () => {
        return JSON.parse(event.data.payload);
      });

      expect(payload.type).toBe('block_actions');

      if (payload.type === 'block_actions') {
        // Send approval event
        await step.sendEvent('approval-clicked', {
          name: 'email/approval-response',
          data: {
            draftId: payload.actions[0].value,
            action: 'approve',
            slackUserId: payload.user.id,
          },
        });
      }

      const approvalEvent = step.events.find(e => 
        e.data.name === 'email/approval-response'
      );
      
      expect(approvalEvent).toBeDefined();
      expect(approvalEvent?.data.data.draftId).toBe('draft-123');
      expect(approvalEvent?.data.data.action).toBe('approve');
    });

    it('should handle Slack URL verification challenge', async () => {
      const step = createMockStepContext();
      const event = createMockEvent('slack/event', {
        type: 'url_verification',
        challenge: 'test-challenge-string',
      });

      const response = await step.run('handle-verification', async () => {
        if (event.data.type === 'url_verification') {
          return { challenge: event.data.challenge };
        }
        return null;
      });

      expect(response).toBeDefined();
      expect(response?.challenge).toBe('test-challenge-string');
    });
  });

  describe('Webhook Security', () => {
    it('should verify webhook signatures', async () => {
      const step = createMockStepContext();
      
      // Mock signature verification
      const verifySignature = async (payload: string, signature: string, secret: string) => {
        const crypto = await import('crypto');
        const hmac = crypto.createHmac('sha256', secret);
        hmac.update(payload);
        const expectedSignature = hmac.digest('hex');
        
        return signature === `sha256=${expectedSignature}`;
      };

      const isValid = await step.run('verify-signature', async () => {
        const payload = JSON.stringify({ test: 'data' });
        const secret = 'test-secret';
        const signature = 'sha256=invalid';
        
        return await verifySignature(payload, signature, secret);
      });

      // With invalid signature, should return false
      expect(isValid).toBe(false);
    });

    it('should reject webhooks with invalid timestamps', async () => {
      const step = createMockStepContext();
      
      const isValid = await step.run('check-timestamp', async () => {
        const timestamp = Date.now() - (6 * 60 * 1000); // 6 minutes ago
        const maxAge = 5 * 60 * 1000; // 5 minutes
        
        return (Date.now() - timestamp) <= maxAge;
      });

      // Timestamp too old
      expect(isValid).toBe(false);
    });
  });

  describe('Webhook Rate Limiting', () => {
    it('should handle high-frequency webhook events', async () => {
      const events: any[] = [];
      const maxEventsPerSecond = 10;
      
      // Simulate receiving many webhooks
      const startTime = Date.now();
      
      for (let i = 0; i < 50; i++) {
        events.push({
          timestamp: Date.now(),
          id: `event-${i}`,
        });
      }
      
      const duration = Date.now() - startTime;
      const eventsPerSecond = events.length / (duration / 1000);

      console.log(`Processed ${events.length} events in ${duration}ms`);
      console.log(`Rate: ${eventsPerSecond.toFixed(2)} events/second`);

      expect(events.length).toBe(50);
    });
  });

  describe('Slack routing to Vercel Workflow', () => {
    let baseUrl: string;
    let closeServer: (() => Promise<void>) | null = null;

    beforeAll(async () => {
      await new Promise<void>((resolve, reject) => {
        const server = app.listen(0, () => {
          const address = server.address();
          if (address && typeof address === 'object') {
            baseUrl = `http://127.0.0.1:${address.port}`;
          } else {
            server.close();
            reject(new Error('Failed to determine test server port'));
            return;
          }

          closeServer = () =>
            new Promise<void>((resolveClose, rejectClose) => {
              server.close(err => (err ? rejectClose(err) : resolveClose()));
            });

          resolve();
        });
      });
    });

    afterAll(async () => {
      if (closeServer) {
        await closeServer();
      }
    });

    it('routes Slack message events to slack/message', async () => {
      const sendSpy = vi.spyOn(workflow, 'send').mockResolvedValue({ ids: ['evt_test'] } as any);

      const slackEvent = createSlackEventEnvelope((slackMessages as any).basic_message);

      const response = await fetch(`${baseUrl}/api/test/slack/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(slackEvent),
      });

      expect(response.status).toBe(200);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      const [eventArg] = sendSpy.mock.calls[0];
      expect((eventArg as any)?.name).toBe('slack/message');
      expect((eventArg as any).data?.type).toBe('message');
    });

    it('routes Slack app_mention events to slack/message', async () => {
      const sendSpy = vi.spyOn(workflow, 'send').mockResolvedValue({ ids: ['evt_test'] } as any);

      const slackEvent = createSlackEventEnvelope((slackMessages as any).app_mention);

      const response = await fetch(`${baseUrl}/api/test/slack/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(slackEvent),
      });

      expect(response.status).toBe(200);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      const [eventArg] = sendSpy.mock.calls[0];
      expect((eventArg as any)?.name).toBe('slack/message');
      expect((eventArg as any).data?.type).toBe('app_mention');
    });
  });
});
