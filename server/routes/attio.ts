/**
 * Attio API routes.
 *
 * POST /api/attio/query — runs the Attio ReAct agent
 *
 * OAuth routes (connect, callback, status, disconnect) are in oauth.ts.
 */

import { Router, Response, NextFunction } from 'express';
import { getAuth } from '@clerk/express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Request } from '../types';
import { runAttioAgent, hasAttioConnection } from '../src/attio/index.js';

// ---------------------------------------------------------------------------
// Supabase admin client (lazy singleton)
// ---------------------------------------------------------------------------

let _supabaseAdmin: SupabaseClient | null = null;

const getSupabaseAdmin = (): SupabaseClient => {
  if (_supabaseAdmin) return _supabaseAdmin;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  _supabaseAdmin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return _supabaseAdmin;
};

// ---------------------------------------------------------------------------
// Helper: resolve org ID from Clerk session
// ---------------------------------------------------------------------------

async function resolveOrganizationId(
  supabase: SupabaseClient,
  userId: string,
  clerkOrgId: string | null | undefined,
): Promise<string | null> {
  if (clerkOrgId) {
    const { data: org } = await supabase
      .from('organizations')
      .select('id')
      .eq('clerk_id', clerkOrgId)
      .single();
    if (org?.id) return org.id;
  }

  const { data: membership } = await supabase
    .from('organization_users')
    .select('organization_id')
    .eq('user_id', userId)
    .order('joined_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  return membership?.organization_id ?? null;
}

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/attio/query
// ---------------------------------------------------------------------------

router.post('/query', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { query, history } = req.body;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({
        error: 'Missing required field: query',
        requestId: req.id,
      });
    }

    // Authenticate and resolve org
    const auth = getAuth(req);
    if (!auth.userId) {
      return res.status(401).json({
        error: 'Authentication required',
        requestId: req.id,
      });
    }

    const supabase = getSupabaseAdmin();
    const orgId = await resolveOrganizationId(supabase, auth.userId, auth.orgId);

    if (!orgId || !(await hasAttioConnection(orgId))) {
      return res.status(503).json({
        error: 'Attio is not configured. Connect Attio from your Profile page.',
        requestId: req.id,
      });
    }

    const conversationHistory: Array<{ role: string; content: string }> = [];
    if (Array.isArray(history)) {
      for (const msg of history) {
        if (msg && typeof msg.role === 'string' && typeof msg.content === 'string') {
          conversationHistory.push({ role: msg.role, content: msg.content });
        }
      }
    }

    req.log.info({ query, historyLength: conversationHistory.length }, 'Attio agent query');

    const result = await runAttioAgent({
      query,
      history: conversationHistory,
      organizationId: orgId,
    });

    req.log.info('Attio agent completed');

    res.json({
      response: result.response,
      requestId: req.id,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
