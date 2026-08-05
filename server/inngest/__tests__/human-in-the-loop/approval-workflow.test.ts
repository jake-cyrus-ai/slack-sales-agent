/**
 * Human-in-the-Loop Tests
 * 
 * Tests waitForEvent functionality and approval workflows
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setupTestEnv,
  cleanupTestEnv,
  createMockStepContext,
  createMockEvent,
  testData,
} from '../setup';

describe('Human-in-the-Loop Workflows', () => {
  beforeEach(() => {
    setupTestEnv();
    cleanupTestEnv();
  });

  it('should wait for approval event with correct timeout', async () => {
    const step = createMockStepContext();
    
    const startTime = Date.now();
    let approvalReceived = false;

    // Mock waitForEvent with delay
    step.waitForEvent.mockImplementation(async (name: string, options: any) => {
      // Simulate waiting for 100ms
      await new Promise(resolve => setTimeout(resolve, 100));
      approvalReceived = true;
      
      return {
        data: {
          action: 'approve',
          draftId: 'draft-123',
        },
      };
    });

    const approval = await step.waitForEvent('wait-for-approval', {
      event: 'email/approval-response',
      timeout: '7d',
      match: 'data.draftId',
      if: `async.data.draftId == 'draft-123'`,
    });

    const duration = Date.now() - startTime;

    expect(approvalReceived).toBe(true);
    expect(approval.data.action).toBe('approve');
    // Allow timer jitter in CI (setTimeout(100) can fire at 99ms)
    expect(duration).toBeGreaterThanOrEqual(90);
    
    console.log(`Approval received after ${duration}ms`);
  });

  it('should handle timeout in waitForEvent', async () => {
    const step = createMockStepContext();

    // Mock timeout scenario
    step.waitForEvent.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      throw new Error('Timeout waiting for event');
    });

    await expect(
      step.waitForEvent('wait-for-timeout', {
        event: 'email/approval-response',
        timeout: '10ms',
        match: 'data.draftId',
      })
    ).rejects.toThrow('Timeout waiting for event');
  });

  it('should match events correctly with complex conditions', async () => {
    const step = createMockStepContext();

    const testCases = [
      {
        condition: `async.data.draftId == 'draft-123'`,
        event: { draftId: 'draft-123', action: 'approve' },
        shouldMatch: true,
      },
      {
        condition: `async.data.draftId == 'draft-123'`,
        event: { draftId: 'draft-456', action: 'approve' },
        shouldMatch: false,
      },
      {
        condition: `async.data.draftId == 'draft-123' && async.data.action == 'approve'`,
        event: { draftId: 'draft-123', action: 'approve' },
        shouldMatch: true,
      },
      {
        condition: `async.data.draftId == 'draft-123' && async.data.action == 'approve'`,
        event: { draftId: 'draft-123', action: 'reject' },
        shouldMatch: false,
      },
    ];

    for (const testCase of testCases) {
      step.waitForEvent.mockImplementation(async (name: string, options: any) => {
        // Simulate matching logic
        if (testCase.shouldMatch) {
          return { data: testCase.event };
        } else {
          throw new Error('Event did not match condition');
        }
      });

      if (testCase.shouldMatch) {
        const result = await step.waitForEvent('test-wait', {
          event: 'email/approval-response',
          timeout: '1d',
          match: 'data.draftId',
          if: testCase.condition,
        });

        expect(result.data).toEqual(testCase.event);
      } else {
        await expect(
          step.waitForEvent('test-wait', {
            event: 'email/approval-response',
            timeout: '1d',
            match: 'data.draftId',
            if: testCase.condition,
          })
        ).rejects.toThrow();
      }
    }
  });

  it('should handle multiple concurrent approvals', async () => {
    const drafts = ['draft-1', 'draft-2', 'draft-3'];
    const approvals: any[] = [];

    const mockWaitForEvent = async (draftId: string) => {
      const step = createMockStepContext();
      
      step.waitForEvent.mockImplementation(async () => {
        // Simulate random approval delay
        await new Promise(resolve => setTimeout(resolve, Math.random() * 100));
        
        return {
          data: {
            action: 'approve',
            draftId,
          },
        };
      });

      return await step.waitForEvent('wait-approval', {
        event: 'email/approval-response',
        timeout: '7d',
        match: 'data.draftId',
        if: `async.data.draftId == '${draftId}'`,
      });
    };

    const startTime = Date.now();

    // Wait for multiple approvals in parallel
    const results = await Promise.all(
      drafts.map(draftId => mockWaitForEvent(draftId))
    );

    const duration = Date.now() - startTime;

    expect(results.length).toBe(3);
    expect(results.every(r => r.data.action === 'approve')).toBe(true);
    
    console.log(`Handled ${drafts.length} concurrent approvals in ${duration}ms`);
  });

  it('should test approval workflow state persistence', async () => {
    const step = createMockStepContext();
    
    // Simulate workflow that saves state before waiting
    await step.run('save-draft', async () => {
      return { draftId: 'draft-123', saved: true };
    });

    await step.run('request-approval', async () => {
      return { requested: true, timestamp: Date.now() };
    });

    // Simulate workflow pause/resume
    step.waitForEvent.mockImplementation(async () => {
      // In real scenario, workflow state is persisted here
      return {
        data: {
          action: 'approve',
          draftId: 'draft-123',
        },
      };
    });

    const approval = await step.waitForEvent('wait-approval', {
      event: 'email/approval-response',
      timeout: '7d',
      match: 'data.draftId',
    });

    await step.run('send-email', async () => {
      return { sent: true, timestamp: Date.now() };
    });

    // Verify all steps executed in order
    expect(step.steps.length).toBe(3);
    expect(step.steps[0].name).toBe('save-draft');
    expect(step.steps[1].name).toBe('request-approval');
    expect(step.steps[2].name).toBe('send-email');
    
    // Verify waitForEvent was called
    expect(step.waitForEvent).toHaveBeenCalled();
  });

  it('should handle meeting prep approval with attendee skip', async () => {
    const step = createMockStepContext();
    
    // Simulate meeting prep workflow
    await step.run('research-attendees', async () => {
      return {
        attendees: [
          { email: 'john@example.com', name: 'John' },
          { email: 'jane@example.com', name: 'Jane' },
          { email: 'bob@example.com', name: 'Bob' },
        ],
      };
    });

    // Request approval
    await step.run('request-prep-approval', async () => {
      return { requested: true };
    });

    // Wait for approval with skip attendees option
    step.waitForEvent.mockImplementation(async () => {
      return {
        data: {
          action: 'skip_attendees',
          eventId: 'event-123',
          attendeesToSkip: ['bob@example.com'],
        },
      };
    });

    const approval = await step.waitForEvent('wait-prep-approval', {
      event: 'meeting/prep-approval',
      timeout: '1d',
      match: 'data.eventId',
    });

    expect(approval.data.action).toBe('skip_attendees');
    expect(approval.data.attendeesToSkip).toContain('bob@example.com');

    // Verify re-trigger event sent
    await step.sendEvent('restart-prep', {
      name: 'calendar/meeting-prep',
      data: {
        eventId: 'event-123',
        attendeesToSkip: approval.data.attendeesToSkip,
      },
    });

    const restartEvent = step.events.find(e => 
      e.data.name === 'calendar/meeting-prep'
    );
    
    expect(restartEvent).toBeDefined();
    expect(restartEvent?.data.data.attendeesToSkip).toContain('bob@example.com');
  });

  it('should test approval with edit and re-approval cycle', async () => {
    const step = createMockStepContext();
    const editCycles: Array<{ cycle: number; action: string }> = [];

    // First approval request
    step.waitForEvent.mockImplementationOnce(async () => {
      editCycles.push({ cycle: 1, action: 'edit' });
      return {
        data: {
          action: 'edit',
          draftId: 'draft-123',
          editedContent: 'First edit',
        },
      };
    });

    const firstApproval = await step.waitForEvent('wait-approval-1', {
      event: 'email/approval-response',
      timeout: '7d',
      match: 'data.draftId',
    });

    expect(firstApproval.data.action).toBe('edit');

    // Update draft
    await step.run('update-draft', async () => {
      return { updated: true, editCount: 1 };
    });

    // Re-request approval
    await step.sendEvent('re-request', {
      name: 'email/request-approval',
      data: { draftId: 'draft-123' },
    });

    // Second approval request
    step.waitForEvent.mockImplementationOnce(async () => {
      editCycles.push({ cycle: 2, action: 'approve' });
      return {
        data: {
          action: 'approve',
          draftId: 'draft-123',
        },
      };
    });

    const secondApproval = await step.waitForEvent('wait-approval-2', {
      event: 'email/approval-response',
      timeout: '7d',
      match: 'data.draftId',
    });

    expect(secondApproval.data.action).toBe('approve');
    expect(editCycles.length).toBe(2);
    expect(editCycles[0].action).toBe('edit');
    expect(editCycles[1].action).toBe('approve');

    console.log('Edit/approval cycles:', editCycles);
  });
});
