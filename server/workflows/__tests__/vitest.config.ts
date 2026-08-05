/**
 * Vitest Configuration for Vercel Workflow Tests
 */

import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [path.resolve(__dirname, 'setup-env.ts')],
    include: ['**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        '__tests__/',
        '*.config.ts',
        '*.d.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
    testTimeout: 30000, // 30 seconds
    hookTimeout: 10000, // 10 seconds
    teardownTimeout: 5000,
    isolate: true,
    pool: 'threads',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../..'),
      '@workflow': path.resolve(__dirname, '..'),
    },
  },
});
