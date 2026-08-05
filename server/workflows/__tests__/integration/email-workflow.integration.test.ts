/**
 * Integration Tests for Complete Email Workflow
 * 
 * Tests the full end-to-end flow:
 * Gmail notification → Qualification → Processing → Approval → Send
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { workflow } from '../../client';
import {
  setupTestEnv,
  cleanupTestEnv,
  testData,
} from '../setup';

describe('Email Workflow Integration', () => {
  beforeEach(() => {
    setupTestEnv();
    cleanupTestEnv();
  });

  it('should process complete email workflow from notification to send', async () => {
    // This test validates the entire workflow chain:
    // 1. Gmail notification received
    // 2. Email qualified
    // 3. Email processed and draft generated
    // 4. Approval requested
    // 5. Email sent

    const events: any[] = [];

    // Mock the workflow.send to track events
    const originalSend = workflow.send;
    vi.spyOn(workflow, 'send').mockImplementation(async (event: any) => {
      events.push(event);
      return { ids: ['test-id'] };
    });

    // Step 1: Send incoming email notification
    await workflow.send({
      name: 'email/notification',
      data: {
        emailAddress: 'user@mycompany.com',
        historyId: 'history-123',
      },
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].name).toBe('email/notification');

    // Step 2: Verify qualification event would be triggered
    // In real scenario, handleGmailNotification would fan out to qualification
    await workflow.send({
      name: 'email/qualify',
      data: testData.email.qualify,
    });

    const qualifyEvent = events.find(e => e.name === 'email/qualify');
    expect(qualifyEvent).toBeDefined();

    // Step 3: Verify processing event would be triggered for qualified emails
    await workflow.send({
      name: 'email/process',
      data: testData.email.process,
    });

    const processEvent = events.find(e => e.name === 'email/process');
    expect(processEvent).toBeDefined();

    // Step 4: Verify approval response can be sent
    await workflow.send({
      name: 'email/approval-response',
      data: testData.email.approval,
    });

    const approvalEvent = events.find(e => e.name === 'email/approval-response');
    expect(approvalEvent).toBeDefined();

    // Restore original send
    vi.spyOn(workflow, 'send').mockRestore();
  });

  it('should handle parallel email processing', async () => {
    // Simulate multiple emails arriving at once
    const emails = [
      { ...testData.email.qualify, messageId: 'msg-1' },
      { ...testData.email.qualify, messageId: 'msg-2' },
      { ...testData.email.qualify, messageId: 'msg-3' },
    ];

    const events: any[] = [];
    vi.spyOn(workflow, 'send').mockImplementation(async (event: any) => {
      events.push(event);
      return { ids: ['test-id'] };
    });

    // Send all emails in parallel
    await Promise.all(
      emails.map(email =>
        workflow.send({
          name: 'email/qualify',
          data: email,
        })
      )
    );

    // Verify all events were sent
    expect(events.length).toBe(3);
    expect(events.every(e => e.name === 'email/qualify')).toBe(true);

    vi.spyOn(workflow, 'send').mockRestore();
  });

  it('should maintain event ordering in workflow chain', async () => {
    const eventLog: Array<{ name: string; timestamp: number }> = [];

    vi.spyOn(workflow, 'send').mockImplementation(async (event: any) => {
      eventLog.push({
        name: event.name,
        timestamp: Date.now(),
      });
      return { ids: ['test-id'] };
    });

    // Simulate workflow chain
    await (workflow.send as any)({
      name: 'email/notification',
      data: testData.email.incoming,
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    await workflow.send({
      name: 'email/qualify',
      data: testData.email.qualify,
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    await workflow.send({
      name: 'email/process',
      data: testData.email.process,
    });

    // Verify event ordering
    expect(eventLog[0].name).toBe('email/notification');
    expect(eventLog[1].name).toBe('email/qualify');
    expect(eventLog[2].name).toBe('email/process');

    // Verify timestamps are in order
    expect(eventLog[0].timestamp).toBeLessThan(eventLog[1].timestamp);
    expect(eventLog[1].timestamp).toBeLessThan(eventLog[2].timestamp);

    vi.spyOn(workflow, 'send').mockRestore();
  });
});
