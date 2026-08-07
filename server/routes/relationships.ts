import { Router, type Response } from 'express';
import { z } from 'zod';
import { getAuth, requireAuth } from '../lib/auth';
import { getSupabaseForRequest } from '../lib/supabase';
import { getSupabaseAdmin } from '../workflows/utils/supabase';
import { validateBody } from '../lib/validate';
import type { Request } from '../types';

const router = Router();

const lifecycleStage = z.enum([
  'prospect', 'qualified', 'opportunity', 'customer', 'former_customer', 'partner',
]);

const createRelationshipSchema = z.object({
  organizationId: z.string().uuid(),
  kind: z.enum(['person', 'company']),
  canonicalName: z.string().trim().min(1).max(200),
  lifecycleStage: lifecycleStage.default('prospect'),
  externalIds: z.record(z.string(), z.string()).default({}),
  attributes: z.record(z.string(), z.unknown()).default({}),
}).strict();

const proposalSchema = z.object({
  lifecycleStage,
  evidence: z.array(z.object({ source: z.string(), sourceRef: z.string().optional() })).min(1),
  confidence: z.number().min(0).max(1),
  runId: z.string().max(256).optional(),
}).strict();

router.get('/relationships', requireAuth(), async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized', requestId: req.id });

  const organizationId = z.string().uuid().safeParse(req.query.organizationId);
  if (!organizationId.success) return res.status(400).json({ error: 'Valid organizationId is required', requestId: req.id });

  const db = getSupabaseForRequest(req);
  const { data, error } = await db
    .from('relationships')
    .select('id, kind, canonical_name, lifecycle_stage, owner_user_id, external_ids, attributes, version, updated_at')
    .eq('organization_id', organizationId.data)
    .order('canonical_name');
  if (error) return res.status(500).json({ error: error.message, requestId: req.id });
  return res.json({ relationships: data || [], requestId: req.id });
});

router.post('/relationships', requireAuth(), async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized', requestId: req.id });
  const body = validateBody(createRelationshipSchema, req, res);
  if (!body) return;

  const db = getSupabaseForRequest(req);
  const { data, error } = await db.from('relationships').insert({
    organization_id: body.organizationId,
    kind: body.kind,
    canonical_name: body.canonicalName,
    lifecycle_stage: body.lifecycleStage,
    external_ids: body.externalIds,
    attributes: body.attributes,
    updated_by: userId,
    update_source: 'user',
  }).select().single();
  if (error?.code === '23505') return res.status(409).json({ error: 'Relationship already exists; propose changes instead', requestId: req.id });
  if (error) return res.status(403).json({ error: error.message, requestId: req.id });
  return res.status(201).json({ relationship: data, requestId: req.id });
});

router.post('/relationships/:id/lifecycle-proposals', requireAuth(), async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized', requestId: req.id });
  const relationshipId = z.string().uuid().safeParse(req.params.id);
  if (!relationshipId.success) return res.status(400).json({ error: 'Invalid relationship id', requestId: req.id });
  const body = validateBody(proposalSchema, req, res);
  if (!body) return;

  const db = getSupabaseForRequest(req);
  const { data: relationship, error: readError } = await db
    .from('relationships')
    .select('id, organization_id, lifecycle_stage, version')
    .eq('id', relationshipId.data)
    .single();
  if (readError || !relationship) return res.status(404).json({ error: 'Relationship not found', requestId: req.id });
  if (relationship.lifecycle_stage === body.lifecycleStage) {
    return res.status(409).json({ error: 'Relationship already has that lifecycle stage', requestId: req.id });
  }

  const { data, error } = await db.from('relationship_change_proposals').insert({
    organization_id: relationship.organization_id,
    relationship_id: relationship.id,
    field_name: 'lifecycle_stage',
    before_value: relationship.lifecycle_stage,
    after_value: body.lifecycleStage,
    expected_version: relationship.version,
    evidence: body.evidence,
    confidence: body.confidence,
    requested_by_user_id: userId,
    requested_by_run_id: body.runId,
  }).select().single();
  if (error) return res.status(403).json({ error: error.message, requestId: req.id });
  return res.status(201).json({ proposal: data, requiresApproval: true, requestId: req.id });
});

router.post('/relationship-proposals/:id/approve', requireAuth(), async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized', requestId: req.id });
  const proposalId = z.string().uuid().safeParse(req.params.id);
  if (!proposalId.success) return res.status(400).json({ error: 'Invalid proposal id', requestId: req.id });

  const admin = getSupabaseAdmin();
  const { data, error } = await admin.rpc('apply_relationship_lifecycle_proposal', {
    p_proposal_id: proposalId.data,
    p_approving_user_id: userId,
  });
  if (error) return res.status(403).json({ error: error.message, requestId: req.id });
  return res.json({ result: data, requestId: req.id });
});

router.post('/relationship-proposals/:id/reject', requireAuth(), async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized', requestId: req.id });
  const proposalId = z.string().uuid().safeParse(req.params.id);
  if (!proposalId.success) return res.status(400).json({ error: 'Invalid proposal id', requestId: req.id });
  const db = getSupabaseForRequest(req);
  const { data, error } = await db.from('relationship_change_proposals')
    .update({ status: 'rejected', approved_by_user_id: userId, approved_at: new Date().toISOString() })
    .eq('id', proposalId.data).eq('status', 'pending').select('id, status').maybeSingle();
  if (error) return res.status(403).json({ error: error.message, requestId: req.id });
  if (!data) return res.status(409).json({ error: 'Proposal is no longer pending', requestId: req.id });
  return res.json({ proposal: data, requestId: req.id });
});

export default router;
