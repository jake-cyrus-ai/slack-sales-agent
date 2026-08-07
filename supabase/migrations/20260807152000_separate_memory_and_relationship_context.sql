-- Separate durable context from historical artifacts and introduce canonical,
-- approval-gated relationship records.

UPDATE public.user_memories
SET category = CASE
  WHEN category = 'preference' THEN 'preference'
  WHEN category = 'fact' THEN 'relationship_fact'
  ELSE 'historical_artifact'
END,
metadata = CASE
  WHEN category IN ('preference', 'fact')
    THEN metadata
  ELSE metadata || '{"proactiveEligible":false}'::jsonb
END;

ALTER TABLE public.user_memories
  DROP CONSTRAINT IF EXISTS user_memories_category_check;

ALTER TABLE public.user_memories
  ADD CONSTRAINT user_memories_category_check
  CHECK (category IN ('preference', 'relationship_fact', 'correction', 'historical_artifact'));

CREATE INDEX IF NOT EXISTS idx_user_memories_proactive
  ON public.user_memories (user_id, organization_id, category, created_at DESC)
  WHERE category IN ('preference', 'relationship_fact', 'correction');

CREATE TABLE IF NOT EXISTS public.relationships (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('person', 'company')),
  canonical_name    text NOT NULL,
  lifecycle_stage   text NOT NULL DEFAULT 'prospect'
    CHECK (lifecycle_stage IN ('prospect', 'qualified', 'opportunity', 'customer', 'former_customer', 'partner')),
  owner_user_id     text,
  external_ids      jsonb NOT NULL DEFAULT '{}',
  attributes        jsonb NOT NULL DEFAULT '{}',
  version           bigint NOT NULL DEFAULT 1,
  updated_by        text,
  update_source     text NOT NULL DEFAULT 'user'
    CHECK (update_source IN ('user', 'salesforce', 'attio', 'agent')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, kind, canonical_name)
);

CREATE TABLE IF NOT EXISTS public.relationship_facts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  relationship_id   uuid NOT NULL REFERENCES public.relationships(id) ON DELETE CASCADE,
  user_id           text,
  predicate         text NOT NULL,
  value             jsonb NOT NULL,
  source             text NOT NULL CHECK (source IN ('explicit_user', 'crm', 'email', 'meeting', 'inferred')),
  source_ref         jsonb,
  confidence         numeric NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  valid_from         timestamptz NOT NULL DEFAULT now(),
  valid_until        timestamptz,
  last_verified_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.relationship_change_proposals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  relationship_id     uuid NOT NULL REFERENCES public.relationships(id) ON DELETE CASCADE,
  field_name           text NOT NULL CHECK (field_name IN ('lifecycle_stage')),
  before_value         jsonb NOT NULL,
  after_value          jsonb NOT NULL,
  expected_version     bigint NOT NULL,
  evidence             jsonb NOT NULL DEFAULT '[]',
  confidence           numeric NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  requested_by_user_id text,
  requested_by_run_id  text,
  status               text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'applied', 'conflict')),
  approved_by_user_id   text,
  approved_at           timestamptz,
  applied_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.relationship_change_history (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  relationship_id   uuid NOT NULL REFERENCES public.relationships(id) ON DELETE CASCADE,
  proposal_id       uuid REFERENCES public.relationship_change_proposals(id) ON DELETE SET NULL,
  field_name        text NOT NULL,
  before_value      jsonb,
  after_value       jsonb,
  changed_by_user_id text,
  source            text NOT NULL,
  evidence          jsonb NOT NULL DEFAULT '[]',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_relationships_org_stage
  ON public.relationships (organization_id, lifecycle_stage);
CREATE INDEX IF NOT EXISTS idx_relationship_facts_relationship
  ON public.relationship_facts (relationship_id, predicate, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_relationship_proposals_pending
  ON public.relationship_change_proposals (organization_id, status, created_at DESC);

ALTER TABLE public.relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.relationship_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.relationship_change_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.relationship_change_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members can read relationships" ON public.relationships FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id()));
CREATE POLICY "org admins can manage relationships" ON public.relationships FOR ALL
  USING (organization_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id() AND role IN ('owner', 'admin')));
CREATE POLICY "org members can read relationship facts" ON public.relationship_facts FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id()));
CREATE POLICY "org admins can manage relationship facts" ON public.relationship_facts FOR ALL
  USING (organization_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id() AND role IN ('owner', 'admin')));
CREATE POLICY "org members can read relationship proposals" ON public.relationship_change_proposals FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id()));
CREATE POLICY "org admins can manage relationship proposals" ON public.relationship_change_proposals FOR ALL
  USING (organization_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id() AND role IN ('owner', 'admin')));
CREATE POLICY "org members can read relationship history" ON public.relationship_change_history FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id()));

-- Apply one approved lifecycle change atomically. The expected version prevents
-- a stale approval from overwriting a newer canonical state.
CREATE OR REPLACE FUNCTION public.apply_relationship_lifecycle_proposal(
  p_proposal_id uuid,
  p_approving_user_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  proposal public.relationship_change_proposals%ROWTYPE;
  relationship public.relationships%ROWTYPE;
  approver_role text;
  next_stage text;
BEGIN
  SELECT * INTO proposal
  FROM public.relationship_change_proposals
  WHERE id = p_proposal_id
  FOR UPDATE;

  IF proposal.id IS NULL OR proposal.status <> 'pending' THEN
    RAISE EXCEPTION 'proposal is not pending';
  END IF;

  SELECT role INTO approver_role
  FROM public.organization_users
  WHERE organization_id = proposal.organization_id
    AND user_id = p_approving_user_id;

  IF approver_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'approver is not authorized';
  END IF;

  SELECT * INTO relationship
  FROM public.relationships
  WHERE id = proposal.relationship_id
    AND organization_id = proposal.organization_id
  FOR UPDATE;

  IF relationship.version <> proposal.expected_version
     OR to_jsonb(relationship.lifecycle_stage) <> proposal.before_value THEN
    UPDATE public.relationship_change_proposals
      SET status = 'conflict', approved_by_user_id = p_approving_user_id, approved_at = now()
    WHERE id = proposal.id;
    RETURN jsonb_build_object('status', 'conflict', 'currentVersion', relationship.version);
  END IF;

  next_stage := proposal.after_value #>> '{}';
  IF next_stage NOT IN ('prospect', 'qualified', 'opportunity', 'customer', 'former_customer', 'partner') THEN
    RAISE EXCEPTION 'invalid lifecycle stage';
  END IF;

  UPDATE public.relationships
    SET lifecycle_stage = next_stage,
        version = version + 1,
        updated_by = p_approving_user_id,
        update_source = 'agent',
        updated_at = now()
  WHERE id = relationship.id;

  UPDATE public.relationship_change_proposals
    SET status = 'applied', approved_by_user_id = p_approving_user_id,
        approved_at = now(), applied_at = now()
  WHERE id = proposal.id;

  INSERT INTO public.relationship_change_history (
    organization_id, relationship_id, proposal_id, field_name,
    before_value, after_value, changed_by_user_id, source, evidence
  ) VALUES (
    proposal.organization_id, proposal.relationship_id, proposal.id,
    proposal.field_name, proposal.before_value, proposal.after_value,
    p_approving_user_id, 'approved_agent_proposal', proposal.evidence
  );

  INSERT INTO public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id,
    run_id, outcome, metadata
  ) VALUES (
    proposal.organization_id, p_approving_user_id, 'relationship.lifecycle_changed',
    'relationship', relationship.id::text, proposal.requested_by_run_id, 'applied',
    jsonb_build_object('proposalId', proposal.id, 'before', proposal.before_value, 'after', proposal.after_value)
  );

  RETURN jsonb_build_object('status', 'applied', 'relationshipId', relationship.id, 'version', relationship.version + 1);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_relationship_lifecycle_proposal(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_relationship_lifecycle_proposal(uuid, text) TO service_role;
