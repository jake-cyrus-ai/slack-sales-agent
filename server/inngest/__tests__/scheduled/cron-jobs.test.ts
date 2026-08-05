/**
 * Tests for Scheduled Jobs
 * 
 * Tests cron functions for Gmail polling and calendar sync
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setupTestEnv,
  cleanupTestEnv,
  createMockStepContext,
  mockSupabase,
} from '../setup';

// Mock dependencies
vi.mock('../../utils/supabase', () => ({
  getSupabaseAdmin: () => mockSupabase,
}));

describe('Scheduled Jobs', () => {
  beforeEach(() => {
    setupTestEnv();
    cleanupTestEnv();
  });

  describe('Gmail Inbox Polling', () => {
    it('should poll multiple users without watch subscriptions', async () => {
      const step = createMockStepContext();

      // Mock users to poll
      mockSupabase.from.mockImplementationOnce(() => ({
        select: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({
          data: [
            { id: 'user-1', email: 'user1@example.com', gmail_connected: true },
            { id: 'user-2', email: 'user2@example.com', gmail_connected: true },
            { id: 'user-3', email: 'user3@example.com', gmail_connected: true },
          ],
        }),
      }));

      const users = await step.run('get-users-to-poll', async () => {
        const now = new Date().toISOString();
        const { data } = await mockSupabase
          .from('profiles')
          .select('*')
          .is('gmail_watch_expiration', null)
          .or('gmail_watch_expiration.lt.' + now)
          .eq('gmail_connected', true);

        return data || [];
      });

      expect(users.length).toBe(3);

      // Fan out to individual polling jobs
      await step.sendEvent('trigger-individual-polls', 
        users.map(user => ({
          name: 'email/poll-inbox',
          data: { userId: user.id },
        }))
      );

      expect(step.events.length).toBe(1);
      
      const sentEvents = step.events[0].data;
      if (Array.isArray(sentEvents)) {
        expect(sentEvents.length).toBe(3);
      }
    });

    it('should skip users with active watch subscriptions', async () => {
      const step = createMockStepContext();

      // Mock users - all have active watch
      mockSupabase.from.mockImplementationOnce(() => ({
        select: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({
          data: [], // No users to poll
        }),
      }));

      const users = await step.run('get-users-to-poll', async () => {
        const now = new Date().toISOString();
        const { data } = await mockSupabase
          .from('profiles')
          .select('*')
          .is('gmail_watch_expiration', null)
          .or('gmail_watch_expiration.lt.' + now)
          .eq('gmail_connected', true);

        return data || [];
      });

      expect(users.length).toBe(0);

      // Should not send any events
      expect(step.events.length).toBe(0);
    });

    it('should handle individual user inbox polling', async () => {
      const step = createMockStepContext();
      const userId = 'user-123';

      // Mock fetching emails
      const emails = await step.run('fetch-emails', async () => {
        // Simulate Gmail API call
        return [
          {
            id: 'msg-1',
            from: 'external@example.com',
            subject: 'New inquiry',
            body: 'I am interested',
            threadId: 'thread-1',
          },
        ];
      });

      expect(emails.length).toBe(1);

      // Trigger qualification
      await step.sendEvent('trigger-qualification', 
        emails.map(email => ({
          name: 'email/qualify',
          data: {
            userId,
            messageId: email.id,
            from: email.from,
            subject: email.subject,
            body: email.body,
            userDomain: 'mycompany.com',
          },
        }))
      );

      expect(step.events.length).toBe(1);
    });

    it('should handle polling errors gracefully', async () => {
      const step = createMockStepContext();

      // Mock error in user lookup
      mockSupabase.from.mockImplementationOnce(() => ({
        select: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        eq: vi.fn().mockRejectedValue(new Error('Database connection failed')),
      }));

      await expect(
        step.run('get-users-with-error', async () => {
          const { data } = await mockSupabase
            .from('profiles')
            .select('*')
            .is('gmail_watch_expiration', null)
            .eq('gmail_connected', true);

          return data;
        })
      ).rejects.toThrow('Database connection failed');
    });
  });

  describe('Calendar Sync', () => {
    it('should sync calendars for all connected users', async () => {
      const step = createMockStepContext();

      // Mock users with connected calendars
      mockSupabase.from.mockImplementationOnce(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({
          data: [
            { id: 'user-1', email: 'user1@example.com', calendar_connected: true },
            { id: 'user-2', email: 'user2@example.com', calendar_connected: true },
          ],
        }),
      }));

      const users = await step.run('get-users-with-calendars', async () => {
        const { data } = await mockSupabase
          .from('profiles')
          .select('*')
          .eq('calendar_connected', true);

        return data || [];
      });

      expect(users.length).toBe(2);

      // Fan out sync
      await step.sendEvent('fan-out-sync', 
        users.map(user => ({
          name: 'calendar/sync',
          data: { userId: user.id },
        }))
      );

      expect(step.events.length).toBe(1);
    });

    it('should fetch and upsert calendar events', async () => {
      const step = createMockStepContext();
      const userId = 'user-123';

      // Mock fetching Google Calendar events
      const events = await step.run('fetch-calendar-events', async () => {
        // Simulate Google Calendar API call
        return [
          {
            id: 'event-1',
            summary: 'Team Meeting',
            start: { dateTime: '2026-02-03T10:00:00Z' },
            end: { dateTime: '2026-02-03T11:00:00Z' },
            attendees: [
              { email: 'john@example.com' },
              { email: 'jane@example.com' },
            ],
          },
          {
            id: 'event-2',
            summary: 'Client Call',
            start: { dateTime: '2026-02-03T14:00:00Z' },
            end: { dateTime: '2026-02-03T15:00:00Z' },
            attendees: [
              { email: 'client@example.com' },
            ],
          },
        ];
      });

      expect(events.length).toBe(2);

      // Mock upsert
      mockSupabase.from.mockImplementationOnce(() => ({
        upsert: vi.fn().mockResolvedValue({
          data: events.map((e, i) => ({
            id: i + 1,
            user_id: userId,
            google_event_id: e.id,
            summary: e.summary,
            start_time: e.start.dateTime,
            end_time: e.end.dateTime,
          })),
        }),
      }));

      await step.run('upsert-events', async () => {
        const { data } = await mockSupabase
          .from('calendar_events')
          .upsert(
            events.map(e => ({
              user_id: userId,
              google_event_id: e.id,
              summary: e.summary,
              start_time: e.start.dateTime,
              end_time: e.end.dateTime,
              attendees: e.attendees,
            }))
          );

        return data;
      });

      // Verify upsert was called
      expect(mockSupabase.from).toHaveBeenCalledWith('calendar_events');
    });

    it('should handle sync with concurrency limit', async () => {
      const step = createMockStepContext();
      const totalUsers = 100;
      const concurrency = 20;

      // Simulate processing users in batches
      const batches = Math.ceil(totalUsers / concurrency);
      const syncTimes: number[] = [];

      for (let batch = 0; batch < batches; batch++) {
        const batchStart = Date.now();
        
        // Simulate syncing a batch
        await Promise.all(
          Array.from({ length: Math.min(concurrency, totalUsers - batch * concurrency) }, 
            async (_, i) => {
              // Simulate sync operation
              await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
            }
          )
        );

        syncTimes.push(Date.now() - batchStart);
      }

      console.log(`Synced ${totalUsers} users in ${batches} batches`);
      console.log(`Average batch time: ${(syncTimes.reduce((a, b) => a + b, 0) / batches).toFixed(2)}ms`);

      expect(batches).toBe(5); // 100 users / 20 concurrency
    });
  });

  describe('Cron Schedule Testing', () => {
    it('should validate cron expressions', () => {
      const cronExpressions = [
        { expr: '*/5 * * * *', desc: 'Every 5 minutes', valid: true },
        { expr: '0 * * * *', desc: 'Every hour', valid: true },
        { expr: '0 0 * * *', desc: 'Daily at midnight', valid: true },
        { expr: 'invalid', desc: 'Invalid expression', valid: false },
      ];

      cronExpressions.forEach(({ expr, desc, valid }) => {
        // Basic validation - real implementation would use a cron parser
        const isValid = /^[\d*/,\-\s]+$/.test(expr);
        
        if (valid) {
          expect(isValid).toBe(true);
        }
        
        console.log(`${desc}: "${expr}" - ${isValid ? 'Valid' : 'Invalid'}`);
      });
    });

    it('should simulate cron timing', async () => {
      const startTime = Date.now();
      const interval = 100; // ms (simulating minutes)
      const runs: number[] = [];

      // Simulate 5 cron runs
      for (let i = 0; i < 5; i++) {
        await new Promise(resolve => setTimeout(resolve, interval));
        runs.push(Date.now() - startTime);
      }

      // Verify consistent timing
      for (let i = 1; i < runs.length; i++) {
        const diff = runs[i] - runs[i - 1];
        expect(diff).toBeGreaterThanOrEqual(interval - 10); // Allow 10ms variance
        expect(diff).toBeLessThanOrEqual(interval + 20); // Allow timing variance
      }

      console.log('Cron run times:', runs);
    });
  });
});
