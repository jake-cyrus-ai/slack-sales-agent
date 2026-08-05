-- =============================================================================

SET check_function_bodies = off;
-- Baseline schema for the Slack-Native Sales Agent Harness
--
-- This is a single sanitized migration containing the complete schema required
-- by the retained application. It replaces the full production migration trail.
--
-- Covers:
--   - Extensions (vector, pgcrypto)
--   - Enums and helper functions
--   - Core tables (orgs, users, auth)
--   - Integration credential tables (Slack, Google, Granola, Attio, Salesforce)
--   - Agent workflow tables (deals, emails, approvals, calendar, knowledge base)
--   - Onboarding tables
--   - Usage and analytics tables
--   - Autonomous handoff tables
--   - Prospect session tables (used by Autonomous data layer)
--   - RLS policies
--   - Indexes
--   - RPCs
-- =============================================================================

-- =============================================================================
-- Extensions
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;

-- A deployer provisions this singleton through `pnpm setup:supabase`. Keeping
-- the credential-encryption key out of migrations allows every installation to
-- bring its own key. RLS is enabled below and no client-facing policy is added.
CREATE TABLE IF NOT EXISTS public.app_secrets (
  name        text        PRIMARY KEY,
  value       text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- Enums
-- =============================================================================

DO $$ BEGIN
  CREATE TYPE public.user_role AS ENUM ('admin', 'member', 'owner');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- Core helper functions (used in RLS policies — must come before tables)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.current_user_id() RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    auth.jwt() ->> 'sub',
    (auth.jwt() -> 'user_metadata' ->> 'sub')
  );
$$;

CREATE OR REPLACE FUNCTION public.current_org_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT (auth.jwt() ->> 'org_id')::uuid;
$$;

CREATE OR REPLACE FUNCTION public.is_org_member(check_org_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_users
    WHERE organization_id = check_org_id
      AND user_id = public.current_user_id()
  );
$$;

-- Trigger function: update updated_at on every row modification
CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Trigger function: maintain tsvector column on user_memories
CREATE OR REPLACE FUNCTION public.update_user_memories_tsv() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.content_tsv := to_tsvector('english', COALESCE(NEW.content, ''));
  RETURN NEW;
END;
$$;

-- Trigger function: update workflow_runs counters
CREATE OR REPLACE FUNCTION public.update_workflow_run_counters() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.workflow_runs
    SET steps_count = steps_count + 1
    WHERE id = NEW.workflow_run_id;
  END IF;
  RETURN NEW;
END;
$$;

-- =============================================================================
-- Token encryption functions
-- =============================================================================

-- Internal key accessor. Only SECURITY DEFINER token functions may read this
-- value; browser and user-scoped clients have no table policy.
CREATE OR REPLACE FUNCTION public._get_encryption_key() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  encryption_key text;
BEGIN
  SELECT value INTO encryption_key
  FROM public.app_secrets
  WHERE name = 'credential_encryption_key';

  IF encryption_key IS NULL OR length(encryption_key) < 32 THEN
    RAISE EXCEPTION 'Credential encryption key is not provisioned. Run pnpm setup:supabase.';
  END IF;

  RETURN encryption_key;
END;
$$;

CREATE OR REPLACE FUNCTION public.encrypt_token(token text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  RETURN encode(
    extensions.pgp_sym_encrypt(token, public._get_encryption_key()),
    'base64'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.encrypt_token(access_token text, refresh_token text) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  key text := public._get_encryption_key();
BEGIN
  RETURN json_build_object(
    'encrypted_access',  encode(extensions.pgp_sym_encrypt(access_token,  key), 'base64'),
    'encrypted_refresh', encode(extensions.pgp_sym_encrypt(refresh_token, key), 'base64')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.decrypt_token(encrypted_token text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  RETURN extensions.pgp_sym_decrypt(
    decode(encrypted_token, 'base64'),
    public._get_encryption_key()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.decrypt_token(encrypted_access text, encrypted_refresh text) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  key text := public._get_encryption_key();
BEGIN
  RETURN json_build_object(
    'access_token',  extensions.pgp_sym_decrypt(decode(encrypted_access,  'base64'), key),
    'refresh_token', extensions.pgp_sym_decrypt(decode(encrypted_refresh, 'base64'), key)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.encrypt_slack_token(token text, encryption_key text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  RETURN encode(extensions.pgp_sym_encrypt(token, encryption_key), 'base64');
END;
$$;

CREATE OR REPLACE FUNCTION public.decrypt_slack_token(encrypted_token text, encryption_key text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  RETURN extensions.pgp_sym_decrypt(decode(encrypted_token, 'base64'), encryption_key);
END;
$$;

-- Credential helpers are backend-only. Supabase functions are executable by
-- PUBLIC unless explicitly restricted, so fail closed here.
REVOKE ALL ON FUNCTION public._get_encryption_key() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.encrypt_token(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.encrypt_token(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decrypt_token(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decrypt_token(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.encrypt_slack_token(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decrypt_slack_token(text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.encrypt_token(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.encrypt_token(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.decrypt_token(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.decrypt_token(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.encrypt_slack_token(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.decrypt_slack_token(text, text) TO service_role;

-- =============================================================================
-- Core tables
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.organizations (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  slug        text        UNIQUE,
  logo_url    text,
  owner_user_id text,
  settings    jsonb       NOT NULL DEFAULT '{}',
  feature_flags jsonb     NOT NULL DEFAULT '{}',
  clerk_id    text        UNIQUE,
  autonomous_agent_user_id text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.organization_users (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         text        NOT NULL,
  role            text        NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  joined_at       timestamptz NOT NULL DEFAULT now(),
  invited_by      text
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_organization_users_unique
  ON public.organization_users (user_id, organization_id);

CREATE TABLE IF NOT EXISTS public.organization_invites (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  token           text        UNIQUE NOT NULL,
  email           text,
  role            text        NOT NULL CHECK (role IN ('admin', 'member')) DEFAULT 'member',
  status          text        NOT NULL CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')) DEFAULT 'pending',
  expires_at      timestamptz,
  created_by      text,
  accepted_by     text,
  accepted_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.profiles (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              text        UNIQUE NOT NULL,
  first_name           text,
  last_name            text,
  email                text,
  company              text,
  linkedin_profile     text,
  title                text,
  user_context         text,
  cookie_consent       text,
  cookie_consent_date  timestamptz,
  feature_flags        jsonb       NOT NULL DEFAULT '{}',
  profile_completed    boolean     NOT NULL DEFAULT false,
  avatar_url           text,
  timezone             text        NOT NULL DEFAULT 'America/New_York',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_roles (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    text        NOT NULL,
  role       public.user_role NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);

CREATE TABLE IF NOT EXISTS public.ai_config (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- Contact and conversation tables
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.contacts (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             text        NOT NULL,
  organization_id     uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  first_name          text,
  last_name           text,
  full_name           text,
  email               text,
  phone               text,
  title               text,
  company_name        text,
  company_domain      text,
  department          text,
  linkedin_url        text,
  twitter_url         text,
  relationship_type   text        CHECK (relationship_type IN ('prospect', 'customer', 'partner', 'vendor', 'colleague', 'other')),
  relationship_strength text      CHECK (relationship_strength IN ('strong', 'moderate', 'weak', 'none')),
  first_contact_date  date,
  last_contact_date   date,
  last_meeting_date   date,
  next_follow_up_date date,
  total_meetings      int         NOT NULL DEFAULT 0,
  total_emails        int         NOT NULL DEFAULT 0,
  notes               text,
  tags                text[]      DEFAULT '{}',
  custom_fields       jsonb       NOT NULL DEFAULT '{}',
  source              text        NOT NULL DEFAULT 'manual',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_user_email
  ON public.contacts (user_id, email);

CREATE TABLE IF NOT EXISTS public.contact_enrichment (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id                  uuid        UNIQUE REFERENCES public.contacts(id) ON DELETE CASCADE,
  linkedin_headline           text,
  linkedin_summary            text,
  linkedin_profile_image_url  text,
  linkedin_connections        int,
  linkedin_last_updated       timestamptz,
  web_research_summary        text,
  web_research_sources        jsonb,
  web_research_last_updated   timestamptz,
  company_size_range          text,
  company_industry            text,
  company_recent_news         jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.conversations (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             text        NOT NULL,
  organization_id     uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  title               text        NOT NULL DEFAULT 'New chat',
  archived            boolean     NOT NULL DEFAULT false,
  conversation_type   varchar,
  source              text        NOT NULL DEFAULT 'web',
  is_training_approved boolean    NOT NULL DEFAULT true,
  quality_score       int         CHECK (quality_score BETWEEN 1 AND 5),
  training_notes      text,
  is_sensitive        boolean,
  anonymized_version_id uuid      REFERENCES public.conversations(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.chat_messages (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid        NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  role            text        NOT NULL CHECK (role IN ('user', 'assistant')),
  content         text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.conversation_feedback (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid        REFERENCES public.conversations(id) ON DELETE CASCADE,
  message_id      text,
  user_id         text        NOT NULL,
  feedback_type   varchar     CHECK (feedback_type IN ('thumbs_up', 'thumbs_down', 'flag', 'edit_suggestion')),
  feedback_value  jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- Deals
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.deals (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             text        NOT NULL,
  organization_id     uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  company_name        text        NOT NULL,
  contact_name        text,
  contact_email       text,
  status              text        CHECK (status IN ('Active', 'Won', 'Lost', 'Paused')) DEFAULT 'Active',
  value               numeric,
  stage               text        DEFAULT 'Lead',
  last_activity       date,
  next_milestone      text,
  days_until_milestone int,
  health_score        int         CHECK (health_score BETWEEN 0 AND 100),
  notes               text,
  agent_mode          text        NOT NULL DEFAULT 'autonomous' CHECK (agent_mode IN ('autonomous', 'copilot', 'off')),
  assigned_rep_user_id text,
  crm_signal_hash     text,
  alerted_signals     jsonb       NOT NULL DEFAULT '[]',
  muted_signals       jsonb       NOT NULL DEFAULT '[]',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- Notifications and reminders
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.notifications (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text        NOT NULL,
  type        text        NOT NULL,
  title       text,
  message     text,
  channel     text,
  deal_name   text,
  metadata    jsonb,
  read        boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pending_actions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text        NOT NULL,
  organization_id uuid,
  action_type     text        NOT NULL,
  payload         jsonb       NOT NULL DEFAULT '{}',
  rationale       text,
  evidence        jsonb       NOT NULL DEFAULT '[]',
  status          text        NOT NULL DEFAULT 'pending',
  slack_channel_id text,
  slack_message_ts text,
  run_id          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  resolved_by     text
);

CREATE TABLE IF NOT EXISTS public.audit_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  actor_user_id   text,
  event_type      text        NOT NULL,
  target_type     text,
  target_id       text,
  run_id          text,
  outcome         text,
  metadata        jsonb       NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_org_created
  ON public.audit_events (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  key             text        NOT NULL,
  operation       text        NOT NULL,
  status          text        NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'completed', 'failed')),
  result          jsonb,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key, operation)
);

CREATE TABLE IF NOT EXISTS public.reminders (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text        NOT NULL,
  organization_id text,
  reminder_text   text        NOT NULL,
  trigger_at      timestamptz NOT NULL,
  status          text        NOT NULL CHECK (status IN ('pending', 'firing', 'sent', 'dismissed', 'snoozed', 'cancelled')) DEFAULT 'pending',
  snoozed_until   timestamptz,
  slack_message_ts text,
  source          text        NOT NULL DEFAULT 'chat' CHECK (source IN ('chat', 'slack', 'meeting_followup', 'system')),
  source_ref      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- Calendar
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.calendar_credentials (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               text        NOT NULL,
  organization_id       uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  access_token_encrypted text,
  refresh_token_encrypted text,
  token_expiry          timestamptz,
  calendar_email        text,
  scopes                text[],
  connected_at          timestamptz,
  last_synced_at        timestamptz,
  last_sync             timestamptz,
  last_sync_attempt     timestamptz,
  last_error            text,
  last_error_at         timestamptz,
  sync_status           text        CHECK (sync_status IN ('active', 'expired', 'disconnected', 'error', 'auth_required')) DEFAULT 'active',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.calendar_events (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               text        NOT NULL,
  organization_id       uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  google_event_id       text        NOT NULL,
  calendar_id           text        NOT NULL DEFAULT 'primary',
  summary               text,
  description           text,
  location              text,
  start_time            timestamptz,
  end_time              timestamptz,
  timezone              text,
  attendees             jsonb       NOT NULL DEFAULT '[]',
  organizer             jsonb,
  event_type            text,
  is_all_day            boolean     NOT NULL DEFAULT false,
  status                text        NOT NULL DEFAULT 'confirmed',
  visibility            text        NOT NULL DEFAULT 'default',
  prep_completed        boolean     NOT NULL DEFAULT false,
  prep_last_generated_at timestamptz,
  recurring_event_id    text,
  is_recurring_instance boolean     NOT NULL DEFAULT false,
  html_link             text,
  created               timestamptz,
  updated               timestamptz,
  synced_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_events_user_google
  ON public.calendar_events (user_id, google_event_id);

CREATE TABLE IF NOT EXISTS public.langgraph_workflow_runs (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               text        NOT NULL,
  event_id              uuid        REFERENCES public.calendar_events(id) ON DELETE SET NULL,
  thread_id             text,
  run_id                text,
  status                text        CHECK (status IN ('running', 'interrupted', 'completed', 'failed')),
  workflow_type         text        NOT NULL DEFAULT 'meeting_prep',
  attendees_to_research jsonb       NOT NULL DEFAULT '[]',
  attendees_completed   jsonb       NOT NULL DEFAULT '[]',
  research_decisions    jsonb       NOT NULL DEFAULT '{}',
  awaiting_approval     boolean     NOT NULL DEFAULT false,
  approval_requested_at timestamptz,
  approval_received_at  timestamptz,
  approval_decision     text,
  approval_notes        text,
  final_prep_content    text,
  sources_used          jsonb       NOT NULL DEFAULT '[]',
  total_cost_usd        numeric,
  llm_calls_count       int         NOT NULL DEFAULT 0,
  api_calls_count       int         NOT NULL DEFAULT 0,
  error_message         text,
  started_at            timestamptz,
  completed_at          timestamptz,
  total_duration_ms     int,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.meeting_prep_cache (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               text        NOT NULL,
  organization_id       uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  event_id              uuid        REFERENCES public.calendar_events(id) ON DELETE CASCADE,
  workflow_run_id       uuid        REFERENCES public.langgraph_workflow_runs(id) ON DELETE SET NULL,
  prep_content          text,
  prep_summary          text,
  knowledge_base_sources jsonb      NOT NULL DEFAULT '[]',
  deal_context          jsonb,
  web_research_sources  jsonb       NOT NULL DEFAULT '[]',
  generation_method     text        CHECK (generation_method IN ('deterministic', 'langgraph_agent')),
  confidence_score      numeric,
  research_depth        text        CHECK (research_depth IN ('minimal', 'standard', 'deep')),
  generated_at          timestamptz,
  expires_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.processed_meetings (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             text        NOT NULL,
  organization_id     uuid,
  source              text        NOT NULL,
  external_meeting_id text        NOT NULL,
  meeting_title       text,
  meeting_end_time    timestamptz,
  status              text        CHECK (status IN ('pending', 'sent', 'dismissed', 'error')),
  workflow_run_id     uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_processed_meetings_unique
  ON public.processed_meetings (user_id, source, external_meeting_id);

-- =============================================================================
-- Slack tables
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.slack_workspaces (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid        REFERENCES public.organizations(id) ON DELETE SET NULL,
  team_id               text        NOT NULL,
  team_name             text,
  bot_token             text,
  bot_user_id           text,
  access_token          text,
  slack_app_id          text,
  allowed_domains       text[]      NOT NULL DEFAULT '{}',
  installed_at          timestamptz,
  installed_by_user_id  text,
  is_active             boolean     NOT NULL DEFAULT true,
  settings              jsonb       NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_slack_workspaces_team_app
  ON public.slack_workspaces (team_id, COALESCE(slack_app_id, 'legacy'));

CREATE TABLE IF NOT EXISTS public.slack_user_mappings (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slack_workspace_id  uuid        REFERENCES public.slack_workspaces(id) ON DELETE CASCADE,
  organization_id     uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  slack_user_id       text        NOT NULL,
  slack_email         text,
  agent_user_id       text,
  linked_at           timestamptz,
  last_active_at      timestamptz,
  is_active           boolean     NOT NULL DEFAULT true,
  metadata            jsonb       NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_slack_user_mappings_unique
  ON public.slack_user_mappings (slack_workspace_id, slack_user_id);

CREATE TABLE IF NOT EXISTS public.slack_thread_conversations (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slack_workspace_id  uuid        REFERENCES public.slack_workspaces(id) ON DELETE CASCADE,
  slack_channel_id    text        NOT NULL,
  slack_thread_ts     text        NOT NULL,
  conversation_id     uuid        REFERENCES public.conversations(id) ON DELETE SET NULL,
  agent_user_id       text,
  metadata            jsonb       NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_message_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_slack_thread_conversations_unique
  ON public.slack_thread_conversations (slack_workspace_id, slack_channel_id, slack_thread_ts);

CREATE TABLE IF NOT EXISTS public.slack_error_events (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at           timestamptz NOT NULL DEFAULT now(),
  resolved_at           timestamptz,
  organization_id       uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  agent_user_id         text,
  slack_user_id         text,
  slack_team_id         text,
  slack_channel_id      text,
  slack_thread_ts       text,
  thinking_ts           text,
  thread_permalink      text,
  conversation_id       uuid,
  workflow_run_id        text,
  workflow_function_id   text,
  attempt               int,
  step                  text,
  error_name            text,
  error_message         text,
  error_stack           text,
  error_category        text,
  user_message          text,
  classified_intent     text,
  domain_signals        jsonb,
  agent_state           jsonb,
  sanitized_event_payload jsonb,
  backup_outcome        text,
  backup_response_preview text
);

CREATE TABLE IF NOT EXISTS public.organization_slack_settings (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid        UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  slack_workspace_id  uuid        REFERENCES public.slack_workspaces(id),
  default_channel_id  text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- OAuth tables
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.oauth_states (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         text,
  provider        text        CHECK (provider IN ('slack_bot', 'slack_user', 'google_workspace')),
  invite_token    text,
  status          text        NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'expired')) DEFAULT 'pending',
  redirect_uri    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '10 minutes')
);

CREATE TABLE IF NOT EXISTS public.oauth_connections (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         text,
  provider        text        CHECK (provider IN ('slack_bot', 'slack_user', 'google_workspace')),
  access_token    text,
  refresh_token   text,
  scopes          text[]      NOT NULL DEFAULT '{}',
  expires_at      timestamptz,
  metadata        jsonb       NOT NULL DEFAULT '{}',
  is_active       boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- Gmail
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.gmail_poll_state (
  user_id         text        PRIMARY KEY,
  last_history_id bigint,
  last_poll_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.gmail_watch_subscriptions (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             text        UNIQUE NOT NULL,
  history_id          bigint,
  expiration          timestamptz,
  topic_name          text,
  label_ids           text[]      NOT NULL DEFAULT '{INBOX}',
  include_spam_trash  boolean     NOT NULL DEFAULT false,
  is_active           boolean     NOT NULL DEFAULT true,
  last_notification_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.agent_email_credentials (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid        UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  email_address       text        UNIQUE NOT NULL,
  display_name        text        NOT NULL DEFAULT 'Sales Agent',
  refresh_token       text,
  access_token        text,
  token_expires_at    timestamptz,
  provider            text        NOT NULL DEFAULT 'google',
  is_active           boolean     NOT NULL DEFAULT true,
  last_verified_at    timestamptz,
  verification_status text        CHECK (verification_status IN ('pending', 'verified', 'failed')),
  metadata            jsonb       NOT NULL DEFAULT '{}',
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- Granola
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.granola_credentials (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 text        UNIQUE NOT NULL,
  organization_id         uuid,
  access_token_encrypted  text,
  refresh_token_encrypted text,
  token_expiry            timestamptz,
  oauth_client_id         text,
  oauth_client_secret     text,
  oauth_token_endpoint    text,
  granola_email           text,
  scopes                  text[],
  connected_at            timestamptz,
  sync_status             text        CHECK (sync_status IN ('active', 'expired', 'disconnected', 'error')) DEFAULT 'active',
  last_error              text,
  last_error_at           timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.granola_oauth_pending (
  state                  text        PRIMARY KEY,
  user_id                text        NOT NULL,
  organization_id        uuid,
  code_verifier          text,
  client_id              text,
  client_secret          text,
  token_endpoint         text,
  authorization_endpoint text,
  registration_endpoint  text,
  redirect_uri           text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL DEFAULT (now() + interval '10 minutes')
);

-- =============================================================================
-- Attio
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.attio_credentials (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid        UNIQUE,
  connected_by_user_id    text,
  access_token_encrypted  text        NOT NULL DEFAULT '',
  refresh_token_encrypted text,
  attio_workspace_id      text,
  workspace_name          text,
  workspace_slug          text,
  oauth_client_id         text,
  oauth_client_secret     text,
  oauth_token_endpoint    text,
  token_expiry            timestamptz,
  scopes                  text[],
  connected_at            timestamptz,
  status                  text        CHECK (status IN ('active', 'disconnected', 'error', 'expired')) DEFAULT 'active',
  last_error              text,
  last_error_at           timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.attio_oauth_pending (
  state           text        PRIMARY KEY,
  user_id         text        NOT NULL,
  organization_id uuid,
  code_verifier   text,
  client_id       text,
  client_secret   text,
  token_endpoint  text,
  redirect_uri    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '10 minutes')
);

-- =============================================================================
-- Salesforce
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.salesforce_credentials (
  id                            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id               uuid        UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  instance_url                  text,
  salesforce_org_id             text,
  organization_name             text,
  access_token_encrypted        text,
  refresh_token_encrypted       text,
  token_expiry                  timestamptz,
  oauth_client_id               text,
  oauth_client_secret_encrypted text,
  connected_by_user_id          text,
  sync_status                   text        CHECK (sync_status IN ('active', 'expired', 'disconnected', 'error')) DEFAULT 'active',
  connected_at                  timestamptz,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- Email tables
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.incoming_emails (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   text        NOT NULL,
  organization_id           uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  gmail_message_id          text,
  gmail_thread_id           text,
  gmail_history_id          bigint,
  from_email                text,
  from_name                 text,
  from_domain               text,
  to_email                  text,
  subject                   text,
  body_text                 text,
  body_html                 text,
  snippet                   text,
  received_at               timestamptz,
  has_attachments           boolean     NOT NULL DEFAULT false,
  attachment_count          int         NOT NULL DEFAULT 0,
  is_reply                  boolean     NOT NULL DEFAULT false,
  in_reply_to               text,
  message_id_header         text,
  labels                    text[],
  classification            text        CHECK (classification IN ('customer_prospect', 'vendor', 'spam', 'internal', 'newsletter', 'other', 'automated')),
  classification_confidence float,
  classification_reasoning  text,
  qualification_category    text        CHECK (qualification_category IN ('inbound_prospect', 'existing_customer', 'vendor', 'partner', 'internal', 'other', 'skip')),
  qualification_reasoning   text,
  qualification_confidence  numeric,
  qualified_at              timestamptz,
  priority                  text        NOT NULL DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),
  triage_labels             text[]      NOT NULL DEFAULT '{}',
  triaged_at                timestamptz,
  status                    text        CHECK (status IN ('pending', 'processing', 'draft_ready', 'approved', 'sent', 'rejected', 'skipped', 'failed')) DEFAULT 'pending',
  processed_at              timestamptz,
  agent_workflow_run_id     uuid,
  error_message             text,
  metadata                  jsonb       NOT NULL DEFAULT '{}',
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.email_thread_conversations (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               text        NOT NULL,
  organization_id       uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  gmail_thread_id       text        NOT NULL,
  from_email            text,
  from_name             text,
  from_domain           text,
  subject               text,
  message_count         int         NOT NULL DEFAULT 1,
  our_reply_count       int         NOT NULL DEFAULT 0,
  their_reply_count     int         NOT NULL DEFAULT 0,
  last_message_at       timestamptz,
  last_our_reply_at     timestamptz,
  last_their_reply_at   timestamptz,
  conversation_stage    text        NOT NULL DEFAULT 'intro' CHECK (conversation_stage IN ('intro', 'discovery', 'demo', 'negotiation', 'procurement', 'proposal', 'closed_won', 'closed_lost', 'nurture', 'meeting_scheduled')),
  stage_updated_at      timestamptz,
  contact_id            uuid        REFERENCES public.contacts(id) ON DELETE SET NULL,
  deal_id               uuid        REFERENCES public.deals(id) ON DELETE SET NULL,
  next_followup_at      timestamptz,
  followup_count        int         NOT NULL DEFAULT 0,
  max_followups         int         NOT NULL DEFAULT 3,
  followup_status       text        CHECK (followup_status IN ('active', 'paused', 'completed', 'cancelled')),
  last_agent_reasoning  text,
  last_confidence_score numeric,
  metadata              jsonb       NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_thread_conversations_unique
  ON public.email_thread_conversations (user_id, gmail_thread_id);

CREATE TABLE IF NOT EXISTS public.email_auto_response_drafts (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  incoming_email_id       uuid        REFERENCES public.incoming_emails(id) ON DELETE SET NULL,
  thread_conversation_id  uuid        REFERENCES public.email_thread_conversations(id) ON DELETE SET NULL,
  user_id                 text        NOT NULL,
  organization_id         uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  subject                 text,
  body                    text,
  original_ai_body        text,
  to_email                text,
  to_name                 text,
  reply_to_email          text,
  send_as                 text        NOT NULL DEFAULT 'user' CHECK (send_as IN ('user', 'agent')),
  classification          text,
  attachments             jsonb       NOT NULL DEFAULT '[]',
  context_kb_results      jsonb       NOT NULL DEFAULT '[]',
  shareable_docs_results  jsonb       NOT NULL DEFAULT '[]',
  user_context_applied    jsonb       NOT NULL DEFAULT '{}',
  agent_reasoning         text,
  confidence_score        float,
  status                  text        CHECK (status IN ('pending', 'pending_approval', 'approved', 'rejected', 'edited', 'sent', 'failed', 'auto_sending', 'auto_sent', 'send_failed')) DEFAULT 'pending',
  send_mode               text        NOT NULL DEFAULT 'approval',
  auto_send_reasoning     text,
  conversation_stage      text,
  followup_number         int,
  is_followup             boolean     NOT NULL DEFAULT false,
  slack_workspace_id      uuid        REFERENCES public.slack_workspaces(id),
  slack_channel_id        text,
  slack_thread_ts         text,
  slack_message_ts        text,
  edit_history            jsonb       NOT NULL DEFAULT '[]',
  edit_count              int         NOT NULL DEFAULT 0,
  approved_at             timestamptz,
  sent_at                 timestamptz,
  gmail_message_id        text,
  gmail_thread_id         text,
  send_error              text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.email_approval_requests (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   text        NOT NULL,
  recipient_email           text,
  recipient_name            text,
  subject                   text,
  body                      text,
  original_request          text,
  source_type               text        NOT NULL DEFAULT 'slack',
  slack_workspace_id        uuid        REFERENCES public.slack_workspaces(id),
  slack_channel_id          text,
  slack_thread_ts           text,
  slack_message_ts          text,
  langgraph_thread_id       text,
  langgraph_workflow_run_id uuid,
  status                    text        CHECK (status IN ('pending', 'approved', 'rejected', 'edited', 'expired', 'sent', 'failed')) DEFAULT 'pending',
  approved_at               timestamptz,
  rejected_at               timestamptz,
  rejection_reason          text,
  edit_history              jsonb       NOT NULL DEFAULT '[]',
  edit_count                int         NOT NULL DEFAULT 0,
  sent_at                   timestamptz,
  send_error                text,
  email_message_id          text,
  metadata                  jsonb       NOT NULL DEFAULT '{}',
  expires_at                timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.email_approval_workflow_runs (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             text        NOT NULL,
  approval_request_id uuid        REFERENCES public.email_approval_requests(id) ON DELETE CASCADE,
  thread_id           text,
  run_id              text,
  status              text        CHECK (status IN ('running', 'awaiting_approval', 'processing_reply', 'completed', 'failed', 'cancelled')),
  current_step        text,
  source_message      text,
  source_channel      text,
  source_thread_ts    text,
  error_message       text,
  started_at          timestamptz,
  completed_at        timestamptz,
  total_duration_ms   int,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.email_scheduled_followups (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 text        NOT NULL,
  organization_id         uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  thread_conversation_id  uuid        REFERENCES public.email_thread_conversations(id) ON DELETE CASCADE,
  scheduled_for           timestamptz NOT NULL,
  followup_number         int         NOT NULL DEFAULT 1,
  subject                 text,
  body                    text,
  draft_id                uuid,
  status                  text        CHECK (status IN ('scheduled', 'generating', 'sending', 'sent', 'cancelled', 'failed', 'superseded')) DEFAULT 'scheduled',
  cancelled_reason        text,
  sent_at                 timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.email_classifications (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      text,
  user_id         text,
  organization_id uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  classification  text,
  confidence      numeric,
  should_process  boolean,
  classification_method text,
  reasoning       text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.email_feedback_events (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text        NOT NULL,
  draft_id      uuid        REFERENCES public.email_auto_response_drafts(id) ON DELETE CASCADE,
  original_body text,
  sent_body     text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- Knowledge base
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.documents (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               text        NOT NULL,
  organization_id       uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  filename              text        NOT NULL,
  file_path             text,
  file_type             text,
  category              text,
  subcategory           varchar,
  description           text,
  priority              varchar     NOT NULL DEFAULT 'medium',
  tags                  text[]      NOT NULL DEFAULT '{}',
  doc_type              text        CHECK (doc_type IN ('agent-playbook', 'soc2', 'pen-test', 'msa', 'terms', 'privacy', 'datasheet', 'case-study', 'comparison', 'presentation', 'one-pager', 'other')),
  is_shareable          boolean     NOT NULL DEFAULT false,
  in_knowledge_base     boolean     NOT NULL DEFAULT true,
  needs_configuration   boolean     NOT NULL DEFAULT false,
  processed             boolean     NOT NULL DEFAULT false,
  content_text          text,
  onboarding_proposals  jsonb,
  onboarding_gaps       jsonb,
  ingestion_status      text        CHECK (ingestion_status IS NULL OR ingestion_status IN ('queued', 'processing', 'ready', 'failed')),
  ingestion_consumed    boolean     NOT NULL DEFAULT false,
  source_label          text,
  upload_date           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_documents_onboarding_pending
  ON public.documents (organization_id, ingestion_status, ingestion_consumed)
  WHERE category = 'onboarding';

CREATE TABLE IF NOT EXISTS public.document_chunks (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     uuid        NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  organization_id uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  content         text        NOT NULL,
  chunk_index     int         NOT NULL,
  metadata        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.document_embeddings (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id        uuid        NOT NULL REFERENCES public.document_chunks(id) ON DELETE CASCADE,
  organization_id uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  embedding       vector,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.document_use_cases (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     uuid        REFERENCES public.documents(id) ON DELETE CASCADE,
  organization_id uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  use_case_name   varchar     NOT NULL,
  use_case_pattern text,
  always_include  boolean     NOT NULL DEFAULT true,
  boost_factor    numeric     NOT NULL DEFAULT 2.0,
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.context_knowledge (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source_document_id uuid       REFERENCES public.documents(id) ON DELETE SET NULL,
  title             text        NOT NULL,
  content           text        NOT NULL,
  category          text        CHECK (category IN ('sales-playbook', 'competitive-intel', 'company-culture', 'process', 'pricing-strategy', 'objection-handling', 'product-positioning', 'other')),
  subcategory       text,
  embedding         vector,
  tags              text[]      NOT NULL DEFAULT '{}',
  priority          text        CHECK (priority IN ('high', 'medium', 'low')),
  metadata          jsonb       NOT NULL DEFAULT '{}',
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.shareable_documents (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  title               text        NOT NULL,
  description         text,
  file_path           text,
  file_name           text,
  file_type           text,
  file_size_bytes     int,
  content             text,
  doc_type            text        CHECK (doc_type IN ('agent-playbook', 'soc2', 'pen-test', 'msa', 'terms', 'privacy', 'datasheet', 'case-study', 'comparison', 'presentation', 'one-pager', 'other')),
  embedding           vector,
  is_public           boolean     NOT NULL DEFAULT false,
  requires_nda        boolean     NOT NULL DEFAULT false,
  in_knowledge_base   boolean     NOT NULL DEFAULT true,
  needs_configuration boolean     NOT NULL DEFAULT false,
  version             text        NOT NULL DEFAULT '1.0',
  valid_from          date,
  valid_until         date,
  tags                text[]      NOT NULL DEFAULT '{}',
  metadata            jsonb       NOT NULL DEFAULT '{}',
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- User memory and preferences
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.user_memories (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           text        NOT NULL,
  organization_id   uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  skill_namespace   text        NOT NULL,
  content           text        NOT NULL,
  embedding         vector(1536) NOT NULL,
  metadata          jsonb       NOT NULL DEFAULT '{}',
  category          text,
  content_tsv       tsvector,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_memories_embedding
  ON public.user_memories USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_user_memories_user_ns
  ON public.user_memories (user_id, skill_namespace);

CREATE INDEX IF NOT EXISTS idx_user_memories_tsv
  ON public.user_memories USING gin (content_tsv);

CREATE TABLE IF NOT EXISTS public.user_context (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 text        UNIQUE NOT NULL,
  communication_style     text,
  role_description        text,
  custom_context          text,
  signature_preferences   jsonb       NOT NULL DEFAULT '{}',
  tone_examples           text[],
  writing_style_profile   jsonb,
  learned_preferences     jsonb       NOT NULL DEFAULT '{}',
  metadata                jsonb       NOT NULL DEFAULT '{}',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_email_style_examples (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text        NOT NULL,
  subject     text,
  body        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_preferences (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     text        NOT NULL,
  preference_key              varchar     NOT NULL,
  preference_value            jsonb,
  learned_from_conversations  boolean     NOT NULL DEFAULT false,
  confidence_score            float       CHECK (confidence_score BETWEEN 0 AND 1),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_preferences_unique
  ON public.user_preferences (user_id, preference_key);

CREATE TABLE IF NOT EXISTS public.user_learnings (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           text        NOT NULL,
  organization_id   uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  domain            text        NOT NULL,
  learning          text        NOT NULL,
  source_event_ids  uuid[]      NOT NULL DEFAULT '{}',
  status            text        NOT NULL DEFAULT 'active',
  removed_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.feedback_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text        NOT NULL,
  organization_id uuid        REFERENCES public.organizations(id) ON DELETE CASCADE,
  domain          text        NOT NULL,
  signal_type     text,
  agent_output    jsonb,
  user_action     jsonb,
  delta           jsonb,
  context         jsonb,
  source_ref      jsonb,
  processed       boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- Org context and readiness
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.org_context (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid        UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  product_name            text,
  product_description     text,
  product_features        jsonb       NOT NULL DEFAULT '[]',
  product_pricing_summary text,
  product_use_cases       jsonb       NOT NULL DEFAULT '[]',
  icp_industries          jsonb       NOT NULL DEFAULT '[]',
  icp_company_sizes       jsonb       NOT NULL DEFAULT '[]',
  icp_titles              jsonb       NOT NULL DEFAULT '[]',
  icp_pain_points         jsonb       NOT NULL DEFAULT '[]',
  icp_description         text,
  competitors             jsonb       NOT NULL DEFAULT '[]',
  competitive_advantages  jsonb       NOT NULL DEFAULT '[]',
  research_sources        jsonb       NOT NULL DEFAULT '[]',
  last_researched_at      timestamptz,
  research_status         text        CHECK (research_status IN ('pending', 'researching', 'complete', 'failed')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.org_readiness_snapshots (
  organization_id   uuid        PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  score             int         CHECK (score BETWEEN 0 AND 100),
  rules_evaluated   int         NOT NULL DEFAULT 0,
  rules_passed      int         NOT NULL DEFAULT 0,
  blocking_gaps     jsonb       NOT NULL DEFAULT '[]',
  advisory_gaps     jsonb       NOT NULL DEFAULT '[]',
  evaluated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.onboarding_progress (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  current_step    int         NOT NULL DEFAULT 1 CHECK (current_step BETWEEN 1 AND 5),
  status          text        NOT NULL CHECK (status IN ('not_started', 'in_progress', 'completed')) DEFAULT 'not_started',
  steps_completed jsonb       NOT NULL DEFAULT '{"step1":false,"step2":false,"step3":false,"step4":false,"step5":false}',
  metadata        jsonb       NOT NULL DEFAULT '{}',
  last_updated    timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  completed_by    text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- Onboarding sessions
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.onboarding_sessions (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id                 text        NOT NULL,
  status                  text        NOT NULL DEFAULT 'active',
  completed_integrations  text[]      NOT NULL DEFAULT '{}',
  enabled_features        jsonb       NOT NULL DEFAULT '{}',
  oauth_attempts          jsonb       NOT NULL DEFAULT '{}',
  active_stream_id        text,
  active_stream_at        timestamptz,
  last_client_msg_id      text,
  last_client_msg_at      timestamptz,
  started_at              timestamptz NOT NULL DEFAULT now(),
  last_active_at          timestamptz NOT NULL DEFAULT now(),
  completed_at            timestamptz
);

CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_org
  ON public.onboarding_sessions (organization_id);

CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_user
  ON public.onboarding_sessions (user_id);

CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_status_active_at
  ON public.onboarding_sessions (status, last_active_at);

CREATE TABLE IF NOT EXISTS public.onboarding_messages (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid        NOT NULL REFERENCES public.onboarding_sessions(id) ON DELETE CASCADE,
  role        text        NOT NULL,
  content     text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_messages_session
  ON public.onboarding_messages (session_id, created_at);

-- =============================================================================
-- Usage and analytics
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.usage_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid,
  user_id         text,
  deal_id         uuid,
  event_type      text,
  event_name      text,
  status          text        NOT NULL DEFAULT 'success',
  provider        text,
  model           text,
  tokens_in       bigint      NOT NULL DEFAULT 0,
  tokens_out      bigint      NOT NULL DEFAULT 0,
  cost_usd        numeric(12,6) NOT NULL DEFAULT 0,
  workflow_run_id uuid,
  runtime_ms      bigint,
  error_code      text,
  error_message   text,
  metadata        jsonb       NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_events_org_created
  ON public.usage_events (org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.usage_org_daily (
  org_id          uuid        NOT NULL,
  date            date        NOT NULL,
  total_tasks     bigint      NOT NULL DEFAULT 0,
  total_workflows bigint      NOT NULL DEFAULT 0,
  total_prompts   bigint      NOT NULL DEFAULT 0,
  total_tokens_in bigint      NOT NULL DEFAULT 0,
  total_tokens_out bigint     NOT NULL DEFAULT 0,
  total_cost_usd  numeric(12,6) NOT NULL DEFAULT 0,
  active_users    int         NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, date)
);

CREATE TABLE IF NOT EXISTS public.usage_user_daily (
  org_id          uuid        NOT NULL,
  user_id         text        NOT NULL,
  date            date        NOT NULL,
  total_tasks     bigint      NOT NULL DEFAULT 0,
  total_workflows bigint      NOT NULL DEFAULT 0,
  total_prompts   bigint      NOT NULL DEFAULT 0,
  total_tokens_in bigint      NOT NULL DEFAULT 0,
  total_tokens_out bigint     NOT NULL DEFAULT 0,
  total_cost_usd  numeric(12,6) NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, user_id, date)
);

CREATE TABLE IF NOT EXISTS public.workflow_runs (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid,
  user_id           text,
  deal_id           uuid,
  workflow_kind     text,
  status            text        NOT NULL DEFAULT 'started',
  started_at        timestamptz,
  ended_at          timestamptz,
  runtime_ms        bigint,
  steps_count       int         NOT NULL DEFAULT 0,
  escalations_count int         NOT NULL DEFAULT 0,
  llm_calls_count   int         NOT NULL DEFAULT 0,
  tokens_in         bigint      NOT NULL DEFAULT 0,
  tokens_out        bigint      NOT NULL DEFAULT 0,
  cost_usd          numeric(12,6) NOT NULL DEFAULT 0,
  error_code        text,
  error_message     text,
  metadata          jsonb       NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.briefing_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text        NOT NULL,
  organization_id text,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  content_summary jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.digest_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text        NOT NULL,
  organization_id text,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  content_summary jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- Autonomous handoff tables
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.handoff_dossiers (
  id                    uuid        PRIMARY KEY REFERENCES public.deals(id) ON DELETE CASCADE,
  deal_id               uuid        NOT NULL,
  organization_id       uuid,
  fit_score             int,
  fit_band              text        CHECK (fit_band IS NULL OR fit_band IN ('high', 'medium', 'low', 'neutral')),
  signals               jsonb       NOT NULL DEFAULT '[]',
  conversation_summary  text,
  objections            jsonb       NOT NULL DEFAULT '[]',
  decision_criteria     jsonb       NOT NULL DEFAULT '[]',
  talking_points        jsonb       NOT NULL DEFAULT '[]',
  crm_links             jsonb       NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.handoff_dispatches (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id                   uuid        REFERENCES public.deals(id) ON DELETE CASCADE,
  organization_id           uuid,
  source                    text        CHECK (source IN ('in_thread_confirmation', 'regex_stage_flip', 'calendar_watch_v2', 'manual')),
  idempotency_key           text        UNIQUE,
  dispatched_at             timestamptz NOT NULL DEFAULT now(),
  dossier_id                uuid        REFERENCES public.handoff_dossiers(id) ON DELETE SET NULL,
  meeting_event_ref         text,
  meeting_start             timestamptz,
  meeting_end               timestamptz,
  assigned_rep_user_id      text,
  customer_intro_sent_at    timestamptz,
  rep_debrief_email_sent_at timestamptz,
  rep_debrief_slack_sent_at timestamptz,
  pre_meeting_brief_workflow_id  text,
  post_meeting_recap_workflow_id text
);

-- =============================================================================
-- Prospect session tables (Autonomous data layer — used by autonomous-email-agent)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.prospect_sessions (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid        NOT NULL,
  session_token_hash    text        NOT NULL,
  anonymous_visitor_id  text,
  origin                text,
  user_agent            text,
  ip_hash               text,
  captured_name         text,
  captured_email        text,
  captured_company      text,
  captured_role         text,
  captured_use_case     text,
  intent                text,
  enrichment            jsonb,
  conversation_stage    text        NOT NULL DEFAULT 'intro',
  deal_stage            text,
  status                text        CHECK (status IN ('active', 'idle', 'closed', 'email_only')) DEFAULT 'active',
  started_at            timestamptz NOT NULL DEFAULT now(),
  last_active_at        timestamptz NOT NULL DEFAULT now(),
  closed_at             timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prospect_sessions_unique_token_hash
  ON public.prospect_sessions (session_token_hash);

CREATE TABLE IF NOT EXISTS public.prospect_messages (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid        NOT NULL REFERENCES public.prospect_sessions(id) ON DELETE CASCADE,
  role        text        NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content     text,
  tool_calls  jsonb,
  tool_name   text,
  metadata    jsonb       NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.prospect_dossiers (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            uuid        REFERENCES public.prospect_sessions(id) ON DELETE SET NULL,
  organization_id       uuid,
  contact_name          text,
  contact_email         text,
  contact_company       text,
  contact_role          text,
  fit_score             int         CHECK (fit_score BETWEEN 0 AND 100),
  fit_band              text        CHECK (fit_band IN ('low', 'medium', 'high')),
  strengths             text[]      NOT NULL DEFAULT '{}',
  gaps                  text[]      NOT NULL DEFAULT '{}',
  current_state         text,
  crm_provider          text        CHECK (crm_provider IS NULL OR crm_provider IN ('salesforce', 'attio', 'hubspot')),
  crm_deal_id           text,
  crm_deal_url          text,
  attio_workspace_id    text,
  salesforce_org_id     text,
  conversation_stage    text        NOT NULL DEFAULT 'intro',
  deal_stage            text,
  enrichment            jsonb,
  strategic_guidance    text,
  metadata              jsonb       NOT NULL DEFAULT '{}',
  slack_channel_id      text,
  slack_message_ts      text,
  version               int         NOT NULL DEFAULT 1,
  generated_at          timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prospect_dossiers_session
  ON public.prospect_dossiers (session_id);

CREATE INDEX IF NOT EXISTS idx_prospect_dossiers_org_email
  ON public.prospect_dossiers (organization_id, contact_email);

-- =============================================================================
-- Widget API keys (used by org readiness checks in retained code)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.widget_api_keys (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL,
  key_hash        text        NOT NULL,
  key_prefix      text,
  name            text,
  allowed_origins text[]      NOT NULL DEFAULT '{}',
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz
);

-- =============================================================================
-- Org knowledge gaps (onboarding trainer stub)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.org_knowledge_gaps (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  question_key    text,
  question_text   text        NOT NULL,
  context         jsonb       NOT NULL DEFAULT '{}',
  source          text        NOT NULL,
  severity        text        NOT NULL DEFAULT 'normal' CHECK (severity IN ('low', 'normal', 'high')),
  status          text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_org_knowledge_gaps_org_status
  ON public.org_knowledge_gaps (organization_id, status, created_at DESC);

-- =============================================================================
-- Performance indexes
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_conversations_user_id
  ON public.conversations (user_id);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation
  ON public.chat_messages (conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_deals_user_org
  ON public.deals (user_id, organization_id);

CREATE INDEX IF NOT EXISTS idx_contacts_user_id
  ON public.contacts (user_id);

CREATE INDEX IF NOT EXISTS idx_incoming_emails_user_org
  ON public.incoming_emails (user_id, organization_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_auto_response_drafts_user_status
  ON public.email_auto_response_drafts (user_id, status);

CREATE INDEX IF NOT EXISTS idx_calendar_events_user_start
  ON public.calendar_events (user_id, start_time);

CREATE INDEX IF NOT EXISTS idx_slack_user_mappings_agent_user
  ON public.slack_user_mappings (agent_user_id);

CREATE INDEX IF NOT EXISTS idx_document_chunks_document
  ON public.document_chunks (document_id);

CREATE INDEX IF NOT EXISTS idx_document_embeddings_chunk
  ON public.document_embeddings (chunk_id);

CREATE INDEX IF NOT EXISTS idx_usage_events_created
  ON public.usage_events (created_at DESC);

-- =============================================================================
-- Triggers
-- =============================================================================

CREATE TRIGGER set_updated_at_organizations
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_updated_at_profiles
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_updated_at_deals
  BEFORE UPDATE ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_updated_at_contacts
  BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_updated_at_conversations
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_updated_at_user_context
  BEFORE UPDATE ON public.user_context
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_updated_at_documents
  BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_user_memories_tsv_trigger
  BEFORE INSERT OR UPDATE ON public.user_memories
  FOR EACH ROW EXECUTE FUNCTION public.update_user_memories_tsv();

-- =============================================================================
-- RLS: enable on all tables
-- =============================================================================

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_enrichment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.langgraph_workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_prep_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processed_meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slack_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slack_user_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slack_thread_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_slack_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gmail_poll_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gmail_watch_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_email_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.granola_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attio_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salesforce_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incoming_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_thread_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_auto_response_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_approval_workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_scheduled_followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_feedback_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_use_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_knowledge ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shareable_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_email_style_examples ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_learnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_readiness_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_org_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_user_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_knowledge_gaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospect_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospect_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospect_dossiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.handoff_dossiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.handoff_dispatches ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- RLS Policies
-- =============================================================================

-- organizations: members can read
DROP POLICY IF EXISTS "org members can read organization" ON public.organizations;
CREATE POLICY "org members can read organization" ON public.organizations FOR SELECT
  USING (id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id()));

-- organization_users
DROP POLICY IF EXISTS "org members can read organization users" ON public.organization_users;
CREATE POLICY "org members can read organization users" ON public.organization_users FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id()));

DROP POLICY IF EXISTS "org members can manage their own membership" ON public.organization_users;
CREATE POLICY "org members can manage their own membership" ON public.organization_users FOR ALL
  USING (user_id = public.current_user_id());

-- organization_invites
DROP POLICY IF EXISTS "org members can read invites" ON public.organization_invites;
CREATE POLICY "org members can read invites" ON public.organization_invites FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id()));

DROP POLICY IF EXISTS "org admins can manage invites" ON public.organization_invites;
CREATE POLICY "org admins can manage invites" ON public.organization_invites FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM public.organization_users
    WHERE user_id = public.current_user_id() AND role IN ('owner', 'admin')
  ));

-- profiles
DROP POLICY IF EXISTS "users can manage own profile" ON public.profiles;
CREATE POLICY "users can manage own profile" ON public.profiles FOR ALL
  USING (user_id = public.current_user_id());

-- conversations
DROP POLICY IF EXISTS "users can manage own conversations" ON public.conversations;
CREATE POLICY "users can manage own conversations" ON public.conversations FOR ALL
  USING (user_id = public.current_user_id());

-- chat_messages (via parent conversation)
DROP POLICY IF EXISTS "users can manage messages in own conversations" ON public.chat_messages;
CREATE POLICY "users can manage messages in own conversations" ON public.chat_messages FOR ALL
  USING (conversation_id IN (SELECT id FROM public.conversations WHERE user_id = public.current_user_id()));

-- conversation_feedback
DROP POLICY IF EXISTS "users can manage own conversation feedback" ON public.conversation_feedback;
CREATE POLICY "users can manage own conversation feedback" ON public.conversation_feedback FOR ALL
  USING (user_id = public.current_user_id());

-- contacts
DROP POLICY IF EXISTS "users can manage own contacts" ON public.contacts;
CREATE POLICY "users can manage own contacts" ON public.contacts FOR ALL
  USING (user_id = public.current_user_id());

-- contact_enrichment (via contacts)
DROP POLICY IF EXISTS "users can read enrichment for own contacts" ON public.contact_enrichment;
CREATE POLICY "users can read enrichment for own contacts" ON public.contact_enrichment FOR SELECT
  USING (contact_id IN (SELECT id FROM public.contacts WHERE user_id = public.current_user_id()));

-- deals
DROP POLICY IF EXISTS "users can manage own deals" ON public.deals;
CREATE POLICY "users can manage own deals" ON public.deals FOR ALL
  USING (user_id = public.current_user_id());

-- notifications
DROP POLICY IF EXISTS "users can manage own notifications" ON public.notifications;
CREATE POLICY "users can manage own notifications" ON public.notifications FOR ALL
  USING (user_id = public.current_user_id());

-- reminders
DROP POLICY IF EXISTS "users can manage own reminders" ON public.reminders;
CREATE POLICY "users can manage own reminders" ON public.reminders FOR ALL
  USING (user_id = public.current_user_id());

-- calendar_credentials
DROP POLICY IF EXISTS "users can manage own calendar credentials" ON public.calendar_credentials;
CREATE POLICY "users can manage own calendar credentials" ON public.calendar_credentials FOR ALL
  USING (user_id = public.current_user_id());

-- calendar_events
DROP POLICY IF EXISTS "users can manage own calendar events" ON public.calendar_events;
CREATE POLICY "users can manage own calendar events" ON public.calendar_events FOR ALL
  USING (user_id = public.current_user_id());

-- langgraph_workflow_runs
DROP POLICY IF EXISTS "users can manage own workflow runs" ON public.langgraph_workflow_runs;
CREATE POLICY "users can manage own workflow runs" ON public.langgraph_workflow_runs FOR ALL
  USING (user_id = public.current_user_id());

-- meeting_prep_cache
DROP POLICY IF EXISTS "users can manage own meeting prep cache" ON public.meeting_prep_cache;
CREATE POLICY "users can manage own meeting prep cache" ON public.meeting_prep_cache FOR ALL
  USING (user_id = public.current_user_id());

-- slack_workspaces
DROP POLICY IF EXISTS "org members can read slack workspaces" ON public.slack_workspaces;
CREATE POLICY "org members can read slack workspaces" ON public.slack_workspaces FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id()));

-- slack_user_mappings
DROP POLICY IF EXISTS "org members can read slack user mappings" ON public.slack_user_mappings;
CREATE POLICY "org members can read slack user mappings" ON public.slack_user_mappings FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id()));

-- oauth_states: allow insert from authenticated users
DROP POLICY IF EXISTS "users can insert own oauth states" ON public.oauth_states;
CREATE POLICY "users can insert own oauth states" ON public.oauth_states FOR INSERT
  WITH CHECK (user_id = public.current_user_id());

-- gmail
DROP POLICY IF EXISTS "users can manage own gmail poll state" ON public.gmail_poll_state;
CREATE POLICY "users can manage own gmail poll state" ON public.gmail_poll_state FOR ALL
  USING (user_id = public.current_user_id());

DROP POLICY IF EXISTS "users can manage own gmail watch subscriptions" ON public.gmail_watch_subscriptions;
CREATE POLICY "users can manage own gmail watch subscriptions" ON public.gmail_watch_subscriptions FOR ALL
  USING (user_id = public.current_user_id());

-- granola_credentials
DROP POLICY IF EXISTS "users can manage own granola credentials" ON public.granola_credentials;
CREATE POLICY "users can manage own granola credentials" ON public.granola_credentials FOR ALL
  USING (user_id = (auth.jwt() ->> 'sub'));

-- attio_credentials (org admin)
DROP POLICY IF EXISTS "org admins can manage attio credentials" ON public.attio_credentials;
CREATE POLICY "org admins can manage attio credentials" ON public.attio_credentials FOR ALL
  USING (organization_id IN (
    SELECT organization_id FROM public.organization_users
    WHERE user_id = (auth.jwt() ->> 'sub') AND role IN ('admin', 'owner')
  ));

-- salesforce_credentials (org admin)
DROP POLICY IF EXISTS "Org members can view salesforce credentials" ON public.salesforce_credentials;
CREATE POLICY "Org members can view salesforce credentials" ON public.salesforce_credentials FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.organization_users ou
    WHERE ou.organization_id = salesforce_credentials.organization_id
      AND ou.user_id::text = (auth.jwt() ->> 'sub')
  ));

DROP POLICY IF EXISTS "Org admins can insert salesforce credentials" ON public.salesforce_credentials;
CREATE POLICY "Org admins can insert salesforce credentials" ON public.salesforce_credentials FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.organization_users ou
    WHERE ou.organization_id = salesforce_credentials.organization_id
      AND ou.user_id::text = (auth.jwt() ->> 'sub')
      AND ou.role IN ('admin', 'owner')
  ));

DROP POLICY IF EXISTS "Org admins can update salesforce credentials" ON public.salesforce_credentials;
CREATE POLICY "Org admins can update salesforce credentials" ON public.salesforce_credentials FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM public.organization_users ou
    WHERE ou.organization_id = salesforce_credentials.organization_id
      AND ou.user_id::text = (auth.jwt() ->> 'sub')
      AND ou.role IN ('admin', 'owner')
  ));

DROP POLICY IF EXISTS "Org admins can delete salesforce credentials" ON public.salesforce_credentials;
CREATE POLICY "Org admins can delete salesforce credentials" ON public.salesforce_credentials FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.organization_users ou
    WHERE ou.organization_id = salesforce_credentials.organization_id
      AND ou.user_id::text = (auth.jwt() ->> 'sub')
      AND ou.role IN ('admin', 'owner')
  ));

-- email tables
DROP POLICY IF EXISTS "users can manage own incoming emails" ON public.incoming_emails;
CREATE POLICY "users can manage own incoming emails" ON public.incoming_emails FOR ALL
  USING (user_id = public.current_user_id());

DROP POLICY IF EXISTS "users can manage own email drafts" ON public.email_auto_response_drafts;
CREATE POLICY "users can manage own email drafts" ON public.email_auto_response_drafts FOR ALL
  USING (user_id = public.current_user_id());

DROP POLICY IF EXISTS "users can manage own approval requests" ON public.email_approval_requests;
CREATE POLICY "users can manage own approval requests" ON public.email_approval_requests FOR ALL
  USING (user_id = public.current_user_id());

DROP POLICY IF EXISTS "users can read own email feedback" ON public.email_feedback_events;
CREATE POLICY "users can read own email feedback" ON public.email_feedback_events FOR SELECT
  USING (user_id = public.current_user_id());

-- documents (org-scoped)
DROP POLICY IF EXISTS "org members can manage documents" ON public.documents;
CREATE POLICY "org members can manage documents" ON public.documents FOR ALL
  USING (organization_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id()));

DROP POLICY IF EXISTS "org members can manage document chunks" ON public.document_chunks;
CREATE POLICY "org members can manage document chunks" ON public.document_chunks FOR ALL
  USING (organization_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id()));

DROP POLICY IF EXISTS "org members can manage document embeddings" ON public.document_embeddings;
CREATE POLICY "org members can manage document embeddings" ON public.document_embeddings FOR ALL
  USING (organization_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id()));

DROP POLICY IF EXISTS "org members can manage context knowledge" ON public.context_knowledge;
CREATE POLICY "org members can manage context knowledge" ON public.context_knowledge FOR ALL
  USING (organization_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id()));

DROP POLICY IF EXISTS "org members can manage shareable documents" ON public.shareable_documents;
CREATE POLICY "org members can manage shareable documents" ON public.shareable_documents FOR ALL
  USING (organization_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id()));

-- user memory and preferences
DROP POLICY IF EXISTS "users can manage own memories" ON public.user_memories;
CREATE POLICY "users can manage own memories" ON public.user_memories FOR ALL
  USING (user_id = public.current_user_id());

DROP POLICY IF EXISTS "users can manage own user context" ON public.user_context;
CREATE POLICY "users can manage own user context" ON public.user_context FOR ALL
  USING (user_id = public.current_user_id());

DROP POLICY IF EXISTS "users can manage own style examples" ON public.user_email_style_examples;
CREATE POLICY "users can manage own style examples" ON public.user_email_style_examples FOR ALL
  USING (user_id = public.current_user_id());

DROP POLICY IF EXISTS "users can manage own preferences" ON public.user_preferences;
CREATE POLICY "users can manage own preferences" ON public.user_preferences FOR ALL
  USING (user_id = public.current_user_id());

DROP POLICY IF EXISTS "users can manage own learnings" ON public.user_learnings;
CREATE POLICY "users can manage own learnings" ON public.user_learnings FOR ALL
  USING (user_id = public.current_user_id());

DROP POLICY IF EXISTS "users can manage own feedback events" ON public.feedback_events;
CREATE POLICY "users can manage own feedback events" ON public.feedback_events FOR ALL
  USING (user_id = public.current_user_id());

-- onboarding
DROP POLICY IF EXISTS "org members can read onboarding progress" ON public.onboarding_progress;
CREATE POLICY "org members can read onboarding progress" ON public.onboarding_progress FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id()));

DROP POLICY IF EXISTS "org admins can update onboarding progress" ON public.onboarding_progress;
CREATE POLICY "org admins can update onboarding progress" ON public.onboarding_progress FOR UPDATE
  USING (organization_id IN (
    SELECT organization_id FROM public.organization_users
    WHERE user_id = public.current_user_id() AND role IN ('owner', 'admin')
  ));

DROP POLICY IF EXISTS "org members can read their onboarding sessions" ON public.onboarding_sessions;
CREATE POLICY "org members can read their onboarding sessions" ON public.onboarding_sessions FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id()));

DROP POLICY IF EXISTS "session owner can manage their onboarding session" ON public.onboarding_sessions;
CREATE POLICY "session owner can manage their onboarding session" ON public.onboarding_sessions FOR ALL
  USING (user_id = public.current_user_id());

DROP POLICY IF EXISTS "org members can read onboarding messages" ON public.onboarding_messages;
CREATE POLICY "org members can read onboarding messages" ON public.onboarding_messages FOR SELECT
  USING (session_id IN (
    SELECT id FROM public.onboarding_sessions
    WHERE organization_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id())
  ));

DROP POLICY IF EXISTS "session owner can write onboarding messages" ON public.onboarding_messages;
CREATE POLICY "session owner can write onboarding messages" ON public.onboarding_messages FOR ALL
  USING (session_id IN (
    SELECT id FROM public.onboarding_sessions WHERE user_id = public.current_user_id()
  ));

-- usage (read-only for org members; writes by service role)
DROP POLICY IF EXISTS "org members can read usage events" ON public.usage_events;
CREATE POLICY "org members can read usage events" ON public.usage_events FOR SELECT
  USING (org_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id()));

DROP POLICY IF EXISTS "org members can read daily org usage" ON public.usage_org_daily;
CREATE POLICY "org members can read daily org usage" ON public.usage_org_daily FOR SELECT
  USING (org_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id()));

DROP POLICY IF EXISTS "org members can read daily user usage" ON public.usage_user_daily;
CREATE POLICY "org members can read daily user usage" ON public.usage_user_daily FOR SELECT
  USING (org_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id()));

-- org_readiness_snapshots
DROP POLICY IF EXISTS "org members can read readiness snapshots" ON public.org_readiness_snapshots;
CREATE POLICY "org members can read readiness snapshots" ON public.org_readiness_snapshots FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id()));

-- org_knowledge_gaps
DROP POLICY IF EXISTS "org members can read knowledge gaps" ON public.org_knowledge_gaps;
CREATE POLICY "org members can read knowledge gaps" ON public.org_knowledge_gaps FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id()));

-- handoff tables (org members read; service role writes)
DROP POLICY IF EXISTS "org members can read handoff dossiers" ON public.handoff_dossiers;
CREATE POLICY "org members can read handoff dossiers" ON public.handoff_dossiers FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id()));

DROP POLICY IF EXISTS "org members can read handoff dispatches" ON public.handoff_dispatches;
CREATE POLICY "org members can read handoff dispatches" ON public.handoff_dispatches FOR SELECT
  USING (organization_id IN (SELECT organization_id FROM public.organization_users WHERE user_id = public.current_user_id()));

-- =============================================================================
-- RPCs
-- =============================================================================

-- Feature flag setters

CREATE OR REPLACE FUNCTION public.set_feature_flag(p_user_id text, p_flag_key text, p_flag_value text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.profiles
  SET feature_flags = jsonb_set(
    COALESCE(feature_flags, '{}')::jsonb,
    ARRAY[p_flag_key],
    to_jsonb(p_flag_value),
    true
  )
  WHERE user_id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_org_feature_flag(p_org_id uuid, p_flag_key text, p_flag_value jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  caller_role text;
BEGIN
  SELECT role INTO caller_role
  FROM public.organization_users
  WHERE organization_id = p_org_id AND user_id = public.current_user_id();

  IF caller_role IS NULL OR caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  UPDATE public.organizations
  SET feature_flags = jsonb_set(COALESCE(feature_flags, '{}'), ARRAY[p_flag_key], p_flag_value, true)
  WHERE id = p_org_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_org_setting(p_org_id uuid, p_setting_key text, p_setting_value jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.organizations
  SET settings = jsonb_set(COALESCE(settings, '{}'), ARRAY[p_setting_key], p_setting_value, true)
  WHERE id = p_org_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.merge_feature_flags(org_id uuid, flag_key text, child_key text, flag_value boolean, extra_fields jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE sql AS $$
  UPDATE public.organizations
  SET feature_flags = jsonb_set(
    jsonb_set(COALESCE(feature_flags, '{}'), ARRAY[flag_key], COALESCE(feature_flags -> flag_key, '{}')),
    ARRAY[flag_key],
    COALESCE(feature_flags -> flag_key, '{}') || jsonb_build_object(child_key, flag_value) || extra_fields
  )
  WHERE id = org_id
  RETURNING feature_flags;
$$;

CREATE OR REPLACE FUNCTION public.merge_org_settings(org_id uuid, new_settings jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  UPDATE public.organizations
  SET settings = COALESCE(settings, '{}') || new_settings
  WHERE id = org_id
  RETURNING settings;
$$;

-- Contact upserts

CREATE OR REPLACE FUNCTION public.upsert_contact_from_email(
  p_user_id text, p_email text, p_full_name text DEFAULT NULL,
  p_company_name text DEFAULT NULL, p_relationship_type text DEFAULT 'prospect',
  p_source text DEFAULT 'conversation'
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.contacts (user_id, email, full_name, company_name, relationship_type, source)
  VALUES (p_user_id, p_email, p_full_name, p_company_name, p_relationship_type, p_source)
  ON CONFLICT (user_id, email) DO UPDATE
    SET full_name    = COALESCE(EXCLUDED.full_name, contacts.full_name),
        company_name = COALESCE(EXCLUDED.company_name, contacts.company_name),
        last_contact_date = now(),
        updated_at   = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_contact_from_company(
  p_user_id text, p_company_name text, p_company_domain text DEFAULT NULL,
  p_relationship_type text DEFAULT 'prospect', p_source text DEFAULT 'conversation'
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.contacts (user_id, company_name, company_domain, relationship_type, source)
  VALUES (p_user_id, p_company_name, p_company_domain, p_relationship_type, p_source)
  ON CONFLICT DO NOTHING;
END;
$$;

-- Vector search RPCs

CREATE OR REPLACE FUNCTION public.search_context_knowledge(
  query_embedding vector, organization_id_filter uuid,
  match_threshold float DEFAULT 0.4, match_count int DEFAULT 5, category_filter text DEFAULT NULL
) RETURNS TABLE (id uuid, title text, content text, category text, subcategory text, tags text[], priority text, similarity float)
LANGUAGE sql STABLE AS $$
  SELECT ck.id, ck.title, ck.content, ck.category, ck.subcategory, ck.tags, ck.priority,
         1 - (ck.embedding <=> query_embedding) AS similarity
  FROM public.context_knowledge ck
  WHERE ck.organization_id = organization_id_filter
    AND (category_filter IS NULL OR ck.category = category_filter)
    AND 1 - (ck.embedding <=> query_embedding) > match_threshold
  ORDER BY ck.embedding <=> query_embedding
  LIMIT match_count;
$$;

CREATE OR REPLACE FUNCTION public.search_shareable_documents(
  query_embedding vector, organization_id_filter uuid,
  match_threshold float DEFAULT 0.4, match_count int DEFAULT 5, doc_type_filter text DEFAULT NULL
) RETURNS TABLE (id uuid, title text, description text, doc_type text, file_path text, file_name text, file_type text, is_public boolean, requires_nda boolean, tags text[], similarity float)
LANGUAGE sql STABLE AS $$
  SELECT sd.id, sd.title, sd.description, sd.doc_type, sd.file_path, sd.file_name, sd.file_type,
         sd.is_public, sd.requires_nda, sd.tags,
         1 - (sd.embedding <=> query_embedding) AS similarity
  FROM public.shareable_documents sd
  WHERE sd.organization_id = organization_id_filter
    AND (doc_type_filter IS NULL OR sd.doc_type = doc_type_filter)
    AND 1 - (sd.embedding <=> query_embedding) > match_threshold
  ORDER BY sd.embedding <=> query_embedding
  LIMIT match_count;
$$;

CREATE OR REPLACE FUNCTION public.search_documents(
  query_embedding vector, organization_id_filter uuid,
  match_threshold float DEFAULT 0.4, match_count int DEFAULT 5,
  category_filter text DEFAULT NULL, tag_filter text[] DEFAULT NULL
) RETURNS TABLE (content text, filename text, category text, similarity float, tags text[])
LANGUAGE sql STABLE AS $$
  SELECT dc.content, d.filename, d.category,
         1 - (de.embedding <=> query_embedding) AS similarity,
         d.tags
  FROM public.document_embeddings de
  JOIN public.document_chunks dc ON dc.id = de.chunk_id
  JOIN public.documents d ON d.id = dc.document_id
  WHERE d.organization_id = organization_id_filter
    AND d.in_knowledge_base = true
    AND (category_filter IS NULL OR d.category = category_filter)
    AND (tag_filter IS NULL OR d.tags && tag_filter)
    AND 1 - (de.embedding <=> query_embedding) > match_threshold
  ORDER BY de.embedding <=> query_embedding
  LIMIT match_count;
$$;

CREATE OR REPLACE FUNCTION public.search_user_memories(
  query_embedding vector, p_user_id text, p_organization_id uuid DEFAULT NULL,
  p_skill_namespace text DEFAULT NULL, match_threshold float DEFAULT 0.3, match_count int DEFAULT 5
) RETURNS TABLE (id uuid, content text, similarity float, created_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT um.id, um.content, 1 - (um.embedding <=> query_embedding) AS similarity, um.created_at
  FROM public.user_memories um
  WHERE um.user_id = p_user_id
    AND (p_organization_id IS NULL OR um.organization_id = p_organization_id)
    AND (p_skill_namespace IS NULL OR um.skill_namespace = p_skill_namespace)
    AND 1 - (um.embedding <=> query_embedding) > match_threshold
  ORDER BY um.embedding <=> query_embedding
  LIMIT match_count;
$$;

CREATE OR REPLACE FUNCTION public.hybrid_search_user_memories(
  query_embedding vector, query_text text, p_user_id text,
  p_organization_id uuid DEFAULT NULL, p_skill_namespace text DEFAULT NULL,
  p_category text DEFAULT NULL, match_threshold float DEFAULT 0.15, match_count int DEFAULT 5, alpha float DEFAULT 0.7
) RETURNS TABLE (id uuid, content text, similarity float, created_at timestamptz, metadata jsonb, category text)
LANGUAGE sql STABLE AS $$
  SELECT um.id, um.content,
    alpha * (1 - (um.embedding <=> query_embedding)) +
    (1 - alpha) * ts_rank(um.content_tsv, plainto_tsquery('english', query_text)) AS similarity,
    um.created_at, um.metadata, um.category
  FROM public.user_memories um
  WHERE um.user_id = p_user_id
    AND (p_organization_id IS NULL OR um.organization_id = p_organization_id)
    AND (p_skill_namespace IS NULL OR um.skill_namespace = p_skill_namespace)
    AND (p_category IS NULL OR um.category = p_category)
    AND (
      1 - (um.embedding <=> query_embedding) > match_threshold
      OR um.content_tsv @@ plainto_tsquery('english', query_text)
    )
  ORDER BY similarity DESC
  LIMIT match_count;
$$;

CREATE OR REPLACE FUNCTION public.save_memory_if_unique(
  p_user_id text, p_organization_id uuid, p_skill_namespace text, p_content text,
  p_embedding vector, p_dedup_threshold float DEFAULT 0.92,
  p_metadata jsonb DEFAULT '{}', p_category text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  similar_count int;
BEGIN
  SELECT COUNT(*) INTO similar_count
  FROM public.user_memories
  WHERE user_id = p_user_id
    AND skill_namespace = p_skill_namespace
    AND 1 - (embedding <=> p_embedding) > p_dedup_threshold;

  IF similar_count > 0 THEN
    RETURN false;
  END IF;

  INSERT INTO public.user_memories (user_id, organization_id, skill_namespace, content, embedding, metadata, category)
  VALUES (p_user_id, p_organization_id, p_skill_namespace, p_content, p_embedding, p_metadata, p_category);

  RETURN true;
END;
$$;

-- Usage rollup

CREATE OR REPLACE FUNCTION public.backfill_usage_rollups(p_start date, p_end date)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.usage_org_daily (org_id, date, total_tasks, total_workflows, total_prompts, total_tokens_in, total_tokens_out, total_cost_usd, active_users)
  SELECT
    org_id, created_at::date,
    COUNT(*) FILTER (WHERE event_type = 'task') AS total_tasks,
    COUNT(*) FILTER (WHERE event_type = 'workflow') AS total_workflows,
    COUNT(*) FILTER (WHERE event_type = 'prompt') AS total_prompts,
    COALESCE(SUM(tokens_in), 0), COALESCE(SUM(tokens_out), 0), COALESCE(SUM(cost_usd), 0),
    COUNT(DISTINCT user_id)
  FROM public.usage_events
  WHERE created_at::date BETWEEN p_start AND p_end AND org_id IS NOT NULL
  GROUP BY org_id, created_at::date
  ON CONFLICT (org_id, date) DO UPDATE
    SET total_tasks    = EXCLUDED.total_tasks,
        total_workflows = EXCLUDED.total_workflows,
        total_prompts  = EXCLUDED.total_prompts,
        total_tokens_in = EXCLUDED.total_tokens_in,
        total_tokens_out = EXCLUDED.total_tokens_out,
        total_cost_usd = EXCLUDED.total_cost_usd,
        active_users   = EXCLUDED.active_users;
END;
$$;

-- Delete user data (GDPR)

CREATE OR REPLACE FUNCTION public.delete_user_data(p_user_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM public.conversations WHERE user_id = p_user_id;
  DELETE FROM public.contacts WHERE user_id = p_user_id;
  DELETE FROM public.deals WHERE user_id = p_user_id;
  DELETE FROM public.user_memories WHERE user_id = p_user_id;
  DELETE FROM public.user_context WHERE user_id = p_user_id;
  DELETE FROM public.user_preferences WHERE user_id = p_user_id;
  DELETE FROM public.user_learnings WHERE user_id = p_user_id;
  DELETE FROM public.calendar_credentials WHERE user_id = p_user_id;
  DELETE FROM public.calendar_events WHERE user_id = p_user_id;
  DELETE FROM public.gmail_poll_state WHERE user_id = p_user_id;
  DELETE FROM public.gmail_watch_subscriptions WHERE user_id = p_user_id;
  DELETE FROM public.granola_credentials WHERE user_id = p_user_id;
  DELETE FROM public.incoming_emails WHERE user_id = p_user_id;
  DELETE FROM public.email_auto_response_drafts WHERE user_id = p_user_id;
  DELETE FROM public.email_approval_requests WHERE user_id = p_user_id;
  DELETE FROM public.profiles WHERE user_id = p_user_id;
END;
$$;

-- Onboarding transport RPCs

CREATE OR REPLACE FUNCTION public.claim_onboarding_stream(p_session_id uuid, p_stream_id text, p_grace_secs integer DEFAULT 60)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_owner_id  text;
  v_active_at timestamptz;
  v_updated   uuid;
BEGIN
  SELECT user_id, active_stream_at INTO v_owner_id, v_active_at
  FROM public.onboarding_sessions WHERE id = p_session_id;

  IF v_owner_id IS NULL THEN RAISE EXCEPTION 'Session not found' USING ERRCODE = '42P01'; END IF;
  IF v_owner_id <> public.current_user_id() THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;

  UPDATE public.onboarding_sessions
  SET active_stream_id = p_stream_id, active_stream_at = now()
  WHERE id = p_session_id
    AND (active_stream_id IS NULL OR active_stream_at < (now() - (p_grace_secs || ' seconds')::interval))
  RETURNING id INTO v_updated;

  IF v_updated IS NULL THEN
    RETURN jsonb_build_object('claimed', false, 'current_age_seconds',
      GREATEST(0, EXTRACT(EPOCH FROM (now() - v_active_at))::int));
  END IF;
  RETURN jsonb_build_object('claimed', true, 'stream_id', p_stream_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_onboarding_stream(p_session_id uuid, p_stream_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_owner_id text; BEGIN
  SELECT user_id INTO v_owner_id FROM public.onboarding_sessions WHERE id = p_session_id;
  IF v_owner_id IS NULL THEN RETURN; END IF;
  IF v_owner_id <> public.current_user_id() THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  UPDATE public.onboarding_sessions
  SET active_stream_id = NULL, active_stream_at = NULL
  WHERE id = p_session_id AND active_stream_id = p_stream_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.take_over_onboarding_stream(p_session_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_owner_id text; BEGIN
  SELECT user_id INTO v_owner_id FROM public.onboarding_sessions WHERE id = p_session_id;
  IF v_owner_id IS NULL THEN RAISE EXCEPTION 'Session not found' USING ERRCODE = '42P01'; END IF;
  IF v_owner_id <> public.current_user_id() THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  UPDATE public.onboarding_sessions SET active_stream_id = NULL, active_stream_at = NULL WHERE id = p_session_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.stamp_onboarding_client_msg(p_session_id uuid, p_client_msg_id text, p_dedupe_secs integer DEFAULT 30)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_owner_id text; v_updated uuid; BEGIN
  SELECT user_id INTO v_owner_id FROM public.onboarding_sessions WHERE id = p_session_id;
  IF v_owner_id IS NULL THEN RAISE EXCEPTION 'Session not found' USING ERRCODE = '42P01'; END IF;
  IF v_owner_id <> public.current_user_id() THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  UPDATE public.onboarding_sessions
  SET last_client_msg_id = p_client_msg_id, last_client_msg_at = now()
  WHERE id = p_session_id
    AND (last_client_msg_id IS DISTINCT FROM p_client_msg_id OR last_client_msg_at IS NULL
         OR last_client_msg_at < (now() - (p_dedupe_secs || ' seconds')::interval))
  RETURNING id INTO v_updated;
  RETURN v_updated IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.increment_onboarding_oauth_attempt(p_session_id uuid, p_integration text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE new_count integer; BEGIN
  UPDATE public.onboarding_sessions
  SET oauth_attempts = jsonb_set(COALESCE(oauth_attempts, '{}'),
    ARRAY[p_integration], to_jsonb(COALESCE((oauth_attempts ->> p_integration)::int, 0) + 1), true)
  WHERE id = p_session_id
  RETURNING (oauth_attempts ->> p_integration)::int INTO new_count;
  RETURN COALESCE(new_count, 0);
END;
$$;

-- Onboarding playbook + knowledge RPCs

CREATE OR REPLACE FUNCTION public.upsert_org_playbook_topic(p_org_id uuid, p_name text, p_content text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE caller_role text; BEGIN
  SELECT role INTO caller_role FROM public.organization_users
  WHERE organization_id = p_org_id AND user_id = public.current_user_id();
  IF caller_role IS NULL OR caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  UPDATE public.organizations
  SET settings = jsonb_set(COALESCE(settings, '{}'), ARRAY['prospect_context_playbooks'],
    COALESCE((SELECT jsonb_agg(elem) FROM jsonb_array_elements(
      COALESCE(settings->'prospect_context_playbooks', '[]')) elem WHERE elem->>'name' IS DISTINCT FROM p_name),
      '[]') || jsonb_build_object('name', p_name, 'content', p_content), true)
  WHERE id = p_org_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_org_knowledge_answer(
  p_org_id uuid, p_topic_name text, p_question_key text, p_question_text text,
  p_answer_text text, p_confidence text, p_na_reason text DEFAULT NULL,
  p_proposed_value text DEFAULT NULL, p_updated_via text DEFAULT 'chat'
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  caller_role text; existing jsonb; new_entry jsonb;
BEGIN
  SELECT role INTO caller_role FROM public.organization_users
  WHERE organization_id = p_org_id AND user_id = public.current_user_id();
  IF caller_role IS NULL OR caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  IF p_confidence NOT IN ('draft', 'confirmed', 'stale', 'not_applicable', 'unknown', 'pending_portal') THEN
    RAISE EXCEPTION 'Invalid confidence: %', p_confidence USING ERRCODE = '22023'; END IF;
  IF p_updated_via NOT IN ('chat', 'portal') THEN
    RAISE EXCEPTION 'Invalid updated_via: %', p_updated_via USING ERRCODE = '22023'; END IF;

  SELECT elem INTO existing FROM public.organizations o,
    jsonb_array_elements(COALESCE(o.settings -> 'prospect_context_knowledge' -> p_topic_name, '[]')) elem
  WHERE o.id = p_org_id AND elem ->> 'question_key' = p_question_key LIMIT 1;

  IF p_confidence = 'pending_portal' THEN
    new_entry := jsonb_build_object('question_key', p_question_key, 'question_text', p_question_text,
      'answer_text', COALESCE(existing ->> 'answer_text', ''),
      'confidence', COALESCE(existing ->> 'confidence', 'pending_portal'),
      'proposed_value', p_proposed_value, 'proposed_at', to_jsonb(now()),
      'updated_at', to_jsonb(now()), 'updated_via', p_updated_via);
  ELSE
    new_entry := jsonb_build_object('question_key', p_question_key, 'question_text', p_question_text,
      'answer_text', p_answer_text, 'confidence', p_confidence,
      'updated_at', to_jsonb(now()), 'updated_via', p_updated_via);
    IF p_confidence = 'not_applicable' AND p_na_reason IS NOT NULL THEN
      new_entry := new_entry || jsonb_build_object('na_reason', p_na_reason); END IF;
  END IF;

  UPDATE public.organizations
  SET settings = jsonb_set(
    COALESCE(settings, '{}') || jsonb_build_object('prospect_context_knowledge',
      COALESCE(settings -> 'prospect_context_knowledge', '{}')),
    ARRAY['prospect_context_knowledge', p_topic_name],
    COALESCE((SELECT jsonb_agg(elem) FROM jsonb_array_elements(
      COALESCE(settings -> 'prospect_context_knowledge' -> p_topic_name, '[]')) elem
      WHERE elem ->> 'question_key' IS DISTINCT FROM p_question_key), '[]') || new_entry, true)
  WHERE id = p_org_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_org_critical_rule(
  p_org_id uuid, p_topic_name text, p_question_key text, p_question_text text, p_answer_text text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE caller_role text; new_entry jsonb; BEGIN
  SELECT role INTO caller_role FROM public.organization_users
  WHERE organization_id = p_org_id AND user_id = public.current_user_id();
  IF caller_role IS NULL OR caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  IF p_answer_text IS NULL OR length(trim(p_answer_text)) < 1 THEN
    RAISE EXCEPTION 'answer_text cannot be empty' USING ERRCODE = '22023'; END IF;
  new_entry := jsonb_build_object('question_key', p_question_key, 'question_text', p_question_text,
    'answer_text', p_answer_text, 'confidence', 'confirmed',
    'updated_at', to_jsonb(now()), 'updated_via', 'portal');
  UPDATE public.organizations
  SET settings = jsonb_set(
    COALESCE(settings, '{}') || jsonb_build_object('prospect_context_knowledge',
      COALESCE(settings -> 'prospect_context_knowledge', '{}')),
    ARRAY['prospect_context_knowledge', p_topic_name],
    COALESCE((SELECT jsonb_agg(elem) FROM jsonb_array_elements(
      COALESCE(settings -> 'prospect_context_knowledge' -> p_topic_name, '[]')) elem
      WHERE elem ->> 'question_key' IS DISTINCT FROM p_question_key), '[]') || new_entry, true)
  WHERE id = p_org_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_canned_objection_response(p_org_id uuid, p_scenario text, p_response text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE caller_role text; new_entry jsonb; BEGIN
  SELECT role INTO caller_role FROM public.organization_users
  WHERE organization_id = p_org_id AND user_id = public.current_user_id();
  IF caller_role IS NULL OR caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  new_entry := jsonb_build_object('id', gen_random_uuid(), 'scenario', p_scenario,
    'response', p_response, 'source', 'chat', 'created_at', to_jsonb(now()));
  UPDATE public.organizations
  SET settings = jsonb_set(COALESCE(settings, '{}'), ARRAY['canned_objections'],
    COALESCE(settings -> 'canned_objections', '[]') || new_entry, true)
  WHERE id = p_org_id;
  RETURN new_entry;
END;
$$;

-- Onboarding document ingestion RPCs

CREATE OR REPLACE FUNCTION public.list_pending_onboarding_documents(p_org_id uuid)
RETURNS TABLE (id uuid, filename text, source_label text, ingestion_status text, has_proposals boolean, created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE caller_role text; BEGIN
  SELECT role INTO caller_role FROM public.organization_users
  WHERE organization_id = p_org_id AND user_id = public.current_user_id();
  IF caller_role IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  SELECT d.id, d.filename, COALESCE(d.source_label, d.filename) AS source_label,
    d.ingestion_status,
    (d.onboarding_proposals IS NOT NULL AND d.onboarding_proposals <> '{}') AS has_proposals,
    d.created_at
  FROM public.documents d
  WHERE d.organization_id = p_org_id AND d.category = 'onboarding'
    AND d.ingestion_consumed = false
  ORDER BY d.created_at ASC;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_onboarding_document_consumed(p_org_id uuid, p_document_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE caller_role text; BEGIN
  SELECT role INTO caller_role FROM public.organization_users
  WHERE organization_id = p_org_id AND user_id = public.current_user_id();
  IF caller_role IS NULL OR caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  UPDATE public.documents SET ingestion_consumed = true, updated_at = now()
  WHERE id = p_document_id AND organization_id = p_org_id AND category = 'onboarding';
END;
$$;

-- Supabase API roles require explicit object privileges in addition to RLS.
-- RLS policies above remain the tenant boundary; service_role bypasses them for
-- trusted jobs and installation/bootstrap operations.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- The encryption key and raw crypto helpers are backend-only. Provider tokens
-- must never be available to browser clients, even if another policy regresses.
REVOKE ALL ON TABLE public.app_secrets FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.app_secrets TO service_role;
REVOKE ALL ON FUNCTION public._get_encryption_key() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.encrypt_token(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decrypt_token(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.encrypt_token(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decrypt_token(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._get_encryption_key() TO service_role;
GRANT EXECUTE ON FUNCTION public.encrypt_token(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.decrypt_token(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.encrypt_token(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.decrypt_token(text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
