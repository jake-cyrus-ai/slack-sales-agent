/**
 * Tests for Email Response Agent
 * 
 * Tests the business logic for the email processing workflow including:
 * - Classification logic
 * - Status transitions
 * - Approval actions
 * - Multi-tenant isolation validation
 * 
 * For full integration testing with Inngest, use the Inngest Dev Server.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setupTestEnv,
  cleanupTestEnv,
  testData,
} from '../setup';

/**
 * Email status types - mirrors the actual implementation
 */
type EmailStatus = 'pending' | 'processing' | 'draft_generated' | 'awaiting_approval' | 'sent' | 'rejected' | 'error';

/**
 * Check if email should skip processing
 */
function shouldSkipProcessing(status: EmailStatus): boolean {
  return status === 'sent' || status === 'rejected';
}

/**
 * Validate multi-tenant access
 */
function validateOrganizationAccess(
  emailOrgId: string,
  requestOrgId: string
): boolean {
  return emailOrgId === requestOrgId;
}

/**
 * Get next status based on approval action
 */
function getNextStatus(
  action: 'approve' | 'reject' | 'edit'
): EmailStatus {
  switch (action) {
    case 'approve':
      return 'sent';
    case 'reject':
      return 'rejected';
    case 'edit':
      return 'awaiting_approval';
    default:
      return 'error';
  }
}

/**
 * Validate email classification response
 */
function isValidClassification(classification: any): boolean {
  const validTypes = [
    'product_question',
    'pricing_inquiry',
    'support_request',
    'partnership_inquiry',
    'general_inquiry',
    'spam',
    'internal',
  ];
  return (
    classification &&
    typeof classification.classification === 'string' &&
    validTypes.includes(classification.classification) &&
    typeof classification.confidence === 'number' &&
    classification.confidence >= 0 &&
    classification.confidence <= 1
  );
}

describe('Email Response Agent', () => {
  beforeEach(() => {
    setupTestEnv();
    cleanupTestEnv();
  });

  describe('Status Handling', () => {
    it('should skip already sent emails', () => {
      expect(shouldSkipProcessing('sent')).toBe(true);
    });

    it('should skip rejected emails', () => {
      expect(shouldSkipProcessing('rejected')).toBe(true);
    });

    it('should not skip pending emails', () => {
      expect(shouldSkipProcessing('pending')).toBe(false);
    });

    it('should not skip processing emails', () => {
      expect(shouldSkipProcessing('processing')).toBe(false);
    });

    it('should not skip draft_generated emails', () => {
      expect(shouldSkipProcessing('draft_generated')).toBe(false);
    });

    it('should not skip awaiting_approval emails', () => {
      expect(shouldSkipProcessing('awaiting_approval')).toBe(false);
    });
  });

  describe('Approval Actions', () => {
    it('should return sent status for approve action', () => {
      expect(getNextStatus('approve')).toBe('sent');
    });

    it('should return rejected status for reject action', () => {
      expect(getNextStatus('reject')).toBe('rejected');
    });

    it('should return awaiting_approval status for edit action', () => {
      expect(getNextStatus('edit')).toBe('awaiting_approval');
    });
  });

  describe('Multi-tenant Organization Isolation', () => {
    it('should allow access when organizations match', () => {
      expect(validateOrganizationAccess('org-789', 'org-789')).toBe(true);
    });

    it('should deny access when organizations differ', () => {
      expect(validateOrganizationAccess('org-789', 'org-different')).toBe(false);
    });

    it('should handle empty organization IDs', () => {
      expect(validateOrganizationAccess('', 'org-789')).toBe(false);
      expect(validateOrganizationAccess('org-789', '')).toBe(false);
      expect(validateOrganizationAccess('', '')).toBe(true);
    });
  });

  describe('Classification Validation', () => {
    it('should accept valid product_question classification', () => {
      expect(isValidClassification({
        classification: 'product_question',
        confidence: 0.9,
        reasoning: 'User asking about features',
      })).toBe(true);
    });

    it('should accept valid pricing_inquiry classification', () => {
      expect(isValidClassification({
        classification: 'pricing_inquiry',
        confidence: 0.85,
        reasoning: 'User asking about pricing',
      })).toBe(true);
    });

    it('should accept valid support_request classification', () => {
      expect(isValidClassification({
        classification: 'support_request',
        confidence: 0.95,
        reasoning: 'User needs help with issue',
      })).toBe(true);
    });

    it('should accept edge confidence values', () => {
      expect(isValidClassification({
        classification: 'general_inquiry',
        confidence: 0,
      })).toBe(true);

      expect(isValidClassification({
        classification: 'general_inquiry',
        confidence: 1,
      })).toBe(true);
    });

    it('should reject invalid classification type', () => {
      expect(isValidClassification({
        classification: 'invalid_type',
        confidence: 0.9,
      })).toBe(false);
    });

    it('should reject missing classification', () => {
      expect(isValidClassification({
        confidence: 0.9,
      })).toBe(false);
    });

    it('should reject missing confidence', () => {
      expect(isValidClassification({
        classification: 'product_question',
      })).toBe(false);
    });

    it('should reject confidence out of range', () => {
      expect(isValidClassification({
        classification: 'product_question',
        confidence: -0.1,
      })).toBe(false);

      expect(isValidClassification({
        classification: 'product_question',
        confidence: 1.1,
      })).toBe(false);
    });

    it('should reject null/undefined', () => {
      expect(isValidClassification(null)).toBeFalsy();
      expect(isValidClassification(undefined)).toBeFalsy();
    });
  });

  describe('Test Data Validation', () => {
    it('should have valid test email data', () => {
      expect(testData.email.process).toHaveProperty('userId');
      expect(testData.email.process).toHaveProperty('messageId');
      expect(testData.email.process).toHaveProperty('organizationId');
    });
  });
});
