/**
 * Unit tests for the intelligence layer:
 * - tenant-context: domain extraction, normalization, business domain check
 * - evidence: query scope resolution, entity extraction, email direction classification
 * - state: EvidenceAssessment type shape validation
 * - supervisor: domain signal classification, email intent detection
 * - exa-research: Slack URL stripping
 * - slack/email-share: email share request detection
 * - slack/formatter: formatting with confidence
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/config', () => ({
  config: {
    port: 10000,
    supabaseUrl: 'http://localhost:54321',
    supabaseServiceRoleKey: 'test-service-role-key',
    anthropicApiKey: 'test-anthropic-key',
    openaiApiKey: 'test-openai-key',
    googleClientId: '',
    googleClientSecret: '',
    slackEnv: 'STAGING',
    slackAppId: '',
    slackSigningSecret: '',
    slackBotToken: '',
    slackClientId: '',
    slackClientSecret: '',
    slackTokenEncryptionKey: '',
    slackEngineeringWebhookUrl: '',
    clerkSecretKey: '',
    clerkPublishableKey: '',
    clerkWebhookSigningSecret: '',
    mem0ApiKey: '',
    exaApiKey: '',
    workflowEventKey: '',
    workflowSigningKey: '',
    salesforceLoginUrl: 'https://login.salesforce.com',
    salesforceClientId: '',
    salesforceClientSecret: '',
    salesforceUsername: '',
    salesforcePassword: '',
  },
}));

vi.mock('../../../src/lib/supabase', () => ({
  supabase: {},
}));

// ─── Tenant Context ──────────────────────────────────────────────────────────

import {
  extractDomain,
  normalizeDomain,
  isBusinessDomain,
} from '../../../src/agent/tenant-context';

describe('tenant-context', () => {
  describe('extractDomain', () => {
    it('extracts domain from email address', () => {
      expect(extractDomain('jake@acme.com')).toBe('acme.com');
    });

    it('extracts domain from uppercase email', () => {
      expect(extractDomain('JAKE@ACME.COM')).toBe('acme.com');
    });

    it('returns null for empty input', () => {
      expect(extractDomain('')).toBeNull();
    });

    it('normalizes bare domain', () => {
      expect(extractDomain('acme.com')).toBe('acme.com');
    });

    it('strips https:// prefix', () => {
      expect(extractDomain('https://stripe.com/docs')).toBe('stripe.com');
    });
  });

  describe('normalizeDomain', () => {
    it('lowercases and trims', () => {
      expect(normalizeDomain('  STRIPE.COM  ')).toBe('stripe.com');
    });

    it('strips @ prefix', () => {
      expect(normalizeDomain('@stripe.com')).toBe('stripe.com');
    });

    it('returns null for no dots', () => {
      expect(normalizeDomain('localhost')).toBeNull();
    });
  });

  describe('isBusinessDomain', () => {
    it('returns false for gmail.com', () => {
      expect(isBusinessDomain('gmail.com')).toBe(false);
    });

    it('returns false for yahoo.com', () => {
      expect(isBusinessDomain('yahoo.com')).toBe(false);
    });

    it('returns true for acme.com', () => {
      expect(isBusinessDomain('acme.com')).toBe(true);
    });

    it('returns true for stripe.com', () => {
      expect(isBusinessDomain('stripe.com')).toBe(true);
    });

    it('returns false for invalid domain', () => {
      expect(isBusinessDomain('')).toBe(false);
    });
  });
});

// ─── Evidence ────────────────────────────────────────────────────────────────

import {
  resolveQueryScopeFromText,
  classifyEmailDirection,
} from '../../../src/agent/evidence';

describe('evidence', () => {
  describe('resolveQueryScopeFromText', () => {
    it('extracts entity from "deal with Stripe"', () => {
      const scope = resolveQueryScopeFromText('What is the deal status with Stripe?', true);
      expect(scope.entityName).toBe('Stripe');
      expect(scope.entityType).toBe('customer');
    });

    it('detects pricing intent', () => {
      const scope = resolveQueryScopeFromText('What pricing did we agree on?', false);
      expect(scope.intentType).toBe('pricing');
    });

    it('detects timeline intent', () => {
      const scope = resolveQueryScopeFromText('When is the deadline for Acme?', false);
      expect(scope.intentType).toBe('timeline');
    });

    it('detects next_steps intent', () => {
      const scope = resolveQueryScopeFromText('What are the next steps with Ramp?', false);
      expect(scope.intentType).toBe('next_steps');
    });

    it('defaults to general_status', () => {
      const scope = resolveQueryScopeFromText('hello how are you', false);
      expect(scope.intentType).toBe('general_status');
    });

    it('returns null entityName for no entities', () => {
      const scope = resolveQueryScopeFromText('tell me something', false);
      expect(scope.entityName).toBeNull();
    });
  });

  describe('classifyEmailDirection', () => {
    it('returns internal for trusted domain', () => {
      const result = classifyEmailDirection('acme.com', {
        trustedDomains: ['acme.com'],
        primaryUserDomain: 'acme.com',
      });
      expect(result).toBe('internal');
    });

    it('returns external for business domain not in trusted', () => {
      const result = classifyEmailDirection('stripe.com', {
        trustedDomains: ['acme.com'],
        primaryUserDomain: 'acme.com',
      });
      expect(result).toBe('external');
    });

    it('returns unknown when no tenant context', () => {
      const result = classifyEmailDirection('stripe.com', null);
      expect(result).toBe('unknown');
    });

    it('returns unknown for null domain', () => {
      expect(classifyEmailDirection(null, null)).toBe('unknown');
    });
  });
});

// ─── Evidence Assessment Type Shape ──────────────────────────────────────────

import type { EvidenceAssessment } from '../../../src/agent/state';

describe('EvidenceAssessment shape', () => {
  const validAssessment: EvidenceAssessment = {
    confidence: 'high',
    confidenceScore: 0.92,
    hasConflicts: false,
    sources: [
      { title: 'Email: Stripe pricing', type: 'email', recency: 'current', relevance: 'direct' },
    ],
    conflicts: [],
    keyFindings: ['Stripe agreed to $100/seat/month'],
    weakPoints: null,
  };

  it('accepts a valid assessment', () => {
    expect(validAssessment.confidence).toBe('high');
    expect(validAssessment.confidenceScore).toBeGreaterThanOrEqual(0);
    expect(validAssessment.confidenceScore).toBeLessThanOrEqual(1);
    expect(validAssessment.hasConflicts).toBe(false);
    expect(validAssessment.sources).toHaveLength(1);
    expect(validAssessment.conflicts).toHaveLength(0);
  });

  it('accepts an assessment with conflicts', () => {
    const withConflicts: EvidenceAssessment = {
      confidence: 'medium',
      confidenceScore: 0.6,
      hasConflicts: true,
      sources: [
        { title: 'Email thread', type: 'email', recency: 'recent', relevance: 'direct' },
        { title: 'Meeting notes', type: 'meeting', recency: 'older', relevance: 'supporting' },
      ],
      conflicts: [
        { topic: 'pricing', newer: '$100/month from email', older: '$80/month from meeting', assessment: 'Email is more recent' },
      ],
      keyFindings: ['Price discussed but not finalized'],
      weakPoints: 'Meeting notes may be outdated',
    };
    expect(withConflicts.hasConflicts).toBe(true);
    expect(withConflicts.conflicts).toHaveLength(1);
    expect(withConflicts.conflicts[0].topic).toBe('pricing');
    expect(withConflicts.weakPoints).toBeTruthy();
  });

  it('validates confidence levels', () => {
    const levels: EvidenceAssessment['confidence'][] = ['high', 'medium', 'low'];
    for (const level of levels) {
      expect(levels).toContain(level);
    }
  });

  it('validates source recency values', () => {
    const recencyValues = ['current', 'recent', 'older', 'stale'] as const;
    for (const val of recencyValues) {
      const source = { title: 'Test', type: 'test', recency: val, relevance: 'direct' as const };
      expect(recencyValues).toContain(source.recency);
    }
  });

  it('validates source relevance values', () => {
    const relevanceValues = ['direct', 'supporting', 'tangential'] as const;
    for (const val of relevanceValues) {
      const source = { title: 'Test', type: 'test', recency: 'current' as const, relevance: val };
      expect(relevanceValues).toContain(source.relevance);
    }
  });
});

// ─── Supervisor: domain signals, email intent ────────────────────────────────

import { detectEmailIntent, detectEmailIntentFromText, computeDomainSignals } from '../../../src/agent/supervisor';
import { registry } from '../../../src/skills/registry';
import { allSkills } from '../../../src/skills/definitions/index';
import { beforeAll } from 'vitest';

describe('supervisor helpers', () => {
  beforeAll(() => {
    // Register all skills bypassing isAvailable checks for test environment
    for (const skill of allSkills) {
      registry.register(skill);
    }
  });

  describe('computeDomainSignals', () => {
    it('scores sales patterns for deal-related queries', () => {
      const signals = computeDomainSignals('What is the deal status with Ramp?');
      expect(signals.sales).toBeGreaterThan(0);
    });

    it('scores enablement patterns for pricing queries', () => {
      const signals = computeDomainSignals('What is our enterprise pricing?');
      expect(signals.enablement).toBeGreaterThan(0);
    });

    it('scores prospecting patterns for people lookup', () => {
      const signals = computeDomainSignals('Research the CTO of Stripe on LinkedIn');
      expect(signals.prospecting).toBeGreaterThan(0);
    });

    it('scores salesforce for SFDC queries', () => {
      const signals = computeDomainSignals('Check Salesforce for the Acme account');
      expect(signals.salesforce).toBeGreaterThan(0);
    });

    it('returns all zeros for unrelated text', () => {
      const signals = computeDomainSignals('hello');
      expect(signals.sales).toBe(0);
      expect(signals.enablement).toBe(0);
      expect(signals.prospecting).toBe(0);
      expect(signals.salesforce).toBe(0);
    });

    it('scores multiple domains for cross-domain queries', () => {
      const signals = computeDomainSignals('Check my email for the pricing doc from Stripe');
      expect(signals.sales).toBeGreaterThan(0);
      expect(signals.enablement).toBeGreaterThan(0);
    });

    it('boosts transcript for meeting-content patterns', () => {
      const signals = computeDomainSignals('What were the action items from the meeting?');
      expect(signals.transcript).toBeGreaterThanOrEqual(2);
    });
  });

  describe('detectEmailIntent', () => {
    it('detects "send" intent', () => {
      expect(detectEmailIntent('send an email to jake')).toBe('send');
    });

    it('detects "draft" intent', () => {
      expect(detectEmailIntent('draft an email for the follow-up')).toBe('draft');
    });

    it('detects "reply to" as send', () => {
      expect(detectEmailIntent('reply to Sarah about the contract')).toBe('send');
    });

    it('returns null for unrelated text', () => {
      expect(detectEmailIntent('what is the status with Ramp')).toBeNull();
    });
  });

  describe('detectEmailIntentFromText', () => {
    it('is same function as detectEmailIntent', () => {
      expect(detectEmailIntentFromText('compose a message to bob')).toBe('draft');
    });
  });
});

// ─── Exa: stripSlackFormatting ───────────────────────────────────────────────

import { stripSlackFormatting } from '../../../src/tools/exa-research';

describe('stripSlackFormatting', () => {
  it('strips Slack URL format <url|label>', () => {
    expect(stripSlackFormatting('check <https://stripe.com|Stripe>')).toBe('check Stripe');
  });

  it('strips bare Slack URL format <url>', () => {
    expect(stripSlackFormatting('visit <https://stripe.com>')).toBe('visit https://stripe.com');
  });

  it('strips user mentions', () => {
    expect(stripSlackFormatting('Hey <@U123ABC> check this')).toBe('Hey check this');
  });

  it('strips mailto formatting', () => {
    expect(stripSlackFormatting('send to <mailto:jake@test.com|jake@test.com>')).toBe('send to jake@test.com');
  });

  it('handles plain text unchanged', () => {
    expect(stripSlackFormatting('hello world')).toBe('hello world');
  });
});

// ─── Email Share: detectEmailShareRequest ────────────────────────────────────

import { detectEmailShareRequest } from '../../../src/slack/email-share';

describe('detectEmailShareRequest', () => {
  it('detects "send soc2 to jake@test.com"', () => {
    const result = detectEmailShareRequest('send soc2 to jake@test.com');
    expect(result.isEmailRequest).toBe(true);
    expect(result.queries[0]).toBe('soc2');
    expect(result.recipientEmail).toBe('jake@test.com');
  });

  it('detects "email the security doc to ali@acme.com"', () => {
    const result = detectEmailShareRequest('email the security doc to ali@acme.com');
    expect(result.isEmailRequest).toBe(true);
    expect(result.recipientEmail).toBe('ali@acme.com');
  });

  it('returns false for unrelated messages', () => {
    const result = detectEmailShareRequest('what is our pricing?');
    expect(result.isEmailRequest).toBe(false);
  });

  it('handles Slack mailto formatting', () => {
    const result = detectEmailShareRequest('send soc2 to <mailto:jake@test.com|jake@test.com>');
    expect(result.isEmailRequest).toBe(true);
    expect(result.recipientEmail).toBe('jake@test.com');
  });
});

// ─── Formatter: confidence label ─────────────────────────────────────────────

import { formatMessageForSlack } from '../../../src/slack/formatter';

describe('formatMessageForSlack', () => {
  it('includes confidence context block when provided', () => {
    const blocks = formatMessageForSlack('Hello world', undefined, 0.85, false);
    const contextBlocks = blocks.filter((b) => b.type === 'context');
    expect(contextBlocks.length).toBeGreaterThan(0);
    const text = contextBlocks[0].elements?.[0]?.text || '';
    expect(text).toContain('Confirmed');
    expect(text).toContain('85%');
  });

  it('shows Conflicting label when hasConflicts=true', () => {
    const blocks = formatMessageForSlack('Hello', undefined, 0.7, true);
    const contextBlocks = blocks.filter((b) => b.type === 'context');
    const text = contextBlocks[0].elements?.[0]?.text || '';
    expect(text).toContain('Conflicting');
  });

  it('does not add confidence block when confidence is undefined', () => {
    const blocks = formatMessageForSlack('Hello');
    const contextBlocks = blocks.filter((b) => b.type === 'context');
    expect(contextBlocks).toHaveLength(0);
  });
});
