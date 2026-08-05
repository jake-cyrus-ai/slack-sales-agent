/**
 * Resolve human-readable Slack user names/emails to user IDs.
 *
 * Uses `users.list` with brief in-memory caching to avoid repeated pagination
 * within a single agent run.
 */

import { logger } from '../../lib/logger.js';

const log = logger.child({ util: 'slack-resolve-user' });

// ─── In-memory member cache (keyed by botToken hash) ─────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface SlackMember {
  id: string;
  realName: string;
  displayName: string;
  email: string;
}

interface MemberCache {
  expiresAt: number;
  members: SlackMember[];
}

const memberCache = new Map<string, MemberCache>();

function cacheKey(botToken: string): string {
  // Use last 12 chars of token as key (enough to differentiate, avoids storing full token)
  return botToken.slice(-12);
}

// ─── Fetch all workspace members with pagination ─────────────────────────────

async function fetchAllMembers(botToken: string): Promise<SlackMember[]> {
  const key = cacheKey(botToken);
  const cached = memberCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.members;
  }

  const members: SlackMember[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ limit: '200' });
    if (cursor) params.set('cursor', cursor);

    const resp = await fetch(`https://slack.com/api/users.list?${params}`, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    const data = (await resp.json()) as any;

    if (!data.ok) {
      log.error({ error: data.error }, 'users.list failed');
      throw new Error(`Slack users.list failed: ${data.error}`);
    }

    for (const m of data.members || []) {
      if (m.deleted || m.is_bot || m.id === 'USLACKBOT') continue;
      members.push({
        id: m.id,
        realName: (m.profile?.real_name || m.real_name || '').toLowerCase(),
        displayName: (m.profile?.display_name || '').toLowerCase(),
        email: (m.profile?.email || '').toLowerCase(),
      });
    }

    cursor = data.response_metadata?.next_cursor || undefined;
  } while (cursor);

  memberCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, members });
  log.info({ count: members.length }, 'Cached workspace members');
  return members;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface ResolvedUser {
  identifier: string;
  userId: string | null;
  displayName: string | null;
  /** Multiple matches — caller should disambiguate */
  ambiguous?: Array<{ userId: string; realName: string; displayName: string }>;
}

/**
 * Resolve one or more human-readable identifiers (name or email) to Slack user IDs.
 */
export async function resolveSlackUsers(
  botToken: string,
  identifiers: string[],
): Promise<ResolvedUser[]> {
  const members = await fetchAllMembers(botToken);
  const results: ResolvedUser[] = [];

  for (const raw of identifiers) {
    const trimmed = raw.trim();

    // Slack mention format: <@U0AFJCGRFHR> or <@U0AFJCGRFHR|display_name>
    const mentionMatch = trimmed.match(/^<@([A-Z0-9]+)(?:\|[^>]*)?>$/);
    if (mentionMatch) {
      const userId = mentionMatch[1];
      const member = members.find((m) => m.id === userId);
      results.push({
        identifier: raw,
        userId,
        displayName: member?.realName ?? null,
      });
      continue;
    }

    // Bare Slack user ID: U followed by alphanumeric (10+ chars)
    if (/^U[A-Z0-9]{8,}$/.test(trimmed)) {
      const member = members.find((m) => m.id === trimmed);
      results.push({
        identifier: raw,
        userId: trimmed,
        displayName: member?.realName ?? null,
      });
      continue;
    }

    const query = trimmed.toLowerCase();

    // Exact email match
    if (query.includes('@') && query.includes('.')) {
      const match = members.find((m) => m.email === query);
      results.push({
        identifier: raw,
        userId: match?.id ?? null,
        displayName: match?.realName ?? null,
      });
      continue;
    }

    // Name matching: exact first, then substring
    const exactMatches = members.filter(
      (m) => m.realName === query || m.displayName === query,
    );

    if (exactMatches.length === 1) {
      results.push({
        identifier: raw,
        userId: exactMatches[0].id,
        displayName: exactMatches[0].realName,
      });
      continue;
    }

    // Substring / partial match
    const partialMatches = members.filter(
      (m) => m.realName.includes(query) || m.displayName.includes(query),
    );

    if (partialMatches.length === 1) {
      results.push({
        identifier: raw,
        userId: partialMatches[0].id,
        displayName: partialMatches[0].realName,
      });
    } else if (partialMatches.length > 1 && partialMatches.length <= 5) {
      results.push({
        identifier: raw,
        userId: null,
        displayName: null,
        ambiguous: partialMatches.map((m) => ({
          userId: m.id,
          realName: m.realName,
          displayName: m.displayName,
        })),
      });
    } else {
      results.push({ identifier: raw, userId: null, displayName: null });
    }
  }

  return results;
}
