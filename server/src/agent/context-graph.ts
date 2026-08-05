/**
 * Context Graph — pre-fetch entity data before agents run.
 *
 * Provides `getSnapshot()` which loads user, deal, account, contacts,
 * and stage definitions in parallel. Results are cached in-memory with
 * a short TTL to avoid redundant DB queries within a single orchestrator run.
 */

import { supabase } from '../lib/supabase.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface UserSnapshot {
  name: string | null;
  email: string | null;
  company: string | null;
  title: string | null;
  timezone: string | null;
}

export interface DealSnapshot {
  id: string;
  name: string;
  stage: string;
  amount: number | null;
  close_date: string | null;
  owner: string | null;
  account_id: string | null;
}

export interface AccountSnapshot {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
}

export interface ContactSnapshot {
  id: string;
  name: string;
  email: string;
  title: string | null;
  role: string | null;
}

export interface StageDefinition {
  stage_num: number;
  name: string;
  playbook_pointers: string[];
}

export interface ContextSnapshot {
  user: UserSnapshot;
  deal: DealSnapshot | null;
  account: AccountSnapshot | null;
  contacts: ContactSnapshot[];
  stage_definitions: StageDefinition[];
}

// ─── In-memory cache ────────────────────────────────────────────────────────

const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes — short TTL since context is cheap to fetch

interface CacheEntry {
  snapshot: ContextSnapshot;
  expires_at: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(params: GetSnapshotParams): string {
  return `${params.org_id}:${params.user_id}:${params.deal_id || ''}:${params.account_id || ''}`;
}

// ─── Snapshot fetchers ──────────────────────────────────────────────────────

async function fetchUser(userId: string): Promise<UserSnapshot> {
  try {
    const { data } = await supabase
      .from('profiles')
      .select('first_name, last_name, email, company, timezone, title')
      .eq('user_id', userId)
      .single();

    if (!data) return { name: null, email: null, company: null, title: null, timezone: null };

    return {
      name: [data.first_name, data.last_name].filter(Boolean).join(' ') || null,
      email: data.email || null,
      company: data.company || null,
      title: data.title || null,
      timezone: data.timezone || null,
    };
  } catch {
    return { name: null, email: null, company: null, title: null, timezone: null };
  }
}

async function fetchDeal(_dealId: string): Promise<DealSnapshot | null> {
  // SFDC deal lookup — depends on org having Salesforce connected.
  // For now, return null. Phase 2a (SalesAgent) will populate this
  // by calling sfdc_opportunities tool and caching the result.
  // Future: direct SFDC query here once connection is standardized.
  return null;
}

async function fetchAccount(_accountId: string): Promise<AccountSnapshot | null> {
  // Same as fetchDeal — will be populated when SFDC is fully integrated.
  return null;
}

async function fetchContacts(_accountId: string): Promise<ContactSnapshot[]> {
  return [];
}

async function fetchStageDefinitions(_orgId: string): Promise<StageDefinition[]> {
  // Stage definitions come from org's playbook configuration.
  // Default B2B SaaS stages as fallback until playbook config is built.
  return [
    { stage_num: 1, name: 'Prospecting', playbook_pointers: ['outreach', 'qualification'] },
    { stage_num: 2, name: 'Discovery', playbook_pointers: ['discovery_call', 'needs_analysis'] },
    { stage_num: 3, name: 'Proposal', playbook_pointers: ['proposal', 'business_case', 'demo'] },
    { stage_num: 4, name: 'Negotiation', playbook_pointers: ['negotiation', 'procurement', 'legal'] },
    { stage_num: 5, name: 'Closed Won', playbook_pointers: ['onboarding', 'handoff'] },
    { stage_num: 6, name: 'Closed Lost', playbook_pointers: ['loss_review'] },
  ];
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface GetSnapshotParams {
  org_id: string;
  user_id: string;
  deal_id?: string;
  account_id?: string;
  contact_id?: string;
}

/**
 * Fetch a context snapshot for the current orchestrator run.
 * All DB queries run in parallel. Results are cached for 5 minutes.
 */
export async function getSnapshot(params: GetSnapshotParams): Promise<ContextSnapshot> {
  const key = cacheKey(params);
  const cached = cache.get(key);
  if (cached && cached.expires_at > Date.now()) {
    return cached.snapshot;
  }

  // Run all fetches in parallel
  const [user, deal, account, contacts, stageDefinitions] = await Promise.all([
    fetchUser(params.user_id),
    params.deal_id ? fetchDeal(params.deal_id) : Promise.resolve(null),
    params.account_id ? fetchAccount(params.account_id) : Promise.resolve(null),
    params.account_id ? fetchContacts(params.account_id) : Promise.resolve([]),
    fetchStageDefinitions(params.org_id),
  ]);

  const snapshot: ContextSnapshot = {
    user,
    deal,
    account,
    contacts,
    stage_definitions: stageDefinitions,
  };

  cache.set(key, { snapshot, expires_at: Date.now() + CACHE_TTL_MS });
  return snapshot;
}

/**
 * Invalidate cached snapshots for an org (e.g. after a CRM write).
 *
 * TODO: Call this from SFDC/Attio write tools (update-opportunity, create-account,
 * create-deal, update-deal) once the deal/account fetchers are implemented.
 * Currently fetchers are stubs (return null), so invalidation has no effect.
 */
export function invalidateCache(orgId: string): void {
  for (const [key] of cache) {
    if (key.startsWith(orgId + ':')) {
      cache.delete(key);
    }
  }
}
