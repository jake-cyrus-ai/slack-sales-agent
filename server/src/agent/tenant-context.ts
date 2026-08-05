const TTL_MS = 5 * 60 * 1000;
const CONSUMER_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'icloud.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
  'mail.com',
]);

export interface TenantContext {
  trustedDomains: string[];
  primaryUserDomain: string | null;
  organizationId: string | null;
  resolvedAt: number;
  cacheHit?: boolean;
}

type CacheEntry = {
  expiresAt: number;
  value: TenantContext;
};

const tenantContextCache = new Map<string, CacheEntry>();

export interface TenantContextLoader {
  loadProfileEmail: (userId: string) => Promise<string | null>;
  loadCalendarEmails: (userId: string, organizationId: string | null) => Promise<string[]>;
  loadSlackAllowedDomains: (organizationId: string | null) => Promise<string[]>;
  loadAgentEmailAddresses: (organizationId: string | null) => Promise<string[]>;
}

export async function resolveTenantContext(
  userId: string,
  organizationId: string | null,
  userEmail: string | null,
  loader: TenantContextLoader = createSupabaseLoader()
): Promise<TenantContext> {
  const key = `${organizationId || 'no-org'}:${userId}`;
  const now = Date.now();
  const cached = tenantContextCache.get(key);
  if (cached && cached.expiresAt > now) {
    return { ...cached.value, cacheHit: true };
  }

  const primaryFromInput = extractDomain(userEmail || '');
  const domains = new Set<string>();
  if (primaryFromInput && isBusinessDomain(primaryFromInput)) domains.add(primaryFromInput);

  // Fetch profile email if needed.
  if (!primaryFromInput) {
    const profileEmail = await loader.loadProfileEmail(userId);
    const profileDomain = extractDomain(profileEmail || '');
    if (profileDomain && isBusinessDomain(profileDomain)) domains.add(profileDomain);
  }

  // Calendar credential identities for same user/org.
  try {
    const calendarEmails = await loader.loadCalendarEmails(userId, organizationId);
    for (const email of calendarEmails) {
      const domain = extractDomain(email || '');
      if (domain && isBusinessDomain(domain)) domains.add(domain);
    }
  } catch {
    // Best-effort source.
  }

  // Slack workspace allowed domains for org.
  if (organizationId) {
    try {
      const allowedDomains = await loader.loadSlackAllowedDomains(organizationId);
      for (const d of allowedDomains) {
        const domain = normalizeDomain(d);
        if (domain && isBusinessDomain(domain)) domains.add(domain);
      }
    } catch {
      // Best-effort source.
    }

    // Optional org-level agent email domain.
    try {
      const agentEmails = await loader.loadAgentEmailAddresses(organizationId);
      for (const email of agentEmails) {
        const domain = extractDomain(email || '');
        if (domain && isBusinessDomain(domain)) domains.add(domain);
      }
    } catch {
      // Table may not exist in all environments.
    }
  }

  const trustedDomains = Array.from(domains);
  const primaryUserDomain = trustedDomains[0] || null;
  const resolved: TenantContext = {
    trustedDomains,
    primaryUserDomain,
    organizationId,
    resolvedAt: now,
    cacheHit: false,
  };

  tenantContextCache.set(key, {
    expiresAt: now + TTL_MS,
    value: resolved,
  });

  return resolved;
}

export function extractDomain(input: string): string | null {
  if (!input) return null;
  const match = input.match(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/i);
  if (match?.[1]) return normalizeDomain(match[1]);
  return normalizeDomain(input);
}

export function normalizeDomain(input: string): string | null {
  const cleaned = input.toLowerCase().trim().replace(/^@/, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!cleaned || !cleaned.includes('.')) return null;
  return cleaned;
}

export function isBusinessDomain(domain: string): boolean {
  const d = normalizeDomain(domain);
  if (!d) return false;
  return !CONSUMER_DOMAINS.has(d);
}

export function __resetTenantContextCacheForTests() {
  tenantContextCache.clear();
}

function createSupabaseLoader(): TenantContextLoader {
  return {
    async loadProfileEmail(userId: string) {
      const supabase = await getSupabaseClient();
      const { data: profile } = await supabase
        .from('profiles')
        .select('email')
        .eq('user_id', userId)
        .maybeSingle();
      return profile?.email || null;
    },
    async loadCalendarEmails(userId: string, organizationId: string | null) {
      const supabase = await getSupabaseClient();
      let calendarQuery = supabase
        .from('calendar_credentials')
        .select('calendar_email')
        .eq('user_id', userId)
        .limit(10);
      if (organizationId) {
        calendarQuery = calendarQuery.eq('organization_id', organizationId);
      }
      const { data: calendarCreds } = await calendarQuery;
      return (calendarCreds || []).map((cred: { calendar_email?: string }) => cred?.calendar_email).filter(Boolean);
    },
    async loadSlackAllowedDomains(organizationId: string | null) {
      if (!organizationId) return [];
      const supabase = await getSupabaseClient();
      const { data: workspaces } = await supabase
        .from('slack_workspaces')
        .select('allowed_domains')
        .eq('organization_id', organizationId)
        .eq('is_active', true)
        .limit(10);
      return (workspaces || []).flatMap((ws: { allowed_domains?: string[] }) => ws?.allowed_domains || []).filter(Boolean);
    },
    async loadAgentEmailAddresses(organizationId: string | null) {
      if (!organizationId) return [];
      const supabase = await getSupabaseClient();
      const { data: agentCreds } = await supabase
        .from('agent_email_credentials')
        .select('email_address')
        .eq('organization_id', organizationId)
        .limit(5);
      return (agentCreds || []).map((cred: { email_address?: string }) => cred?.email_address).filter(Boolean);
    },
  };
}

import type { SupabaseClient } from '@supabase/supabase-js';
let supabaseClientPromise: Promise<SupabaseClient> | null = null;
async function getSupabaseClient(): Promise<SupabaseClient> {
  if (!supabaseClientPromise) {
    supabaseClientPromise = import('../lib/supabase.js').then((m) => m.supabase);
  }
  return supabaseClientPromise;
}
