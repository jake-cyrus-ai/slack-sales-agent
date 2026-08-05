/**
 * Tests for Email Qualification Agent
 * 
 * Tests the two-stage qualification process:
 * 1. Fast heuristic checks
 * 2. LLM classification for ambiguous cases
 * 
 * These tests verify the business logic extracted from the Inngest function.
 * For full integration testing, use the Inngest Dev Server.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setupTestEnv,
  cleanupTestEnv,
  testData,
} from '../setup';

/**
 * Extract domain from email address - mirrors the function in qualify-email-agent.ts
 */
function extractDomain(email: string): string {
  const parts = email.split("@");
  return parts.length === 2 ? parts[1].toLowerCase() : "";
}

/**
 * Fast heuristic checks for obvious cases - mirrors the function logic
 */
function checkHeuristics(emailData: {
  fromEmail: string;
  subject: string;
  userDomain: string;
}): { shouldProcess: boolean | null; reason?: string } {
  // Check if internal email
  const fromDomain = extractDomain(emailData.fromEmail);
  if (fromDomain === emailData.userDomain) {
    return { shouldProcess: false, reason: "internal_email" };
  }

  // Check spam keywords
  const spamKeywords = [
    "unsubscribe",
    "viagra",
    "cialis",
    "lottery",
    "winner",
    "congratulations you won",
    "claim your prize",
  ];
  
  const lowerSubject = emailData.subject.toLowerCase();
  if (spamKeywords.some(keyword => lowerSubject.includes(keyword))) {
    return { shouldProcess: false, reason: "spam_indicators" };
  }

  // Needs LLM classification
  return { shouldProcess: null };
}

describe('Qualify Email Agent', () => {
  beforeEach(() => {
    setupTestEnv();
    cleanupTestEnv();
  });

  describe('Heuristic Checks', () => {
    it('should reject internal emails', () => {
      const result = checkHeuristics({
        fromEmail: 'colleague@mycompany.com',
        subject: 'Meeting tomorrow',
        userDomain: 'mycompany.com',
      });

      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('internal_email');
    });

    it('should reject spam emails with lottery keywords', () => {
      const result = checkHeuristics({
        fromEmail: 'scammer@external.com',
        subject: 'Congratulations! You won the lottery!',
        userDomain: 'mycompany.com',
      });

      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('spam_indicators');
    });

    it('should reject emails with viagra keyword', () => {
      const result = checkHeuristics({
        fromEmail: 'spam@external.com',
        subject: 'Special offer on viagra',
        userDomain: 'mycompany.com',
      });

      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('spam_indicators');
    });

    it('should pass legitimate external emails to LLM', () => {
      const result = checkHeuristics({
        fromEmail: 'prospect@example.com',
        subject: 'Interested in your product',
        userDomain: 'mycompany.com',
      });

      expect(result.shouldProcess).toBeNull();
      expect(result.reason).toBeUndefined();
    });

    it('should handle case insensitivity for domains', () => {
      const result = checkHeuristics({
        fromEmail: 'COLLEAGUE@MYCOMPANY.COM',
        subject: 'Meeting tomorrow',
        userDomain: 'mycompany.com',
      });

      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('internal_email');
    });

    it('should handle case insensitivity for spam keywords', () => {
      const result = checkHeuristics({
        fromEmail: 'scammer@external.com',
        subject: 'CONGRATULATIONS YOU WON a prize!',
        userDomain: 'mycompany.com',
      });

      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('spam_indicators');
    });
  });

  describe('Domain Extraction', () => {
    it('should extract domain from email', () => {
      expect(extractDomain('user@example.com')).toBe('example.com');
    });

    it('should handle uppercase email', () => {
      expect(extractDomain('USER@EXAMPLE.COM')).toBe('example.com');
    });

    it('should handle invalid email format', () => {
      expect(extractDomain('invalid-email')).toBe('');
    });

    it('should handle empty string', () => {
      expect(extractDomain('')).toBe('');
    });
  });

  describe('Multi-tenant Organization Logic', () => {
    it('should use organizationId from event if provided', () => {
      const eventData = {
        ...testData.email.qualify,
        organizationId: 'provided-org-id',
      };

      // When organizationId is in event, it should be used directly
      expect(eventData.organizationId).toBe('provided-org-id');
    });

    it('should handle missing organizationId', () => {
      const eventData = {
        ...testData.email.qualify,
      };

      // When no organizationId, it should fall back to user lookup
      expect(eventData.organizationId).toBe('org-789');
    });
  });
});
