/**
 * Performance Tests for Vercel Workflow Functions
 * 
 * Tests concurrency, throughput, and performance characteristics
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { workflow } from '../../client';
import {
  setupTestEnv,
  cleanupTestEnv,
  testData,
} from '../setup';

describe('Performance & Concurrency Tests', () => {
  beforeEach(() => {
    setupTestEnv();
    cleanupTestEnv();
  });

  it('should handle high-volume event sending', async () => {
    const eventCount = 100;
    const events: any[] = [];

    vi.spyOn(workflow, 'send').mockImplementation(async (event: any) => {
      events.push(event);
      return { ids: ['test-id'] };
    });

    const startTime = Date.now();

    // Send 100 events in parallel
    await Promise.all(
      Array.from({ length: eventCount }, (_, i) =>
        workflow.send({
          name: 'email/qualify',
          data: {
            ...testData.email.qualify,
            messageId: `msg-${i}`,
          },
        })
      )
    );

    const duration = Date.now() - startTime;

    // All events should be sent
    expect(events.length).toBe(eventCount);

    // Should complete reasonably fast (adjust threshold as needed)
    expect(duration).toBeLessThan(5000); // 5 seconds for 100 events

    console.log(`Sent ${eventCount} events in ${duration}ms`);
    console.log(`Average: ${(duration / eventCount).toFixed(2)}ms per event`);

    vi.spyOn(workflow, 'send').mockRestore();
  });

  it('should handle concurrent processing of multiple functions', async () => {
    const processCount = 50;
    const events: any[] = [];

    vi.spyOn(workflow, 'send').mockImplementation(async (event: any) => {
      events.push(event);
      // Simulate some processing time
      await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
      return { ids: ['test-id'] };
    });

    const startTime = Date.now();

    // Mix different event types
    const eventTypes = [
      'email/qualify',
      'email/process',
      'knowledge-base/search',
      'calendar/sync',
    ];

    await Promise.all(
      Array.from({ length: processCount }, (_, i) =>
        (workflow.send as any)({
          name: eventTypes[i % eventTypes.length],
          data: {
            userId: 'user-123',
            id: `item-${i}`,
          },
        })
      )
    );

    const duration = Date.now() - startTime;

    expect(events.length).toBe(processCount);
    
    // Verify event type distribution
    const distribution = events.reduce((acc, e) => {
      acc[e.name] = (acc[e.name] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    console.log('Event distribution:', distribution);
    console.log(`Processed ${processCount} mixed events in ${duration}ms`);

    vi.spyOn(workflow, 'send').mockRestore();
  });

  it('should measure step execution overhead', async () => {
    const { createMockStepContext } = await import('../setup');
    const step = createMockStepContext();

    const iterations = 1000;
    const startTime = Date.now();

    // Measure step.run overhead
    for (let i = 0; i < iterations; i++) {
      await step.run(`step-${i}`, async () => {
        return { result: i };
      });
    }

    const duration = Date.now() - startTime;
    const avgPerStep = duration / iterations;

    console.log(`Executed ${iterations} steps in ${duration}ms`);
    console.log(`Average: ${avgPerStep.toFixed(3)}ms per step`);

    expect(step.steps.length).toBe(iterations);
    expect(avgPerStep).toBeLessThan(5); // Should be under 5ms per step
  });

  it('should test retry performance', async () => {
    const { createMockStepContext } = await import('../setup');
    
    let attempts = 0;
    const maxAttempts = 3;

    const step = createMockStepContext();
    step.run.mockImplementation(async (name: string, fn: () => Promise<any>) => {
      attempts++;
      
      if (attempts < maxAttempts) {
        throw new Error('Simulated failure');
      }
      
      return await fn();
    });

    const startTime = Date.now();

    try {
      // This would normally be handled by Vercel Workflow's retry logic
      let lastError;
      for (let i = 0; i < maxAttempts; i++) {
        try {
          await step.run('test-step', async () => {
            return { success: true };
          });
          break;
        } catch (error) {
          lastError = error;
          if (i < maxAttempts - 1) {
            // Exponential backoff simulation
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 100));
          }
        }
      }
    } catch (error) {
      // Expected to succeed on 3rd attempt
    }

    const duration = Date.now() - startTime;

    console.log(`Retry sequence completed in ${duration}ms with ${attempts} attempts`);

    expect(attempts).toBe(maxAttempts);
  });

  it('should test event batching performance', async () => {
    const batchSize = 50;
    const batches = 10;
    const totalEvents = batchSize * batches;

    const events: any[] = [];
    
    vi.spyOn(workflow, 'send').mockImplementation(async (event: any) => {
      events.push(event);
      return { ids: ['test-id'] };
    });

    const startTime = Date.now();

    // Send events in batches
    for (let batch = 0; batch < batches; batch++) {
      await Promise.all(
        Array.from({ length: batchSize }, (_, i) =>
          workflow.send({
            name: 'document/generate-embedding',
            data: {
              chunkId: `chunk-${batch}-${i}`,
              text: 'Test content',
            },
          })
        )
      );
    }

    const duration = Date.now() - startTime;

    expect(events.length).toBe(totalEvents);

    console.log(`Sent ${totalEvents} events in ${batches} batches`);
    console.log(`Total time: ${duration}ms`);
    console.log(`Average per batch: ${(duration / batches).toFixed(2)}ms`);

    vi.spyOn(workflow, 'send').mockRestore();
  });

  it('should measure memory usage during large workflows', async () => {
    const { createMockStepContext } = await import('../setup');
    const step = createMockStepContext();

    const largeData = Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      content: 'x'.repeat(1000), // 1KB per item
    }));

    const startMemory = process.memoryUsage();

    // Simulate processing large dataset through steps
    await step.run('process-large-dataset', async () => {
      const results = [];
      for (const item of largeData) {
        results.push({
          id: item.id,
          processed: true,
        });
      }
      return results;
    });

    const endMemory = process.memoryUsage();
    const memoryIncrease = {
      heapUsed: (endMemory.heapUsed - startMemory.heapUsed) / 1024 / 1024,
      external: (endMemory.external - startMemory.external) / 1024 / 1024,
    };

    console.log(`Memory increase during large workflow:`);
    console.log(`  Heap: ${memoryIncrease.heapUsed.toFixed(2)} MB`);
    console.log(`  External: ${memoryIncrease.external.toFixed(2)} MB`);

    // Memory usage should be reasonable (adjust threshold as needed)
    expect(memoryIncrease.heapUsed).toBeLessThan(100); // Less than 100MB increase
  });
});
