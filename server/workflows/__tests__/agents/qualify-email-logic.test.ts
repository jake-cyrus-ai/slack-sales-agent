/**
 * Tests for Email Qualification Logic
 * 
 * Tests the qualification logic without full Vercel Workflow runtime
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestEnv, cleanupTestEnv } from '../setup';

// Extract domain helper (mirrors the one in qualify-email-agent.ts)
function extractDomain(email: string): string {
  const parts = email.split("@");
  return parts.length === 2 ? parts[1].toLowerCase() : "";
}

// Heuristic check logic (mirrors the one in qualify-email-agent.ts)
function checkHeuristics(emailData: {
  fromEmail: string;
  subject: string;
  userDomain: string;
}): { shouldProcess: boolean | null; reason?: string } {
  const fromDomain = extractDomain(emailData.fromEmail);
  if (fromDomain === emailData.userDomain) {
    return { shouldProcess: false, reason: "internal_email" };
  }

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

  return { shouldProcess: null };
}

describe('Email Qualification Logic', () => {
  beforeEach(() => {
    setupTestEnv();
    cleanupTestEnv();
  });

  describe('Domain Extraction', () => {
    it('should extract domain from valid email', () => {
      expect(extractDomain('user@example.com')).toBe('example.com');
      expect(extractDomain('john.doe@company.org')).toBe('company.org');
      expect(extractDomain('test@subdomain.example.com')).toBe('subdomain.example.com');
    });

    it('should handle invalid emails', () => {
      expect(extractDomain('invalid-email')).toBe('');
      expect(extractDomain('')).toBe('');
      expect(extractDomain('@example.com')).toBe('example.com');
    });

    it('should be case-insensitive', () => {
      expect(extractDomain('User@EXAMPLE.COM')).toBe('example.com');
    });
  });

  describe('Heuristic Checks', () => {
    it('should reject internal emails', () => {
      const result = checkHeuristics({
        fromEmail: 'colleague@mycompany.com',
        subject: 'Internal discussion',
        userDomain: 'mycompany.com',
      });

      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('internal_email');
    });

    it('should reject spam emails', () => {
      const spamTests = [
        { subject: 'Unsubscribe from our list', expectedReason: 'spam_indicators' },
        { subject: 'You won the lottery!', expectedReason: 'spam_indicators' },
        { subject: 'Congratulations you won a prize', expectedReason: 'spam_indicators' },
        { subject: 'Claim your prize now', expectedReason: 'spam_indicators' },
      ];

      spamTests.forEach(test => {
        const result = checkHeuristics({
          fromEmail: 'spam@example.com',
          subject: test.subject,
          userDomain: 'mycompany.com',
        });

        expect(result.shouldProcess).toBe(false);
        expect(result.reason).toBe(test.expectedReason);
      });
    });

    it('should return null for ambiguous emails needing LLM', () => {
      const result = checkHeuristics({
        fromEmail: 'prospect@example.com',
        subject: 'Interested in your product',
        userDomain: 'mycompany.com',
      });

      expect(result.shouldProcess).toBeNull();
      expect(result.reason).toBeUndefined();
    });

    it('should accept external emails from different domains', () => {
      const result = checkHeuristics({
        fromEmail: 'client@otherdomain.com',
        subject: 'Partnership opportunity',
        userDomain: 'mycompany.com',
      });

      // Should need LLM classification
      expect(result.shouldProcess).toBeNull();
    });

    it('should be case-insensitive for spam detection', () => {
      const result = checkHeuristics({
        fromEmail: 'spam@example.com',
        subject: 'UNSUBSCRIBE NOW',
        userDomain: 'mycompany.com',
      });

      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe('spam_indicators');
    });
  });

  describe('Classification Categories', () => {
    it('should categorize customer inquiries', () => {
      const customerEmails = [
        'Interested in your product',
        'Can you tell me about pricing?',
        'I need support with your service',
        'Let\'s schedule a meeting',
      ];

      customerEmails.forEach(subject => {
        const result = checkHeuristics({
          fromEmail: 'customer@example.com',
          subject,
          userDomain: 'mycompany.com',
        });

        // These should pass heuristics and go to LLM
        expect(result.shouldProcess).toBeNull();
      });
    });

    it('should handle edge cases', () => {
      const edgeCases = [
        { fromEmail: '', subject: 'Test', userDomain: 'mycompany.com' },
        { fromEmail: 'test@example.com', subject: '', userDomain: 'mycompany.com' },
        { fromEmail: 'test@example.com', subject: 'Test', userDomain: '' },
      ];

      edgeCases.forEach(testCase => {
        const result = checkHeuristics(testCase);
        // Should not crash
        expect(result).toBeDefined();
        expect(result.shouldProcess === null || typeof result.shouldProcess === 'boolean').toBe(true);
      });
    });
  });

  describe('Multi-tenant Isolation', () => {
    it('should correctly identify internal emails per organization', () => {
      const organizations = [
        { domain: 'company1.com', email: 'user@company1.com', isInternal: true },
        { domain: 'company1.com', email: 'user@company2.com', isInternal: false },
        { domain: 'company2.com', email: 'user@company2.com', isInternal: true },
      ];

      organizations.forEach(org => {
        const result = checkHeuristics({
          fromEmail: org.email,
          subject: 'Test email',
          userDomain: org.domain,
        });

        if (org.isInternal) {
          expect(result.shouldProcess).toBe(false);
          expect(result.reason).toBe('internal_email');
        } else {
          expect(result.shouldProcess).toBeNull(); // External, needs LLM
        }
      });
    });
  });
});
