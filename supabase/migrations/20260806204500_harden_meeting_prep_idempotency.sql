-- Meeting preparation must be exactly-once at the Slack delivery boundary.

-- Allow an explicit in-flight state while a provider call is executing.
ALTER TABLE public.idempotency_keys
  DROP CONSTRAINT IF EXISTS idempotency_keys_status_check;

ALTER TABLE public.idempotency_keys
  ADD CONSTRAINT idempotency_keys_status_check
  CHECK (status IN ('started', 'executing', 'completed', 'failed'));

-- The application upserts this cache on event_id. Make that conflict target
-- real, after collapsing any historical duplicates to the newest row.
DELETE FROM public.meeting_prep_cache older
USING public.meeting_prep_cache newer
WHERE older.event_id = newer.event_id
  AND older.event_id IS NOT NULL
  AND (older.generated_at, older.created_at, older.id)
      < (newer.generated_at, newer.created_at, newer.id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_prep_cache_event_unique
  ON public.meeting_prep_cache (event_id)
  WHERE event_id IS NOT NULL;

-- Mark already-successful prep runs as completed so enabling the corrected
-- scheduler cannot send one final duplicate for meetings handled before this
-- migration existed.
INSERT INTO public.idempotency_keys (
  organization_id,
  key,
  operation,
  status,
  result
)
SELECT DISTINCT ON (wr.org_id, wr.user_id, wr.metadata->>'eventId')
  wr.org_id,
  'meeting-prep:' || wr.user_id || ':' || (wr.metadata->>'eventId'),
  'meeting_prep_delivery',
  'completed',
  jsonb_build_object('backfilledFromWorkflowRunId', wr.id)
FROM public.workflow_runs wr
WHERE wr.workflow_kind = 'meeting_prep'
  AND wr.status = 'succeeded'
  AND wr.user_id IS NOT NULL
  AND NULLIF(wr.metadata->>'eventId', '') IS NOT NULL
ORDER BY wr.org_id, wr.user_id, wr.metadata->>'eventId', wr.ended_at DESC NULLS LAST
ON CONFLICT (organization_id, key, operation) DO NOTHING;
