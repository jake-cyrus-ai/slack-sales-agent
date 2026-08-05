


CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA "public";

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE TYPE "public"."user_role" AS ENUM (
    'admin',
    'member',
    'owner'
);


ALTER TYPE "public"."user_role" OWNER TO "postgres";


CREATE TYPE "public"."waitlist_status" AS ENUM (
    'pending',
    'approved',
    'rejected',
    'invited'
);


ALTER TYPE "public"."waitlist_status" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_get_encryption_key"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT value FROM public.app_secrets WHERE name = 'calendar_encryption_key';
$$;


ALTER FUNCTION "public"."_get_encryption_key"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."backfill_usage_rollups"("p_start" "date", "p_end" "date") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  -- Org daily rollups
  INSERT INTO public.usage_org_daily
    (org_id, date, total_tasks, total_workflows, total_prompts,
     total_tokens_in, total_tokens_out, total_cost_usd, active_users)
  SELECT
    org_id,
    date_trunc('day', created_at)::date                                AS date,
    COUNT(*) FILTER (WHERE event_type = 'task')                        AS total_tasks,
    COUNT(*) FILTER (WHERE event_type = 'workflow')                    AS total_workflows,
    COUNT(*) FILTER (WHERE event_type = 'prompt')                      AS total_prompts,
    COALESCE(SUM(tokens_in), 0)                                        AS total_tokens_in,
    COALESCE(SUM(tokens_out), 0)                                       AS total_tokens_out,
    COALESCE(SUM(cost_usd), 0)                                         AS total_cost_usd,
    COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL)         AS active_users
  FROM public.usage_events
  WHERE created_at >= p_start::timestamptz
    AND created_at <  (p_end + 1)::timestamptz
  GROUP BY org_id, date_trunc('day', created_at)::date
  ON CONFLICT (org_id, date) DO UPDATE SET
    total_tasks      = EXCLUDED.total_tasks,
    total_workflows  = EXCLUDED.total_workflows,
    total_prompts    = EXCLUDED.total_prompts,
    total_tokens_in  = EXCLUDED.total_tokens_in,
    total_tokens_out = EXCLUDED.total_tokens_out,
    total_cost_usd   = EXCLUDED.total_cost_usd,
    active_users     = EXCLUDED.active_users;

  -- User daily rollups
  INSERT INTO public.usage_user_daily
    (org_id, user_id, date, total_tasks, total_workflows, total_prompts,
     total_tokens_in, total_tokens_out, total_cost_usd)
  SELECT
    org_id,
    user_id,
    date_trunc('day', created_at)::date                  AS date,
    COUNT(*) FILTER (WHERE event_type = 'task')          AS total_tasks,
    COUNT(*) FILTER (WHERE event_type = 'workflow')      AS total_workflows,
    COUNT(*) FILTER (WHERE event_type = 'prompt')        AS total_prompts,
    COALESCE(SUM(tokens_in), 0)                          AS total_tokens_in,
    COALESCE(SUM(tokens_out), 0)                         AS total_tokens_out,
    COALESCE(SUM(cost_usd), 0)                           AS total_cost_usd
  FROM public.usage_events
  WHERE created_at >= p_start::timestamptz
    AND created_at <  (p_end + 1)::timestamptz
    AND user_id IS NOT NULL
  GROUP BY org_id, user_id, date_trunc('day', created_at)::date
  ON CONFLICT (org_id, user_id, date) DO UPDATE SET
    total_tasks      = EXCLUDED.total_tasks,
    total_workflows  = EXCLUDED.total_workflows,
    total_prompts    = EXCLUDED.total_prompts,
    total_tokens_in  = EXCLUDED.total_tokens_in,
    total_tokens_out = EXCLUDED.total_tokens_out,
    total_cost_usd   = EXCLUDED.total_cost_usd;
END;
$$;


ALTER FUNCTION "public"."backfill_usage_rollups"("p_start" "date", "p_end" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_org_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE
    AS $_$
  SELECT
    CASE
      WHEN jwt_org_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN jwt_org_id::UUID
      ELSE (SELECT id FROM organizations WHERE clerk_id = jwt_org_id LIMIT 1)
    END
  FROM (
    SELECT NULLIF(
      (current_setting('request.jwt.claims', true)::json->>'org_id'),
      ''
    ) AS jwt_org_id
  ) t;
$_$;


ALTER FUNCTION "public"."current_org_id"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."current_org_id"() IS 'Returns the internal organization UUID from the JWT org_id claim. Resolves Clerk org IDs to internal UUIDs via organizations.clerk_id. Parses from the full claims JSON to avoid PostgREST quote-encoding issues.';



CREATE OR REPLACE FUNCTION "public"."current_user_id"() RETURNS "text"
    LANGUAGE "sql" STABLE
    AS $$
  SELECT COALESCE(
    (current_setting('request.jwt.claims', true)::json->>'sub'),
    ''
  );
$$;


ALTER FUNCTION "public"."current_user_id"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."current_user_id"() IS 'Returns the Clerk user ID from the JWT sub claim (e.g., user_2xxx). Parses from the full claims JSON to avoid PostgREST quote-encoding issues.';



CREATE OR REPLACE FUNCTION "public"."decrypt_slack_token"("encrypted_token" "text", "encryption_key" "text") RETURNS "text"
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
  SELECT extensions.pgp_sym_decrypt(decode(encrypted_token, 'base64'), encryption_key);
$$;


ALTER FUNCTION "public"."decrypt_slack_token"("encrypted_token" "text", "encryption_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."decrypt_token"("encrypted_token" "text") RETURNS "text"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT extensions.pgp_sym_decrypt(
    decode(encrypted_token, 'base64'),
    public._get_encryption_key()
  );
$$;


ALTER FUNCTION "public"."decrypt_token"("encrypted_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."decrypt_token"("encrypted_access" "text", "encrypted_refresh" "text") RETURNS json
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT json_build_object(
    'access_token', extensions.pgp_sym_decrypt(decode(encrypted_access, 'base64'), public._get_encryption_key()),
    'refresh_token', extensions.pgp_sym_decrypt(decode(encrypted_refresh, 'base64'), public._get_encryption_key())
  );
$$;


ALTER FUNCTION "public"."decrypt_token"("encrypted_access" "text", "encrypted_refresh" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_user_data"("p_user_id" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- Phase 1: Nullify FK references in shared / org-level tables
  UPDATE slack_message_log SET agent_response_id = NULL
  WHERE agent_response_id IN (
    SELECT cm.id FROM chat_messages cm
    JOIN conversations c ON cm.conversation_id = c.id
    WHERE c.user_id = p_user_id
  );

  UPDATE conversations SET anonymized_version_id = NULL
  WHERE user_id = p_user_id;

  UPDATE shareable_documents SET created_by = NULL WHERE created_by = p_user_id;
  UPDATE context_knowledge   SET created_by = NULL WHERE created_by = p_user_id;
  UPDATE agent_email_credentials SET created_by = NULL WHERE created_by = p_user_id;
  UPDATE organization_invites   SET created_by = NULL WHERE created_by = p_user_id;

  UPDATE oauth_connections SET user_id = NULL WHERE user_id = p_user_id;
  UPDATE oauth_states      SET user_id = NULL WHERE user_id = p_user_id;

  UPDATE onboarding_progress SET completed_by = NULL WHERE completed_by = p_user_id;

  -- context_knowledge.source_document_id → documents(id)
  UPDATE context_knowledge SET source_document_id = NULL
  WHERE source_document_id IN (SELECT id FROM documents WHERE user_id = p_user_id);

  -- Org/workspace-level user references (no FK, but avoids orphaned refs)
  UPDATE organizations        SET owner_user_id = NULL        WHERE owner_user_id = p_user_id;
  UPDATE organization_invites SET accepted_by = NULL           WHERE accepted_by = p_user_id;
  UPDATE slack_workspaces     SET installed_by_user_id = NULL  WHERE installed_by_user_id = p_user_id;
  UPDATE attio_credentials    SET connected_by_user_id = NULL  WHERE connected_by_user_id = p_user_id;
  UPDATE salesforce_credentials SET connected_by_user_id = NULL WHERE connected_by_user_id = p_user_id;

  -- Phase 2: Delete deepest FK children first

  DELETE FROM document_embeddings WHERE chunk_id IN (
    SELECT dc.id FROM document_chunks dc
    JOIN documents d ON dc.document_id = d.id
    WHERE d.user_id = p_user_id
  );
  DELETE FROM document_use_cases WHERE document_id IN (
    SELECT id FROM documents WHERE user_id = p_user_id
  );
  DELETE FROM document_chunks WHERE document_id IN (
    SELECT id FROM documents WHERE user_id = p_user_id
  );

  DELETE FROM email_feedback_events WHERE draft_id IN (
    SELECT id FROM email_auto_response_drafts WHERE user_id = p_user_id
  );
  DELETE FROM email_approval_workflow_runs WHERE user_id = p_user_id;
  DELETE FROM email_auto_response_drafts  WHERE user_id = p_user_id;
  DELETE FROM email_approval_requests     WHERE user_id = p_user_id;

  DELETE FROM conversation_embeddings WHERE conversation_id IN (
    SELECT id FROM conversations WHERE user_id = p_user_id
  );
  DELETE FROM conversation_feedback WHERE conversation_id IN (
    SELECT id FROM conversations WHERE user_id = p_user_id
  );
  DELETE FROM chat_messages WHERE conversation_id IN (
    SELECT id FROM conversations WHERE user_id = p_user_id
  );

  DELETE FROM contact_enrichment WHERE contact_id IN (
    SELECT id FROM contacts WHERE user_id = p_user_id
  );
  DELETE FROM contact_interactions WHERE user_id = p_user_id;

  DELETE FROM meeting_prep_cache WHERE user_id = p_user_id;
  DELETE FROM langgraph_workflow_runs WHERE user_id = p_user_id;

  DELETE FROM slack_thread_conversations WHERE agent_user_id = p_user_id;
  DELETE FROM slack_error_events         WHERE agent_user_id = p_user_id;

  -- Phase 3: Delete parent tables
  DELETE FROM documents       WHERE user_id = p_user_id;
  DELETE FROM conversations   WHERE user_id = p_user_id;
  DELETE FROM incoming_emails WHERE user_id = p_user_id;
  DELETE FROM contacts        WHERE user_id = p_user_id;
  DELETE FROM calendar_events WHERE user_id = p_user_id;

  -- Phase 4: Delete standalone user-scoped tables
  DELETE FROM user_context              WHERE user_id = p_user_id;
  DELETE FROM user_preferences          WHERE user_id = p_user_id;
  DELETE FROM user_email_style_examples WHERE user_id = p_user_id;
  DELETE FROM user_roles                WHERE user_id = p_user_id;
  DELETE FROM user_memories             WHERE user_id = p_user_id;
  DELETE FROM calendar_credentials      WHERE user_id = p_user_id;
  DELETE FROM calendar_sync_logs        WHERE user_id = p_user_id;
  DELETE FROM gmail_poll_state          WHERE user_id = p_user_id;
  DELETE FROM gmail_watch_subscriptions WHERE user_id = p_user_id;
  DELETE FROM notifications             WHERE user_id = p_user_id;
  DELETE FROM deals                     WHERE user_id = p_user_id;
  DELETE FROM slack_user_mappings       WHERE agent_user_id = p_user_id;
  DELETE FROM granola_credentials       WHERE user_id = p_user_id;
  DELETE FROM pending_actions           WHERE user_id = p_user_id;
  DELETE FROM briefing_log              WHERE user_id = p_user_id;
  DELETE FROM reminders                 WHERE user_id = p_user_id;
  DELETE FROM digest_log                WHERE user_id = p_user_id;
  DELETE FROM processed_meetings        WHERE user_id = p_user_id;
  DELETE FROM feedback_events           WHERE user_id = p_user_id;
  DELETE FROM user_learnings            WHERE user_id = p_user_id;
  DELETE FROM usage_user_daily          WHERE user_id = p_user_id;
  DELETE FROM usage_events              WHERE user_id = p_user_id;
  DELETE FROM workflow_runs             WHERE user_id = p_user_id;

  -- Temporary OAuth state tables (short-lived but clean up for completeness)
  DELETE FROM attio_oauth_pending      WHERE user_id = p_user_id;
  DELETE FROM granola_oauth_pending    WHERE user_id = p_user_id;
  DELETE FROM salesforce_oauth_pending WHERE user_id = p_user_id;

  -- Phase 5: Final cleanup
  DELETE FROM organization_users WHERE user_id = p_user_id;
  DELETE FROM profiles           WHERE user_id = p_user_id;
END;
$$;


ALTER FUNCTION "public"."delete_user_data"("p_user_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."encrypt_slack_token"("token" "text", "encryption_key" "text") RETURNS "text"
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
  SELECT encode(extensions.pgp_sym_encrypt(token, encryption_key), 'base64');
$$;


ALTER FUNCTION "public"."encrypt_slack_token"("token" "text", "encryption_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."encrypt_token"("token" "text") RETURNS "text"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT encode(
    extensions.pgp_sym_encrypt(token, public._get_encryption_key()),
    'base64'
  );
$$;


ALTER FUNCTION "public"."encrypt_token"("token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."encrypt_token"("access_token" "text", "refresh_token" "text") RETURNS json
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT json_build_object(
    'encrypted_access', encode(extensions.pgp_sym_encrypt(access_token, public._get_encryption_key()), 'base64'),
    'encrypted_refresh', encode(extensions.pgp_sym_encrypt(refresh_token, public._get_encryption_key()), 'base64')
  );
$$;


ALTER FUNCTION "public"."encrypt_token"("access_token" "text", "refresh_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."hybrid_search_user_memories"("query_embedding" "public"."vector", "query_text" "text", "p_user_id" "text", "p_organization_id" "uuid" DEFAULT NULL::"uuid", "p_skill_namespace" "text" DEFAULT NULL::"text", "p_category" "text" DEFAULT NULL::"text", "match_threshold" double precision DEFAULT 0.15, "match_count" integer DEFAULT 5, "alpha" double precision DEFAULT 0.7) RETURNS TABLE("id" "uuid", "content" "text", "similarity" double precision, "created_at" timestamp with time zone, "metadata" "jsonb", "category" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$
DECLARE
  ts_query tsquery;
BEGIN
  -- Guard: only service role or the memory owner can call this
  IF current_setting('role', true) != 'service_role'
     AND current_user_id() != p_user_id THEN
    RAISE EXCEPTION 'access denied: caller does not own these memories';
  END IF;

  -- Build tsquery (returns NULL if empty/invalid — graceful fallback)
  BEGIN
    ts_query := plainto_tsquery('english', query_text);
  EXCEPTION WHEN OTHERS THEN
    ts_query := NULL;
  END;

  RETURN QUERY
  SELECT
    m.id,
    m.content,
    (
      (
        alpha * (1 - (m.embedding <=> query_embedding))::float
        + (1 - alpha) * COALESCE(ts_rank(m.content_tsv, ts_query), 0)::float
      )
      * GREATEST(0.5, 1.0 - 0.1 * (EXTRACT(EPOCH FROM (now() - m.created_at)) / (30 * 86400)))
    )::float AS similarity,
    m.created_at,
    m.metadata,
    m.category
  FROM public.user_memories m
  WHERE
    CASE
      WHEN p_skill_namespace = 'org_shared' THEN
        m.organization_id = p_organization_id
        AND m.skill_namespace = 'org_shared'
      ELSE
        m.user_id = p_user_id
        AND (p_organization_id IS NULL OR m.organization_id = p_organization_id)
        AND (p_skill_namespace IS NULL OR m.skill_namespace = p_skill_namespace)
    END
    AND (p_category IS NULL OR m.category = p_category)
    AND (
      (1 - (m.embedding <=> query_embedding)) > match_threshold
      OR (ts_query IS NOT NULL AND m.content_tsv @@ ts_query)
    )
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;


ALTER FUNCTION "public"."hybrid_search_user_memories"("query_embedding" "public"."vector", "query_text" "text", "p_user_id" "text", "p_organization_id" "uuid", "p_skill_namespace" "text", "p_category" "text", "match_threshold" double precision, "match_count" integer, "alpha" double precision) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_org_member"("check_org_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM organization_users
    WHERE organization_users.organization_id = check_org_id
      AND organization_users.user_id = current_user_id()
  );
$$;


ALTER FUNCTION "public"."is_org_member"("check_org_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."is_org_member"("check_org_id" "uuid") IS 'Returns true if the current JWT user (via current_user_id()) is a member of the given organization. Uses SECURITY DEFINER to bypass RLS on organization_users and avoid circular policy dependencies.';



CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table', 'partitioned table')
  LOOP
    IF cmd.schema_name IS NOT NULL
       AND cmd.schema_name IN ('public')
       AND cmd.schema_name NOT IN ('pg_catalog', 'information_schema')
       AND cmd.schema_name NOT LIKE 'pg_toast%'
       AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
    ELSE
      RAISE LOG 'rls_auto_enable: skip % (system schema or outside enforced list)', cmd.object_identity;
    END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."save_memory_if_unique"("p_user_id" "text", "p_organization_id" "uuid", "p_skill_namespace" "text", "p_content" "text", "p_embedding" "public"."vector", "p_dedup_threshold" double precision DEFAULT 0.92) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  lock_key bigint;
  existing_count int;
BEGIN
  -- Guard: only service role or the memory owner can call this
  IF current_setting('role', true) != 'service_role'
     AND current_user_id() != p_user_id THEN
    RAISE EXCEPTION 'access denied: caller does not own these memories';
  END IF;

  -- Derive a deterministic lock key from user_id
  lock_key := hashtext(p_user_id);

  -- Advisory lock serializes saves per user (released at transaction end)
  PERFORM pg_advisory_xact_lock(lock_key);

  -- Check for duplicates using vector similarity
  SELECT count(*) INTO existing_count
  FROM public.user_memories m
  WHERE m.user_id = p_user_id
    AND (p_organization_id IS NULL OR m.organization_id = p_organization_id)
    AND (p_skill_namespace IS NULL OR m.skill_namespace = p_skill_namespace)
    AND (1 - (m.embedding <=> p_embedding)) > p_dedup_threshold
  LIMIT 1;

  IF existing_count > 0 THEN
    RETURN false; -- duplicate found, skip
  END IF;

  -- Insert new memory
  INSERT INTO public.user_memories (user_id, organization_id, skill_namespace, content, embedding)
  VALUES (p_user_id, p_organization_id, p_skill_namespace, p_content, p_embedding);

  RETURN true;
END;
$$;


ALTER FUNCTION "public"."save_memory_if_unique"("p_user_id" "text", "p_organization_id" "uuid", "p_skill_namespace" "text", "p_content" "text", "p_embedding" "public"."vector", "p_dedup_threshold" double precision) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."save_memory_if_unique"("p_user_id" "text", "p_organization_id" "uuid", "p_skill_namespace" "text", "p_content" "text", "p_embedding" "public"."vector", "p_dedup_threshold" double precision DEFAULT 0.92, "p_metadata" "jsonb" DEFAULT '{}'::"jsonb", "p_category" "text" DEFAULT NULL::"text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  lock_key bigint;
  existing_count int;
BEGIN
  -- Guard: only service role or the memory owner can call this
  IF current_setting('role', true) != 'service_role'
     AND current_user_id() != p_user_id THEN
    RAISE EXCEPTION 'access denied: caller does not own these memories';
  END IF;

  lock_key := hashtext(p_user_id);
  PERFORM pg_advisory_xact_lock(lock_key);

  -- Check for duplicates using vector similarity
  SELECT count(*) INTO existing_count
  FROM public.user_memories m
  WHERE m.user_id = p_user_id
    AND (p_organization_id IS NULL OR m.organization_id = p_organization_id)
    AND (p_skill_namespace IS NULL OR m.skill_namespace = p_skill_namespace)
    AND (1 - (m.embedding <=> p_embedding)) > p_dedup_threshold
  LIMIT 1;

  IF existing_count > 0 THEN
    RETURN false;
  END IF;

  INSERT INTO public.user_memories (user_id, organization_id, skill_namespace, content, embedding, metadata, category)
  VALUES (p_user_id, p_organization_id, p_skill_namespace, p_content, p_embedding, p_metadata, p_category);

  RETURN true;
END;
$$;


ALTER FUNCTION "public"."save_memory_if_unique"("p_user_id" "text", "p_organization_id" "uuid", "p_skill_namespace" "text", "p_content" "text", "p_embedding" "public"."vector", "p_dedup_threshold" double precision, "p_metadata" "jsonb", "p_category" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_context_knowledge"("query_embedding" "public"."vector", "organization_id_filter" "uuid", "match_threshold" double precision DEFAULT 0.4, "match_count" integer DEFAULT 5, "category_filter" "text" DEFAULT NULL::"text") RETURNS TABLE("id" "uuid", "title" "text", "content" "text", "category" "text", "subcategory" "text", "tags" "text"[], "priority" "text", "similarity" double precision)
    LANGUAGE "plpgsql" STABLE
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    ck.id,
    ck.title,
    ck.content,
    ck.category,
    ck.subcategory,
    ck.tags,
    ck.priority,
    (1 - (ck.embedding <=> query_embedding))::float AS similarity
  FROM context_knowledge ck
  WHERE ck.organization_id = organization_id_filter
    AND ck.embedding IS NOT NULL
    AND (category_filter IS NULL OR ck.category = category_filter)
    AND (1 - (ck.embedding <=> query_embedding)) > match_threshold
  ORDER BY ck.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


ALTER FUNCTION "public"."search_context_knowledge"("query_embedding" "public"."vector", "organization_id_filter" "uuid", "match_threshold" double precision, "match_count" integer, "category_filter" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."search_context_knowledge"("query_embedding" "public"."vector", "organization_id_filter" "uuid", "match_threshold" double precision, "match_count" integer, "category_filter" "text") IS 'Vector similarity search on context_knowledge table. Used by the LangGraph agent context_kb_search tool.';



CREATE OR REPLACE FUNCTION "public"."search_documents"("query_embedding" "public"."vector", "organization_id_filter" "uuid", "match_threshold" double precision DEFAULT 0.4, "match_count" integer DEFAULT 5, "category_filter" "text" DEFAULT NULL::"text", "tag_filter" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("content" "text", "filename" "text", "category" "text", "similarity" double precision, "tags" "text"[])
    LANGUAGE "plpgsql" STABLE
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.content,
    d.filename,
    d.category,
    (
      (1 - (de.embedding <=> query_embedding))::float
      + CASE
          WHEN tag_filter IS NOT NULL AND d.tags IS NOT NULL
          THEN 0.08 * LEAST(
            COALESCE(array_length(
              ARRAY(SELECT unnest(d.tags) INTERSECT SELECT unnest(tag_filter)),
              1
            ), 0),
            6
          )::float
          ELSE 0.0
        END
    ) AS similarity,
    COALESCE(d.tags, ARRAY[]::text[]) AS tags
  FROM document_embeddings de
  JOIN document_chunks dc ON dc.id = de.chunk_id
  JOIN documents d ON d.id = dc.document_id
  WHERE d.organization_id = organization_id_filter
    AND d.in_knowledge_base = true
    AND de.embedding IS NOT NULL
    AND (category_filter IS NULL OR d.category = category_filter)
    -- Threshold applies to raw cosine similarity only (not tag-boosted score).
    -- Tag boosting re-ranks results that already pass the threshold.
    AND (1 - (de.embedding <=> query_embedding)) > match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;


ALTER FUNCTION "public"."search_documents"("query_embedding" "public"."vector", "organization_id_filter" "uuid", "match_threshold" double precision, "match_count" integer, "category_filter" "text", "tag_filter" "text"[]) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."search_documents"("query_embedding" "public"."vector", "organization_id_filter" "uuid", "match_threshold" double precision, "match_count" integer, "category_filter" "text", "tag_filter" "text"[]) IS 'Vector similarity search with optional tag boosting. Tags matching tag_filter add +0.08 per match (max 6) to the similarity score. Returns tags[] in results. Backward compatible — tag_filter defaults to NULL.';



CREATE OR REPLACE FUNCTION "public"."search_shareable_documents"("query_embedding" "public"."vector", "organization_id_filter" "uuid", "match_threshold" double precision DEFAULT 0.4, "match_count" integer DEFAULT 5, "doc_type_filter" "text" DEFAULT NULL::"text") RETURNS TABLE("id" "uuid", "title" "text", "description" "text", "doc_type" "text", "file_path" "text", "file_name" "text", "file_type" "text", "is_public" boolean, "requires_nda" boolean, "tags" "text"[], "similarity" double precision)
    LANGUAGE "plpgsql" STABLE
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    sd.id,
    sd.title,
    sd.description,
    sd.doc_type,
    sd.file_path,
    sd.file_name,
    sd.file_type,
    sd.is_public,
    sd.requires_nda,
    sd.tags,
    (1 - (sd.embedding <=> query_embedding))::float AS similarity
  FROM shareable_documents sd
  WHERE sd.organization_id = organization_id_filter
    AND sd.embedding IS NOT NULL
    AND (doc_type_filter IS NULL OR sd.doc_type = doc_type_filter)
    AND (1 - (sd.embedding <=> query_embedding)) > match_threshold
  ORDER BY sd.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


ALTER FUNCTION "public"."search_shareable_documents"("query_embedding" "public"."vector", "organization_id_filter" "uuid", "match_threshold" double precision, "match_count" integer, "doc_type_filter" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."search_shareable_documents"("query_embedding" "public"."vector", "organization_id_filter" "uuid", "match_threshold" double precision, "match_count" integer, "doc_type_filter" "text") IS 'Vector similarity search on shareable_documents table. Used by the LangGraph agent shareable_docs_search tool and document-share.ts.';



CREATE OR REPLACE FUNCTION "public"."search_user_memories"("query_embedding" "public"."vector", "p_user_id" "text", "p_organization_id" "uuid" DEFAULT NULL::"uuid", "p_skill_namespace" "text" DEFAULT NULL::"text", "match_threshold" double precision DEFAULT 0.3, "match_count" integer DEFAULT 5) RETURNS TABLE("id" "uuid", "content" "text", "similarity" double precision, "created_at" timestamp with time zone)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$
BEGIN
  -- Guard: only service role or the memory owner can call this
  IF current_setting('role', true) != 'service_role'
     AND current_user_id() != p_user_id THEN
    RAISE EXCEPTION 'access denied: caller does not own these memories';
  END IF;

  RETURN QUERY
  SELECT
    m.id,
    m.content,
    (1 - (m.embedding <=> query_embedding))::float AS similarity,
    m.created_at
  FROM public.user_memories m
  WHERE m.user_id = p_user_id
    AND (p_organization_id IS NULL OR m.organization_id = p_organization_id)
    AND (p_skill_namespace IS NULL OR m.skill_namespace = p_skill_namespace)
    AND (1 - (m.embedding <=> query_embedding)) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


ALTER FUNCTION "public"."search_user_memories"("query_embedding" "public"."vector", "p_user_id" "text", "p_organization_id" "uuid", "p_skill_namespace" "text", "match_threshold" double precision, "match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_feature_flag"("p_user_id" "text", "p_flag_key" "text", "p_flag_value" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  UPDATE profiles
  SET feature_flags = jsonb_set(
    COALESCE(feature_flags, '{}')::jsonb,
    ARRAY[p_flag_key],
    p_flag_value::jsonb
  )
  WHERE user_id = p_user_id;
END;
$$;


ALTER FUNCTION "public"."set_feature_flag"("p_user_id" "text", "p_flag_key" "text", "p_flag_value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_org_feature_flag"("p_org_id" "uuid", "p_flag_key" "text", "p_flag_value" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  caller_role text;
BEGIN
  SELECT role INTO caller_role
  FROM organization_users
  WHERE organization_id = p_org_id
    AND user_id = current_user_id();

  IF caller_role IS NULL OR caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Not authorized to update feature flags for this organization'
      USING ERRCODE = '42501';
  END IF;

  UPDATE organizations
  SET feature_flags = jsonb_set(
    COALESCE(feature_flags, '{}')::jsonb,
    ARRAY[p_flag_key],
    p_flag_value,
    true
  )
  WHERE id = p_org_id;
END;
$$;


ALTER FUNCTION "public"."set_org_feature_flag"("p_org_id" "uuid", "p_flag_key" "text", "p_flag_value" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."set_org_feature_flag"("p_org_id" "uuid", "p_flag_key" "text", "p_flag_value" "jsonb") IS 'Atomically set an organization feature flag. Caller must be an owner or admin of the target org (checked against organization_users.role). Raises with SQLSTATE 42501 on unauthorized callers.';



CREATE OR REPLACE FUNCTION "public"."set_org_setting"("p_org_id" "uuid", "p_setting_key" "text", "p_setting_value" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  caller_role text;
BEGIN
  SELECT role INTO caller_role
  FROM organization_users
  WHERE organization_id = p_org_id
    AND user_id = current_user_id();

  IF caller_role IS NULL OR caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Not authorized to update settings for this organization'
      USING ERRCODE = '42501';
  END IF;

  UPDATE organizations
  SET settings = jsonb_set(
    COALESCE(settings, '{}')::jsonb,
    ARRAY[p_setting_key],
    p_setting_value,
    true
  )
  WHERE id = p_org_id;
END;
$$;


ALTER FUNCTION "public"."set_org_setting"("p_org_id" "uuid", "p_setting_key" "text", "p_setting_value" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_user_memories_tsv"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.content_tsv := to_tsvector('english', NEW.content);
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_user_memories_tsv"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_workflow_run_counters"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  IF NEW.workflow_run_id IS NOT NULL THEN
    UPDATE public.workflow_runs SET
      llm_calls_count   = llm_calls_count   + CASE WHEN NEW.event_type = 'prompt'        THEN 1 ELSE 0 END,
      steps_count        = steps_count        + CASE WHEN NEW.event_type = 'workflow_step' THEN 1 ELSE 0 END,
      escalations_count  = escalations_count  + CASE WHEN NEW.event_type = 'escalation'    THEN 1 ELSE 0 END,
      tokens_in          = tokens_in          + COALESCE(NEW.tokens_in, 0),
      tokens_out         = tokens_out         + COALESCE(NEW.tokens_out, 0),
      cost_usd           = cost_usd           + COALESCE(NEW.cost_usd, 0)
    WHERE id = NEW.workflow_run_id;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_workflow_run_counters"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_contact_from_company"("p_user_id" "text", "p_company_name" "text", "p_company_domain" "text" DEFAULT NULL::"text", "p_relationship_type" "text" DEFAULT 'prospect'::"text", "p_source" "text" DEFAULT 'conversation'::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  UPDATE public.contacts SET
    company_domain = COALESCE(p_company_domain, company_domain),
    relationship_type = COALESCE(p_relationship_type, relationship_type),
    updated_at = now()
  WHERE user_id = p_user_id AND company_name = p_company_name;

  IF NOT FOUND THEN
    INSERT INTO public.contacts (user_id, email, company_name, company_domain, relationship_type, source)
    VALUES (
      p_user_id,
      COALESCE(p_company_domain, p_company_name || '@unknown'),
      p_company_name,
      p_company_domain,
      p_relationship_type,
      p_source
    );
  END IF;
END;
$$;


ALTER FUNCTION "public"."upsert_contact_from_company"("p_user_id" "text", "p_company_name" "text", "p_company_domain" "text", "p_relationship_type" "text", "p_source" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_contact_from_email"("p_user_id" "text", "p_email" "text", "p_full_name" "text" DEFAULT NULL::"text", "p_company_name" "text" DEFAULT NULL::"text", "p_relationship_type" "text" DEFAULT 'prospect'::"text", "p_source" "text" DEFAULT 'conversation'::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  INSERT INTO public.contacts (user_id, email, full_name, company_name, relationship_type, source)
  VALUES (p_user_id, p_email, p_full_name, p_company_name, p_relationship_type, p_source)
  ON CONFLICT (user_id, email) DO UPDATE SET
    full_name = COALESCE(EXCLUDED.full_name, contacts.full_name),
    company_name = COALESCE(EXCLUDED.company_name, contacts.company_name),
    relationship_type = COALESCE(EXCLUDED.relationship_type, contacts.relationship_type),
    updated_at = now();
END;
$$;


ALTER FUNCTION "public"."upsert_contact_from_email"("p_user_id" "text", "p_email" "text", "p_full_name" "text", "p_company_name" "text", "p_relationship_type" "text", "p_source" "text") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."ai_config" (
    "key" "text" NOT NULL,
    "value" "jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."ai_config" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_models" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "model_name" "text" NOT NULL,
    "base_model" "text" NOT NULL,
    "training_export_id" "uuid",
    "is_active" boolean DEFAULT false,
    "performance_metrics" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."ai_models" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."app_secrets" (
    "name" "text" NOT NULL,
    "value" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."app_secrets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."attio_credentials" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "connected_by_user_id" "text" NOT NULL,
    "access_token_encrypted" "text" DEFAULT ''::"text" NOT NULL,
    "refresh_token_encrypted" "text",
    "attio_workspace_id" "text",
    "workspace_name" "text",
    "workspace_slug" "text",
    "connected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "oauth_client_id" "text",
    "oauth_client_secret" "text",
    "oauth_token_endpoint" "text",
    "token_expiry" timestamp with time zone,
    "last_error" "text",
    "last_error_at" timestamp with time zone,
    "scopes" "text"[],
    CONSTRAINT "attio_credentials_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'disconnected'::"text", 'error'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."attio_credentials" OWNER TO "postgres";


COMMENT ON TABLE "public"."attio_credentials" IS 'Stores encrypted Attio OAuth access/refresh tokens per-organization for CRM integration';



CREATE TABLE IF NOT EXISTS "public"."attio_oauth_pending" (
    "state" "text" NOT NULL,
    "user_id" "text" NOT NULL,
    "organization_id" "uuid",
    "code_verifier" "text" NOT NULL,
    "client_id" "text" NOT NULL,
    "client_secret" "text",
    "token_endpoint" "text" NOT NULL,
    "redirect_uri" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "expires_at" timestamp with time zone DEFAULT ("now"() + '00:10:00'::interval)
);


ALTER TABLE "public"."attio_oauth_pending" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."briefing_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "organization_id" "text",
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "content_summary" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."briefing_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."calendar_credentials" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "access_token_encrypted" "text" NOT NULL,
    "refresh_token_encrypted" "text" NOT NULL,
    "token_expiry" timestamp with time zone NOT NULL,
    "calendar_email" "text" NOT NULL,
    "connected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_synced_at" timestamp with time zone,
    "sync_status" "text" DEFAULT 'active'::"text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "organization_id" "uuid",
    "last_error" "text",
    "last_error_at" timestamp with time zone,
    "last_sync_attempt" timestamp with time zone,
    "last_sync" timestamp with time zone,
    "scopes" "text"[],
    CONSTRAINT "calendar_credentials_sync_status_check" CHECK (("sync_status" = ANY (ARRAY['active'::"text", 'expired'::"text", 'disconnected'::"text", 'error'::"text", 'auth_required'::"text"])))
);


ALTER TABLE "public"."calendar_credentials" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."calendar_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "google_event_id" "text" NOT NULL,
    "calendar_id" "text" DEFAULT 'primary'::"text" NOT NULL,
    "summary" "text",
    "description" "text",
    "location" "text",
    "start_time" timestamp with time zone NOT NULL,
    "end_time" timestamp with time zone NOT NULL,
    "timezone" "text",
    "attendees" "jsonb" DEFAULT '[]'::"jsonb",
    "organizer" "jsonb",
    "event_type" "text",
    "is_all_day" boolean DEFAULT false,
    "status" "text" DEFAULT 'confirmed'::"text",
    "visibility" "text" DEFAULT 'default'::"text",
    "prep_completed" boolean DEFAULT false,
    "prep_last_generated_at" timestamp with time zone,
    "recurring_event_id" "text",
    "is_recurring_instance" boolean DEFAULT false,
    "synced_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "organization_id" "uuid",
    "html_link" "text",
    "created" timestamp with time zone,
    "updated" timestamp with time zone
);


ALTER TABLE "public"."calendar_events" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."calendar_sync_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."calendar_sync_log_id_seq" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."calendar_sync_log" (
    "id" bigint DEFAULT "nextval"('"public"."calendar_sync_log_id_seq"'::"regclass") NOT NULL,
    "triggered_at" timestamp with time zone DEFAULT "now"(),
    "status" "text",
    "message" "text",
    "users_synced" integer,
    "errors" integer
);


ALTER TABLE "public"."calendar_sync_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."calendar_sync_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "sync_type" "text" NOT NULL,
    "sync_status" "text" NOT NULL,
    "events_added" integer DEFAULT 0,
    "events_updated" integer DEFAULT 0,
    "events_deleted" integer DEFAULT 0,
    "date_from" timestamp with time zone,
    "date_to" timestamp with time zone,
    "error_message" "text",
    "error_details" "jsonb",
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "organization_id" "uuid",
    CONSTRAINT "calendar_sync_logs_sync_status_check" CHECK (("sync_status" = ANY (ARRAY['started'::"text", 'completed'::"text", 'failed'::"text", 'partial'::"text"]))),
    CONSTRAINT "calendar_sync_logs_sync_type_check" CHECK (("sync_type" = ANY (ARRAY['initial'::"text", 'incremental'::"text", 'full'::"text", 'on_demand'::"text", 'scheduled'::"text"])))
);


ALTER TABLE "public"."calendar_sync_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chat_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "content" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    CONSTRAINT "chat_messages_role_check" CHECK (("role" = ANY (ARRAY['user'::"text", 'assistant'::"text"])))
);


ALTER TABLE "public"."chat_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contact_enrichment" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "contact_id" "uuid" NOT NULL,
    "linkedin_headline" "text",
    "linkedin_summary" "text",
    "linkedin_profile_image_url" "text",
    "linkedin_connections" integer,
    "linkedin_last_updated" timestamp with time zone,
    "web_research_summary" "text",
    "web_research_sources" "jsonb",
    "web_research_last_updated" timestamp with time zone,
    "company_size_range" "text",
    "company_industry" "text",
    "company_recent_news" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."contact_enrichment" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contact_interactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "contact_id" "uuid" NOT NULL,
    "user_id" "text" NOT NULL,
    "interaction_type" "text" NOT NULL,
    "interaction_date" timestamp with time zone DEFAULT "now"() NOT NULL,
    "subject" "text",
    "summary" "text",
    "outcome" "text",
    "calendar_event_id" "uuid",
    "email_thread_id" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "organization_id" "uuid",
    CONSTRAINT "contact_interactions_interaction_type_check" CHECK (("interaction_type" = ANY (ARRAY['email'::"text", 'call'::"text", 'meeting'::"text", 'linkedin_message'::"text", 'note'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."contact_interactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "first_name" "text",
    "last_name" "text",
    "full_name" "text",
    "email" "text" NOT NULL,
    "phone" "text",
    "title" "text",
    "company_name" "text",
    "company_domain" "text",
    "department" "text",
    "linkedin_url" "text",
    "twitter_url" "text",
    "relationship_type" "text",
    "relationship_strength" "text",
    "first_contact_date" timestamp with time zone,
    "last_contact_date" timestamp with time zone,
    "last_meeting_date" timestamp with time zone,
    "next_follow_up_date" timestamp with time zone,
    "total_meetings" integer DEFAULT 0,
    "total_emails" integer DEFAULT 0,
    "notes" "text",
    "tags" "text"[],
    "custom_fields" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "source" "text" DEFAULT 'manual'::"text",
    "organization_id" "uuid",
    CONSTRAINT "contacts_relationship_strength_check" CHECK (("relationship_strength" = ANY (ARRAY['cold'::"text", 'warm'::"text", 'hot'::"text", 'champion'::"text"]))),
    CONSTRAINT "contacts_relationship_type_check" CHECK (("relationship_type" = ANY (ARRAY['prospect'::"text", 'customer'::"text", 'partner'::"text", 'candidate'::"text", 'vendor'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."contacts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."context_knowledge" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "content" "text" NOT NULL,
    "category" "text" NOT NULL,
    "subcategory" "text",
    "embedding" "public"."vector",
    "source_document_id" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "tags" "text"[] DEFAULT '{}'::"text"[],
    "priority" "text" DEFAULT 'medium'::"text",
    "created_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "context_knowledge_category_check" CHECK (("category" = ANY (ARRAY['sales-playbook'::"text", 'competitive-intel'::"text", 'company-culture'::"text", 'process'::"text", 'pricing-strategy'::"text", 'objection-handling'::"text", 'product-positioning'::"text", 'other'::"text"]))),
    CONSTRAINT "context_knowledge_priority_check" CHECK (("priority" = ANY (ARRAY['high'::"text", 'medium'::"text", 'low'::"text"])))
);


ALTER TABLE "public"."context_knowledge" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."conversation_embeddings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "embedding" "public"."vector",
    "summary" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."conversation_embeddings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."conversation_feedback" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "message_id" "text",
    "user_id" "text" NOT NULL,
    "feedback_type" character varying NOT NULL,
    "feedback_value" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "conversation_feedback_feedback_type_check" CHECK ((("feedback_type")::"text" = ANY (ARRAY[('thumbs_up'::character varying)::"text", ('thumbs_down'::character varying)::"text", ('flag'::character varying)::"text", ('edit_suggestion'::character varying)::"text"])))
);


ALTER TABLE "public"."conversation_feedback" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."conversation_insights" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "insight_type" character varying NOT NULL,
    "insight_content" "text" NOT NULL,
    "source_count" integer NOT NULL,
    "confidence_score" double precision,
    "embedding" "public"."vector",
    "tags" "text"[],
    "is_public" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "conversation_insights_confidence_score_check" CHECK ((("confidence_score" >= (0.0)::double precision) AND ("confidence_score" <= (1.0)::double precision)))
);


ALTER TABLE "public"."conversation_insights" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."conversations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "title" "text" DEFAULT 'New chat'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "archived" boolean DEFAULT false,
    "conversation_type" character varying,
    "is_training_approved" boolean DEFAULT true,
    "quality_score" integer,
    "training_notes" "text",
    "is_sensitive" boolean DEFAULT false,
    "anonymized_version_id" "uuid",
    "source" "text" DEFAULT 'web'::"text" NOT NULL,
    "organization_id" "uuid",
    CONSTRAINT "conversations_quality_score_check" CHECK ((("quality_score" >= 1) AND ("quality_score" <= 5)))
);


ALTER TABLE "public"."conversations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_email_credentials" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "email_address" "text" NOT NULL,
    "display_name" "text" DEFAULT 'Sales Agent'::"text",
    "refresh_token" "text" NOT NULL,
    "access_token" "text",
    "token_expires_at" timestamp with time zone,
    "provider" "text" DEFAULT 'google'::"text" NOT NULL,
    "is_active" boolean DEFAULT true,
    "last_verified_at" timestamp with time zone,
    "verification_status" "text" DEFAULT 'pending'::"text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "agent_email_credentials_verification_status_check" CHECK (("verification_status" = ANY (ARRAY['pending'::"text", 'verified'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."agent_email_credentials" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "company_name" "text" NOT NULL,
    "contact_name" "text",
    "status" "text" DEFAULT 'Active'::"text" NOT NULL,
    "value" numeric,
    "stage" "text" DEFAULT 'Lead'::"text" NOT NULL,
    "last_activity" "date",
    "next_milestone" "text",
    "days_until_milestone" integer,
    "health_score" integer,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "organization_id" "uuid",
    "contact_email" "text",
    "crm_signal_hash" "text",
    "alerted_signals" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "muted_signals" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "agent_mode" "text" DEFAULT 'autonomous'::"text" NOT NULL,
    "assigned_rep_user_id" "text",
    CONSTRAINT "deals_agent_mode_check" CHECK (("agent_mode" = ANY (ARRAY['autonomous'::"text", 'copilot'::"text", 'off'::"text"]))),
    CONSTRAINT "deals_health_score_check" CHECK ((("health_score" >= 0) AND ("health_score" <= 100))),
    CONSTRAINT "deals_status_check" CHECK (("status" = ANY (ARRAY['Active'::"text", 'Won'::"text", 'Lost'::"text", 'Paused'::"text"])))
);


ALTER TABLE "public"."deals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."digest_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "organization_id" "text" NOT NULL,
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "content_summary" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."digest_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."document_chunks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "document_id" "uuid" NOT NULL,
    "content" "text" NOT NULL,
    "chunk_index" integer NOT NULL,
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "organization_id" "uuid"
);


ALTER TABLE "public"."document_chunks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."document_embeddings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "chunk_id" "uuid" NOT NULL,
    "embedding" "public"."vector",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "organization_id" "uuid"
);


ALTER TABLE "public"."document_embeddings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."document_use_cases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "document_id" "uuid" NOT NULL,
    "use_case_name" character varying NOT NULL,
    "use_case_pattern" "text" NOT NULL,
    "always_include" boolean DEFAULT true,
    "boost_factor" numeric DEFAULT 2.0,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "organization_id" "uuid"
);


ALTER TABLE "public"."document_use_cases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "filename" "text" NOT NULL,
    "file_path" "text" NOT NULL,
    "file_type" "text" NOT NULL,
    "category" "text",
    "upload_date" timestamp with time zone DEFAULT "now"(),
    "processed" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "tags" "text"[] DEFAULT '{}'::"text"[],
    "subcategory" character varying,
    "description" "text",
    "priority" character varying DEFAULT 'medium'::character varying,
    "organization_id" "uuid",
    "is_shareable" boolean DEFAULT false,
    "in_knowledge_base" boolean DEFAULT true,
    "doc_type" "text",
    "needs_configuration" boolean DEFAULT false,
    CONSTRAINT "documents_doc_type_check" CHECK ((("doc_type" IS NULL) OR ("doc_type" = ANY (ARRAY['agent-playbook'::"text", 'soc2'::"text", 'pen-test'::"text", 'msa'::"text", 'terms'::"text", 'privacy'::"text", 'datasheet'::"text", 'case-study'::"text", 'comparison'::"text", 'presentation'::"text", 'one-pager'::"text", 'other'::"text"]))))
);


ALTER TABLE "public"."documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."email_approval_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "recipient_email" "text" NOT NULL,
    "recipient_name" "text",
    "subject" "text" NOT NULL,
    "body" "text" NOT NULL,
    "original_request" "text",
    "source_type" "text" DEFAULT 'slack'::"text" NOT NULL,
    "slack_workspace_id" "uuid",
    "slack_channel_id" "text",
    "slack_thread_ts" "text",
    "slack_message_ts" "text",
    "langgraph_thread_id" "text",
    "langgraph_workflow_run_id" "uuid",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "approved_at" timestamp with time zone,
    "rejected_at" timestamp with time zone,
    "rejection_reason" "text",
    "edit_history" "jsonb" DEFAULT '[]'::"jsonb",
    "edit_count" integer DEFAULT 0,
    "sent_at" timestamp with time zone,
    "send_error" "text",
    "email_message_id" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '24:00:00'::interval),
    CONSTRAINT "email_approval_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text", 'edited'::"text", 'expired'::"text", 'sent'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."email_approval_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."email_approval_workflow_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "approval_request_id" "uuid",
    "thread_id" "text" NOT NULL,
    "run_id" "text",
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "current_step" "text",
    "source_message" "text",
    "source_channel" "text",
    "source_thread_ts" "text",
    "error_message" "text",
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "total_duration_ms" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "email_approval_workflow_runs_status_check" CHECK (("status" = ANY (ARRAY['running'::"text", 'awaiting_approval'::"text", 'processing_reply'::"text", 'completed'::"text", 'failed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."email_approval_workflow_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."email_auto_response_drafts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "incoming_email_id" "uuid",
    "user_id" "text" NOT NULL,
    "organization_id" "uuid",
    "subject" "text" NOT NULL,
    "body" "text" NOT NULL,
    "to_email" "text" NOT NULL,
    "to_name" "text",
    "send_as" "text" DEFAULT 'user'::"text" NOT NULL,
    "reply_to_email" "text",
    "classification" "text" NOT NULL,
    "attachments" "jsonb" DEFAULT '[]'::"jsonb",
    "context_kb_results" "jsonb" DEFAULT '[]'::"jsonb",
    "shareable_docs_results" "jsonb" DEFAULT '[]'::"jsonb",
    "user_context_applied" "jsonb" DEFAULT '{}'::"jsonb",
    "agent_reasoning" "text",
    "confidence_score" double precision,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "slack_workspace_id" "uuid",
    "slack_channel_id" "text",
    "slack_thread_ts" "text",
    "slack_message_ts" "text",
    "edit_history" "jsonb" DEFAULT '[]'::"jsonb",
    "edit_count" integer DEFAULT 0,
    "approved_at" timestamp with time zone,
    "sent_at" timestamp with time zone,
    "gmail_message_id" "text",
    "gmail_thread_id" "text",
    "send_error" "text",
    "original_ai_body" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "send_mode" "text" DEFAULT 'approval'::"text" NOT NULL,
    "auto_send_reasoning" "text",
    "conversation_stage" "text",
    "followup_number" integer,
    "is_followup" boolean DEFAULT false,
    "thread_conversation_id" "uuid",
    CONSTRAINT "email_auto_response_drafts_send_as_check" CHECK (("send_as" = ANY (ARRAY['user'::"text", 'agent'::"text"]))),
    CONSTRAINT "email_auto_response_drafts_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'pending_approval'::"text", 'approved'::"text", 'rejected'::"text", 'edited'::"text", 'sent'::"text", 'failed'::"text", 'auto_sending'::"text", 'auto_sent'::"text", 'send_failed'::"text"])))
);


ALTER TABLE "public"."email_auto_response_drafts" OWNER TO "postgres";


COMMENT ON COLUMN "public"."email_auto_response_drafts"."auto_send_reasoning" IS 'When status=auto_sent, explains why the email qualified for autonomous sending';



CREATE TABLE IF NOT EXISTS "public"."email_classifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "message_id" "text" NOT NULL,
    "user_id" "text" NOT NULL,
    "organization_id" "uuid",
    "classification" "text" NOT NULL,
    "confidence" numeric NOT NULL,
    "should_process" boolean NOT NULL,
    "classification_method" "text" NOT NULL,
    "reasoning" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."email_classifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."email_feedback_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "draft_id" "uuid" NOT NULL,
    "original_body" "text" NOT NULL,
    "sent_body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."email_feedback_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."email_scheduled_followups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "organization_id" "uuid",
    "thread_conversation_id" "uuid" NOT NULL,
    "scheduled_for" timestamp with time zone NOT NULL,
    "followup_number" integer DEFAULT 1 NOT NULL,
    "subject" "text",
    "body" "text",
    "status" "text" DEFAULT 'scheduled'::"text" NOT NULL,
    "cancelled_reason" "text",
    "sent_at" timestamp with time zone,
    "draft_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "email_scheduled_followups_status_check" CHECK (("status" = ANY (ARRAY['scheduled'::"text", 'generating'::"text", 'sending'::"text", 'sent'::"text", 'cancelled'::"text", 'failed'::"text", 'superseded'::"text"])))
);


ALTER TABLE "public"."email_scheduled_followups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."email_thread_conversations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "organization_id" "uuid",
    "gmail_thread_id" "text" NOT NULL,
    "from_email" "text" NOT NULL,
    "from_name" "text",
    "from_domain" "text",
    "subject" "text" NOT NULL,
    "message_count" integer DEFAULT 1,
    "our_reply_count" integer DEFAULT 0,
    "their_reply_count" integer DEFAULT 0,
    "last_message_at" timestamp with time zone,
    "last_our_reply_at" timestamp with time zone,
    "last_their_reply_at" timestamp with time zone,
    "conversation_stage" "text" DEFAULT 'intro'::"text",
    "stage_updated_at" timestamp with time zone DEFAULT "now"(),
    "contact_id" "uuid",
    "deal_id" "uuid",
    "next_followup_at" timestamp with time zone,
    "followup_count" integer DEFAULT 0,
    "max_followups" integer DEFAULT 3,
    "followup_status" "text" DEFAULT 'none'::"text",
    "last_agent_reasoning" "text",
    "last_confidence_score" numeric,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "email_thread_conversations_conversation_stage_check" CHECK (("conversation_stage" = ANY (ARRAY['intro'::"text", 'discovery'::"text", 'demo'::"text", 'proposal'::"text", 'negotiation'::"text", 'closed_won'::"text", 'closed_lost'::"text", 'nurture'::"text", 'meeting_scheduled'::"text", 'demo_scheduling'::"text", 'demo_followup'::"text", 'closing'::"text", 'won'::"text", 'lost'::"text"]))),
    CONSTRAINT "email_thread_conversations_followup_status_check" CHECK (("followup_status" = ANY (ARRAY['none'::"text", 'scheduled'::"text", 'sent'::"text", 'replied'::"text", 'exhausted'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."email_thread_conversations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."feedback_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "domain" "text" NOT NULL,
    "signal_type" "text" NOT NULL,
    "agent_output" "jsonb",
    "user_action" "jsonb",
    "delta" "jsonb",
    "context" "jsonb",
    "source_ref" "jsonb",
    "processed" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."feedback_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."gmail_poll_state" (
    "user_id" "text" NOT NULL,
    "last_history_id" bigint,
    "last_poll_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."gmail_poll_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."gmail_watch_subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "history_id" bigint NOT NULL,
    "expiration" timestamp with time zone NOT NULL,
    "topic_name" "text" NOT NULL,
    "label_ids" "text"[] DEFAULT '{INBOX}'::"text"[],
    "include_spam_trash" boolean DEFAULT false,
    "is_active" boolean DEFAULT true,
    "last_notification_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."gmail_watch_subscriptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."granola_credentials" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "organization_id" "uuid",
    "access_token_encrypted" "text" NOT NULL,
    "refresh_token_encrypted" "text",
    "token_expiry" timestamp with time zone,
    "oauth_client_id" "text",
    "oauth_client_secret" "text",
    "oauth_token_endpoint" "text",
    "granola_email" "text",
    "connected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sync_status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_error" "text",
    "last_error_at" timestamp with time zone,
    "scopes" "text"[],
    CONSTRAINT "granola_credentials_sync_status_check" CHECK (("sync_status" = ANY (ARRAY['active'::"text", 'expired'::"text", 'disconnected'::"text", 'error'::"text"])))
);


ALTER TABLE "public"."granola_credentials" OWNER TO "postgres";


COMMENT ON TABLE "public"."granola_credentials" IS 'Stores encrypted Granola MCP OAuth credentials for per-user meeting notes access';



CREATE TABLE IF NOT EXISTS "public"."granola_oauth_pending" (
    "state" "text" NOT NULL,
    "user_id" "text" NOT NULL,
    "organization_id" "uuid",
    "code_verifier" "text" NOT NULL,
    "client_id" "text" NOT NULL,
    "client_secret" "text",
    "token_endpoint" "text" NOT NULL,
    "authorization_endpoint" "text" NOT NULL,
    "registration_endpoint" "text",
    "redirect_uri" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "expires_at" timestamp with time zone DEFAULT ("now"() + '00:10:00'::interval)
);


ALTER TABLE "public"."granola_oauth_pending" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."incoming_emails" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "organization_id" "uuid",
    "gmail_message_id" "text" NOT NULL,
    "gmail_thread_id" "text" NOT NULL,
    "gmail_history_id" bigint,
    "from_email" "text" NOT NULL,
    "from_name" "text",
    "from_domain" "text",
    "to_email" "text" NOT NULL,
    "subject" "text" NOT NULL,
    "body_text" "text",
    "body_html" "text",
    "snippet" "text",
    "received_at" timestamp with time zone NOT NULL,
    "has_attachments" boolean DEFAULT false,
    "attachment_count" integer DEFAULT 0,
    "is_reply" boolean DEFAULT false,
    "in_reply_to" "text",
    "classification" "text",
    "classification_confidence" double precision,
    "classification_reasoning" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "processed_at" timestamp with time zone,
    "agent_workflow_run_id" "uuid",
    "error_message" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "labels" "text"[],
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "qualification_category" "text",
    "qualification_reasoning" "text",
    "qualification_confidence" numeric,
    "qualified_at" timestamp with time zone,
    "message_id_header" "text",
    "priority" "text" DEFAULT 'medium'::"text",
    "triage_labels" "text"[] DEFAULT '{}'::"text"[],
    "triaged_at" timestamp with time zone,
    CONSTRAINT "incoming_emails_classification_check" CHECK (("classification" = ANY (ARRAY['documentation_request'::"text", 'product_question'::"text", 'battlecard_question'::"text", 'sales_faq'::"text", 'process_request'::"text", 'unclassified'::"text", 'skip'::"text"]))),
    CONSTRAINT "incoming_emails_priority_check" CHECK (("priority" = ANY (ARRAY['high'::"text", 'medium'::"text", 'low'::"text"]))),
    CONSTRAINT "incoming_emails_qualification_category_check" CHECK ((("qualification_category" IS NULL) OR ("qualification_category" = ANY (ARRAY['customer_prospect'::"text", 'support_request'::"text", 'partnership_inquiry'::"text", 'internal'::"text", 'spam_marketing'::"text", 'automated'::"text", 'cold_outreach'::"text", 'recruiting'::"text", 'unknown'::"text"])))),
    CONSTRAINT "incoming_emails_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'draft_ready'::"text", 'approved'::"text", 'sent'::"text", 'rejected'::"text", 'skipped'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."incoming_emails" OWNER TO "postgres";


COMMENT ON COLUMN "public"."incoming_emails"."priority" IS 'Auto-assigned priority: high, medium, low — set by the auto-triage step in poll-gmail-inboxes';



COMMENT ON COLUMN "public"."incoming_emails"."triage_labels" IS 'Heuristic labels assigned during auto-triage (e.g. urgent, deal_related, newsletter)';



COMMENT ON COLUMN "public"."incoming_emails"."triaged_at" IS 'Timestamp when the email was auto-triaged';



CREATE TABLE IF NOT EXISTS "public"."langgraph_workflow_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "event_id" "uuid",
    "thread_id" "text" NOT NULL,
    "run_id" "text" NOT NULL,
    "status" "text" NOT NULL,
    "workflow_type" "text" DEFAULT 'meeting_prep'::"text" NOT NULL,
    "attendees_to_research" "jsonb" DEFAULT '[]'::"jsonb",
    "attendees_completed" "jsonb" DEFAULT '[]'::"jsonb",
    "research_decisions" "jsonb" DEFAULT '{}'::"jsonb",
    "awaiting_approval" boolean DEFAULT false,
    "approval_requested_at" timestamp with time zone,
    "approval_received_at" timestamp with time zone,
    "approval_decision" "text",
    "approval_notes" "text",
    "final_prep_content" "text",
    "sources_used" "jsonb" DEFAULT '[]'::"jsonb",
    "total_cost_usd" numeric,
    "llm_calls_count" integer DEFAULT 0,
    "api_calls_count" integer DEFAULT 0,
    "error_message" "text",
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "total_duration_ms" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "langgraph_workflow_runs_status_check" CHECK (("status" = ANY (ARRAY['running'::"text", 'interrupted'::"text", 'completed'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."langgraph_workflow_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meeting_prep_cache" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "event_id" "uuid" NOT NULL,
    "prep_content" "text" NOT NULL,
    "prep_summary" "text",
    "knowledge_base_sources" "jsonb" DEFAULT '[]'::"jsonb",
    "deal_context" "jsonb",
    "web_research_sources" "jsonb" DEFAULT '[]'::"jsonb",
    "generated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "workflow_run_id" "uuid",
    "generation_method" "text" DEFAULT 'deterministic'::"text",
    "confidence_score" numeric,
    "research_depth" "text",
    "organization_id" "uuid",
    CONSTRAINT "meeting_prep_cache_generation_method_check" CHECK (("generation_method" = ANY (ARRAY['deterministic'::"text", 'langgraph_agent'::"text"]))),
    CONSTRAINT "meeting_prep_cache_research_depth_check" CHECK (("research_depth" = ANY (ARRAY['minimal'::"text", 'standard'::"text", 'deep'::"text"])))
);


ALTER TABLE "public"."meeting_prep_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "message" "text",
    "channel" "text",
    "deal_name" "text",
    "metadata" "jsonb",
    "read" boolean DEFAULT false NOT NULL,
    "user_id" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."oauth_connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid",
    "user_id" "text",
    "provider" "text" NOT NULL,
    "access_token" "text" NOT NULL,
    "refresh_token" "text",
    "scopes" "text"[] DEFAULT '{}'::"text"[],
    "expires_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "oauth_connections_provider_check" CHECK (("provider" = ANY (ARRAY['slack_bot'::"text", 'slack_user'::"text", 'google_workspace'::"text"])))
);


ALTER TABLE "public"."oauth_connections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."oauth_states" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid",
    "user_id" "text",
    "provider" "text" NOT NULL,
    "invite_token" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "expires_at" timestamp with time zone DEFAULT ("now"() + '00:10:00'::interval),
    "redirect_uri" "text",
    CONSTRAINT "oauth_states_provider_check" CHECK (("provider" = ANY (ARRAY['slack_bot'::"text", 'slack_user'::"text", 'google_workspace'::"text"]))),
    CONSTRAINT "oauth_states_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'completed'::"text", 'failed'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."oauth_states" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."onboarding_progress" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "current_step" integer DEFAULT 1 NOT NULL,
    "status" "text" DEFAULT 'not_started'::"text" NOT NULL,
    "steps_completed" "jsonb" DEFAULT '{"1": false, "2": false, "3": false, "4": false, "5": false}'::"jsonb",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "last_updated" timestamp with time zone DEFAULT "now"(),
    "completed_at" timestamp with time zone,
    "completed_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "onboarding_progress_current_step_check" CHECK ((("current_step" >= 1) AND ("current_step" <= 5))),
    CONSTRAINT "onboarding_progress_status_check" CHECK (("status" = ANY (ARRAY['not_started'::"text", 'in_progress'::"text", 'completed'::"text"])))
);


ALTER TABLE "public"."onboarding_progress" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."org_context" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "product_name" "text",
    "product_description" "text",
    "product_features" "jsonb" DEFAULT '[]'::"jsonb",
    "product_pricing_summary" "text",
    "product_use_cases" "jsonb" DEFAULT '[]'::"jsonb",
    "icp_industries" "jsonb" DEFAULT '[]'::"jsonb",
    "icp_company_sizes" "jsonb" DEFAULT '[]'::"jsonb",
    "icp_titles" "jsonb" DEFAULT '[]'::"jsonb",
    "icp_pain_points" "jsonb" DEFAULT '[]'::"jsonb",
    "icp_description" "text",
    "competitors" "jsonb" DEFAULT '[]'::"jsonb",
    "competitive_advantages" "jsonb" DEFAULT '[]'::"jsonb",
    "research_sources" "jsonb" DEFAULT '[]'::"jsonb",
    "last_researched_at" timestamp with time zone,
    "research_status" "text" DEFAULT 'pending'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "org_context_research_status_check" CHECK (("research_status" = ANY (ARRAY['pending'::"text", 'researching'::"text", 'complete'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."org_context" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organization_invites" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "token" "text" NOT NULL,
    "email" "text",
    "role" "text" DEFAULT 'member'::"text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '7 days'::interval),
    "created_by" "text",
    "accepted_by" "text",
    "accepted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "organization_invites_role_check" CHECK (("role" = ANY (ARRAY['admin'::"text", 'member'::"text"]))),
    CONSTRAINT "organization_invites_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'expired'::"text", 'revoked'::"text"])))
);


ALTER TABLE "public"."organization_invites" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organization_slack_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "slack_workspace_id" "uuid",
    "default_channel_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."organization_slack_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organization_users" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "user_id" "text" NOT NULL,
    "role" "text" DEFAULT 'member'::"text" NOT NULL,
    "joined_at" timestamp with time zone DEFAULT "now"(),
    "invited_by" "text",
    CONSTRAINT "organization_users_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'admin'::"text", 'member'::"text"])))
);


ALTER TABLE "public"."organization_users" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organizations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text",
    "logo_url" "text",
    "owner_user_id" "text",
    "settings" "jsonb" DEFAULT '{}'::"jsonb",
    "feature_flags" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "clerk_id" "text",
    "autonomous_agent_user_id" "text"
);


ALTER TABLE "public"."organizations" OWNER TO "postgres";


COMMENT ON COLUMN "public"."organizations"."clerk_id" IS 'Clerk organization ID (e.g., org_2xxx) for webhook reconciliation';

COMMENT ON COLUMN "public"."organizations"."autonomous_agent_user_id" IS 'Clerk user ID of the dedicated Autonomous agent (e.g., agent@company.com) that owns the autonomous email pipeline';


CREATE TABLE IF NOT EXISTS "public"."pending_actions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "organization_id" "uuid",
    "action_type" "text" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "rationale" "text",
    "evidence" "jsonb" DEFAULT '[]'::"jsonb",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "slack_channel_id" "text",
    "slack_message_ts" "text",
    "run_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone,
    "resolved_by" "text"
);


ALTER TABLE "public"."pending_actions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."plg_users" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "original_user_id" "text" NOT NULL,
    "email" "text" NOT NULL,
    "first_name" "text",
    "last_name" "text",
    "company" "text",
    "title" "text",
    "linkedin_profile" "text",
    "user_context" "text",
    "original_created_at" timestamp with time zone,
    "last_sign_in_at" timestamp with time zone,
    "archived_at" timestamp with time zone DEFAULT "now"(),
    "organization_memberships" "jsonb",
    "deletion_executed" boolean DEFAULT false
);


ALTER TABLE "public"."plg_users" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."processed_meetings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "organization_id" "uuid",
    "source" "text" NOT NULL,
    "external_meeting_id" "text" NOT NULL,
    "meeting_title" "text",
    "meeting_end_time" timestamp with time zone,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "workflow_run_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "processed_meetings_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'dismissed'::"text", 'error'::"text"])))
);


ALTER TABLE "public"."processed_meetings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "first_name" "text",
    "last_name" "text",
    "email" "text" NOT NULL,
    "company" "text",
    "linkedin_profile" "text",
    "title" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "user_context" "text",
    "cookie_consent" "text",
    "cookie_consent_date" timestamp with time zone,
    "feature_flags" "jsonb" DEFAULT '{}'::"jsonb",
    "profile_completed" boolean DEFAULT false,
    "avatar_url" "text",
    "timezone" "text" DEFAULT 'America/New_York'::"text"
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


COMMENT ON COLUMN "public"."profiles"."user_id" IS 'Clerk user ID (e.g., user_2xxx) - primary user identifier';



CREATE TABLE IF NOT EXISTS "public"."reminders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "organization_id" "text" NOT NULL,
    "reminder_text" "text" NOT NULL,
    "trigger_at" timestamp with time zone NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "snoozed_until" timestamp with time zone,
    "slack_message_ts" "text",
    "source" "text" DEFAULT 'chat'::"text" NOT NULL,
    "source_ref" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "reminders_source_check" CHECK (("source" = ANY (ARRAY['chat'::"text", 'slack'::"text", 'meeting_followup'::"text", 'system'::"text"]))),
    CONSTRAINT "reminders_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'firing'::"text", 'sent'::"text", 'dismissed'::"text", 'snoozed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."reminders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."salesforce_credentials" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "instance_url" "text" NOT NULL,
    "salesforce_org_id" "text",
    "organization_name" "text",
    "access_token_encrypted" "text" NOT NULL,
    "refresh_token_encrypted" "text",
    "token_expiry" timestamp with time zone,
    "oauth_client_id" "text",
    "oauth_client_secret_encrypted" "text",
    "connected_by_user_id" "text" NOT NULL,
    "sync_status" "text" DEFAULT 'active'::"text" NOT NULL,
    "connected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "salesforce_credentials_sync_status_check" CHECK (("sync_status" = ANY (ARRAY['active'::"text", 'expired'::"text", 'disconnected'::"text", 'error'::"text"])))
);


ALTER TABLE "public"."salesforce_credentials" OWNER TO "postgres";


COMMENT ON TABLE "public"."salesforce_credentials" IS 'Stores encrypted Salesforce OAuth credentials per organization for multi-tenant Salesforce access';



CREATE TABLE IF NOT EXISTS "public"."salesforce_oauth_pending" (
    "state" "text" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "user_id" "text" NOT NULL,
    "code_verifier" "text" NOT NULL,
    "use_custom_app" boolean DEFAULT false NOT NULL,
    "custom_client_id" "text",
    "custom_client_secret_encrypted" "text",
    "redirect_uri" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "expires_at" timestamp with time zone DEFAULT ("now"() + '00:10:00'::interval)
);


ALTER TABLE "public"."salesforce_oauth_pending" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."shareable_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "file_path" "text",
    "file_name" "text",
    "file_type" "text",
    "file_size_bytes" integer,
    "content" "text",
    "doc_type" "text" NOT NULL,
    "embedding" "public"."vector",
    "is_public" boolean DEFAULT false,
    "requires_nda" boolean DEFAULT false,
    "version" "text" DEFAULT '1.0'::"text",
    "valid_from" "date",
    "valid_until" "date",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "tags" "text"[] DEFAULT '{}'::"text"[],
    "created_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "in_knowledge_base" boolean DEFAULT true,
    "needs_configuration" boolean DEFAULT false,
    CONSTRAINT "shareable_documents_doc_type_check" CHECK (("doc_type" = ANY (ARRAY['agent-playbook'::"text", 'soc2'::"text", 'pen-test'::"text", 'msa'::"text", 'terms'::"text", 'privacy'::"text", 'datasheet'::"text", 'case-study'::"text", 'comparison'::"text", 'presentation'::"text", 'one-pager'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."shareable_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."slack_error_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "occurred_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone,
    "organization_id" "uuid",
    "agent_user_id" "text",
    "slack_user_id" "text",
    "slack_team_id" "text",
    "slack_channel_id" "text",
    "slack_thread_ts" "text",
    "thinking_ts" "text",
    "thread_permalink" "text",
    "conversation_id" "uuid",
    "inngest_run_id" "text",
    "inngest_function_id" "text",
    "attempt" integer,
    "step" "text",
    "error_name" "text",
    "error_message" "text",
    "error_stack" "text",
    "error_category" "text",
    "user_message" "text",
    "classified_intent" "text",
    "domain_signals" "jsonb",
    "agent_state" "jsonb",
    "sanitized_event_payload" "jsonb",
    "backup_outcome" "text",
    "backup_response_preview" "text"
);


ALTER TABLE "public"."slack_error_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."slack_message_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slack_workspace_id" "uuid",
    "slack_user_id" "text",
    "slack_channel_id" "text",
    "slack_thread_ts" "text",
    "message_ts" "text",
    "event_type" "text" NOT NULL,
    "raw_event" "jsonb",
    "agent_response_id" "uuid",
    "processing_time_ms" integer,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."slack_message_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."slack_oauth_states" (
    "state" "text" NOT NULL,
    "slack_user_id" "text" NOT NULL,
    "slack_workspace_id" "uuid",
    "slack_channel_id" "text",
    "slack_thread_ts" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "expires_at" timestamp with time zone DEFAULT ("now"() + '00:10:00'::interval)
);


ALTER TABLE "public"."slack_oauth_states" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."slack_thread_conversations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slack_workspace_id" "uuid" NOT NULL,
    "slack_channel_id" "text" NOT NULL,
    "slack_thread_ts" "text" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "agent_user_id" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "last_message_at" timestamp with time zone DEFAULT "now"(),
    "metadata" "jsonb" DEFAULT '{}'::"jsonb"
);


ALTER TABLE "public"."slack_thread_conversations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."slack_user_mappings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slack_workspace_id" "uuid" NOT NULL,
    "slack_user_id" "text" NOT NULL,
    "slack_email" "text" NOT NULL,
    "agent_user_id" "text" NOT NULL,
    "linked_at" timestamp with time zone DEFAULT "now"(),
    "last_active_at" timestamp with time zone DEFAULT "now"(),
    "is_active" boolean DEFAULT true,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "organization_id" "uuid"
);


ALTER TABLE "public"."slack_user_mappings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."slack_workspaces" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "team_id" "text" NOT NULL,
    "team_name" "text" NOT NULL,
    "bot_token" "text" NOT NULL,
    "bot_user_id" "text" NOT NULL,
    "access_token" "text" NOT NULL,
    "allowed_domains" "text"[] DEFAULT '{}'::"text"[],
    "installed_at" timestamp with time zone DEFAULT "now"(),
    "installed_by_user_id" "text",
    "is_active" boolean DEFAULT true,
    "settings" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "organization_id" "uuid",
    "slack_app_id" "text"
);


ALTER TABLE "public"."slack_workspaces" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."training_exports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "export_type" character varying NOT NULL,
    "conversation_count" integer NOT NULL,
    "filters_applied" "jsonb",
    "export_path" "text",
    "openai_job_id" "text",
    "model_name" "text",
    "status" character varying DEFAULT 'pending'::character varying NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "completed_at" timestamp with time zone,
    CONSTRAINT "training_exports_export_type_check" CHECK ((("export_type")::"text" = ANY (ARRAY[('fine_tuning'::character varying)::"text", ('knowledge_extraction'::character varying)::"text", ('analytics'::character varying)::"text"]))),
    CONSTRAINT "training_exports_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('pending'::character varying)::"text", ('processing'::character varying)::"text", ('completed'::character varying)::"text", ('failed'::character varying)::"text"])))
);


ALTER TABLE "public"."training_exports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."usage_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "user_id" "text",
    "deal_id" "uuid",
    "event_type" "text" NOT NULL,
    "event_name" "text" NOT NULL,
    "status" "text" DEFAULT 'success'::"text" NOT NULL,
    "provider" "text",
    "model" "text",
    "tokens_in" bigint DEFAULT 0 NOT NULL,
    "tokens_out" bigint DEFAULT 0 NOT NULL,
    "cost_usd" numeric(12,6) DEFAULT 0 NOT NULL,
    "workflow_run_id" "uuid",
    "runtime_ms" bigint,
    "error_code" "text",
    "error_message" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."usage_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."usage_events" IS 'Append-only log of all billable/observable events';



CREATE TABLE IF NOT EXISTS "public"."usage_org_daily" (
    "org_id" "uuid" NOT NULL,
    "date" "date" NOT NULL,
    "total_tasks" bigint DEFAULT 0 NOT NULL,
    "total_workflows" bigint DEFAULT 0 NOT NULL,
    "total_prompts" bigint DEFAULT 0 NOT NULL,
    "total_tokens_in" bigint DEFAULT 0 NOT NULL,
    "total_tokens_out" bigint DEFAULT 0 NOT NULL,
    "total_cost_usd" numeric(12,6) DEFAULT 0 NOT NULL,
    "active_users" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."usage_org_daily" OWNER TO "postgres";


COMMENT ON TABLE "public"."usage_org_daily" IS 'Daily rollup of usage per organization';



CREATE TABLE IF NOT EXISTS "public"."usage_user_daily" (
    "org_id" "uuid" NOT NULL,
    "user_id" "text" NOT NULL,
    "date" "date" NOT NULL,
    "total_tasks" bigint DEFAULT 0 NOT NULL,
    "total_workflows" bigint DEFAULT 0 NOT NULL,
    "total_prompts" bigint DEFAULT 0 NOT NULL,
    "total_tokens_in" bigint DEFAULT 0 NOT NULL,
    "total_tokens_out" bigint DEFAULT 0 NOT NULL,
    "total_cost_usd" numeric(12,6) DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."usage_user_daily" OWNER TO "postgres";


COMMENT ON TABLE "public"."usage_user_daily" IS 'Daily rollup of usage per user per organization';



CREATE TABLE IF NOT EXISTS "public"."user_context" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "communication_style" "text",
    "role_description" "text",
    "custom_context" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "signature_preferences" "jsonb" DEFAULT '{}'::"jsonb",
    "tone_examples" "text"[],
    "writing_style_profile" "jsonb",
    "learned_preferences" "jsonb" DEFAULT '{}'::"jsonb"
);


ALTER TABLE "public"."user_context" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_email_style_examples" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "subject" "text",
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_email_style_examples" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_learnings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "domain" "text" NOT NULL,
    "learning" "text" NOT NULL,
    "source_event_ids" "uuid"[] DEFAULT '{}'::"uuid"[],
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "removed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_learnings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_memories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "organization_id" "uuid",
    "skill_namespace" "text",
    "content" "text" NOT NULL,
    "embedding" "public"."vector"(1536) NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "content_tsv" "tsvector",
    "category" "text"
);


ALTER TABLE "public"."user_memories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_preferences" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "preference_key" character varying NOT NULL,
    "preference_value" "jsonb" NOT NULL,
    "learned_from_conversations" boolean DEFAULT false,
    "confidence_score" double precision,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "user_preferences_confidence_score_check" CHECK ((("confidence_score" >= (0.0)::double precision) AND ("confidence_score" <= (1.0)::double precision)))
);


ALTER TABLE "public"."user_preferences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_roles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "text" NOT NULL,
    "role" "public"."user_role" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "text"
);


ALTER TABLE "public"."user_roles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workflow_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "org_id" "uuid" NOT NULL,
    "user_id" "text",
    "deal_id" "uuid",
    "workflow_kind" "text" NOT NULL,
    "status" "text" DEFAULT 'started'::"text" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ended_at" timestamp with time zone,
    "runtime_ms" bigint,
    "steps_count" integer DEFAULT 0 NOT NULL,
    "escalations_count" integer DEFAULT 0 NOT NULL,
    "llm_calls_count" integer DEFAULT 0 NOT NULL,
    "tokens_in" bigint DEFAULT 0 NOT NULL,
    "tokens_out" bigint DEFAULT 0 NOT NULL,
    "cost_usd" numeric(12,6) DEFAULT 0 NOT NULL,
    "error_code" "text",
    "error_message" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."workflow_runs" OWNER TO "postgres";


COMMENT ON TABLE "public"."workflow_runs" IS 'Lifecycle tracking for multi-step workflows';



CREATE OR REPLACE VIEW "public"."v_org_top_users_30d" WITH ("security_invoker"='true') AS
 WITH "user_workflows" AS (
         SELECT "workflow_runs"."org_id",
            "workflow_runs"."user_id",
            "count"(*) AS "workflows_count",
            "round"(((100.0 * ("count"(*) FILTER (WHERE ("workflow_runs"."escalations_count" = 0)))::numeric) / (NULLIF("count"(*), 0))::numeric), 1) AS "autonomy_rate_user",
            COALESCE("sum"("workflow_runs"."cost_usd"), (0)::numeric) AS "workflow_cost"
           FROM "public"."workflow_runs"
          WHERE (("workflow_runs"."started_at" >= ("now"() - '30 days'::interval)) AND ("workflow_runs"."user_id" IS NOT NULL))
          GROUP BY "workflow_runs"."org_id", "workflow_runs"."user_id"
        ), "user_events" AS (
         SELECT "usage_events"."org_id",
            "usage_events"."user_id",
            "count"(*) FILTER (WHERE ("usage_events"."event_type" = 'task'::"text")) AS "tasks_count",
            "count"(*) FILTER (WHERE ("usage_events"."event_type" = 'prompt'::"text")) AS "prompts_count",
            COALESCE("sum"("usage_events"."cost_usd"), (0)::numeric) AS "events_cost"
           FROM "public"."usage_events"
          WHERE (("usage_events"."created_at" >= ("now"() - '30 days'::interval)) AND ("usage_events"."user_id" IS NOT NULL))
          GROUP BY "usage_events"."org_id", "usage_events"."user_id"
        )
 SELECT COALESCE("w"."org_id", "e"."org_id") AS "org_id",
    COALESCE("w"."user_id", "e"."user_id") AS "user_id",
    COALESCE("w"."workflows_count", (0)::bigint) AS "workflows_count",
    COALESCE("e"."tasks_count", (0)::bigint) AS "tasks_count",
    COALESCE("e"."prompts_count", (0)::bigint) AS "prompts_count",
    COALESCE("w"."autonomy_rate_user", (100)::numeric) AS "autonomy_rate_user",
    (COALESCE("w"."workflow_cost", (0)::numeric) + COALESCE("e"."events_cost", (0)::numeric)) AS "cost_usd"
   FROM ("user_workflows" "w"
     FULL JOIN "user_events" "e" ON ((("w"."org_id" = "e"."org_id") AND ("w"."user_id" = "e"."user_id"))));


ALTER VIEW "public"."v_org_top_users_30d" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_org_workflow_breakdown_30d" WITH ("security_invoker"='true') AS
 SELECT "org_id",
    "workflow_kind",
    "count"(*) AS "runs_count",
    "round"(((100.0 * ("count"(*) FILTER (WHERE ("status" = 'succeeded'::"text")))::numeric) / (NULLIF("count"(*), 0))::numeric), 1) AS "success_rate",
    ("round"("avg"("runtime_ms")))::bigint AS "avg_runtime_ms",
    "round"("avg"("escalations_count"), 2) AS "escalations_per_run",
    "round"("avg"("cost_usd"), 6) AS "cost_per_run"
   FROM "public"."workflow_runs"
  WHERE ("started_at" >= ("now"() - '30 days'::interval))
  GROUP BY "org_id", "workflow_kind";


ALTER VIEW "public"."v_org_workflow_breakdown_30d" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_org_workflow_daily_30d" WITH ("security_invoker"='true') AS
 SELECT ("date_trunc"('day'::"text", "started_at"))::"date" AS "date",
    "org_id",
    "count"(*) AS "workflows_count",
    "count"(*) FILTER (WHERE ("workflow_kind" = 'meeting_prep'::"text")) AS "meetings_prepped",
    "count"(*) FILTER (WHERE ("workflow_kind" = 'deep_research'::"text")) AS "deep_research_runs",
    "round"(((100.0 * ("count"(*) FILTER (WHERE ("escalations_count" = 0)))::numeric) / (NULLIF("count"(*), 0))::numeric), 1) AS "autonomy_rate",
    COALESCE("sum"("cost_usd"), (0)::numeric) AS "cost_usd",
    COALESCE("sum"(("tokens_in" + "tokens_out")), (0)::numeric) AS "tokens_total"
   FROM "public"."workflow_runs"
  WHERE ("started_at" >= ("now"() - '30 days'::interval))
  GROUP BY (("date_trunc"('day'::"text", "started_at"))::"date"), "org_id";


ALTER VIEW "public"."v_org_workflow_daily_30d" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_org_workflow_kpis_30d" WITH ("security_invoker"='true') AS
 SELECT "org_id",
    "count"(*) AS "workflows_count",
    "round"(((100.0 * ("count"(*) FILTER (WHERE ("status" = 'succeeded'::"text")))::numeric) / (NULLIF("count"(*), 0))::numeric), 1) AS "workflow_success_rate",
    ("round"("avg"("runtime_ms")))::bigint AS "avg_workflow_runtime_ms",
    "round"(((100.0 * ("count"(*) FILTER (WHERE ("escalations_count" = 0)))::numeric) / (NULLIF("count"(*), 0))::numeric), 1) AS "autonomy_rate",
    "round"("avg"("escalations_count"), 2) AS "escalations_per_workflow",
    "count"(*) FILTER (WHERE ("workflow_kind" = 'meeting_prep'::"text")) AS "meetings_prepped",
    "count"(*) FILTER (WHERE ("workflow_kind" = 'deep_research'::"text")) AS "deep_research_runs",
    COALESCE("sum"("cost_usd"), (0)::numeric) AS "cost_usd_total",
    COALESCE("sum"(("tokens_in" + "tokens_out")), (0)::numeric) AS "tokens_total"
   FROM "public"."workflow_runs"
  WHERE ("started_at" >= ("now"() - '30 days'::interval))
  GROUP BY "org_id";


ALTER VIEW "public"."v_org_workflow_kpis_30d" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_org_workflow_kpis_7d" WITH ("security_invoker"='true') AS
 SELECT "org_id",
    "count"(*) AS "workflows_count",
    "round"(((100.0 * ("count"(*) FILTER (WHERE ("status" = 'succeeded'::"text")))::numeric) / (NULLIF("count"(*), 0))::numeric), 1) AS "workflow_success_rate",
    ("round"("avg"("runtime_ms")))::bigint AS "avg_workflow_runtime_ms",
    "round"(((100.0 * ("count"(*) FILTER (WHERE ("escalations_count" = 0)))::numeric) / (NULLIF("count"(*), 0))::numeric), 1) AS "autonomy_rate",
    "round"("avg"("escalations_count"), 2) AS "escalations_per_workflow",
    "count"(*) FILTER (WHERE ("workflow_kind" = 'meeting_prep'::"text")) AS "meetings_prepped",
    "count"(*) FILTER (WHERE ("workflow_kind" = 'deep_research'::"text")) AS "deep_research_runs",
    COALESCE("sum"("cost_usd"), (0)::numeric) AS "cost_usd_total",
    COALESCE("sum"(("tokens_in" + "tokens_out")), (0)::numeric) AS "tokens_total"
   FROM "public"."workflow_runs"
  WHERE ("started_at" >= ("now"() - '7 days'::interval))
  GROUP BY "org_id";


ALTER VIEW "public"."v_org_workflow_kpis_7d" OWNER TO "postgres";


ALTER TABLE ONLY "public"."ai_config"
    ADD CONSTRAINT "ai_config_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."ai_models"
    ADD CONSTRAINT "ai_models_model_name_key" UNIQUE ("model_name");



ALTER TABLE ONLY "public"."ai_models"
    ADD CONSTRAINT "ai_models_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."app_secrets"
    ADD CONSTRAINT "app_secrets_pkey" PRIMARY KEY ("name");



ALTER TABLE ONLY "public"."attio_credentials"
    ADD CONSTRAINT "attio_credentials_organization_id_key" UNIQUE ("organization_id");



ALTER TABLE ONLY "public"."attio_credentials"
    ADD CONSTRAINT "attio_credentials_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."attio_oauth_pending"
    ADD CONSTRAINT "attio_oauth_pending_pkey" PRIMARY KEY ("state");



ALTER TABLE ONLY "public"."briefing_log"
    ADD CONSTRAINT "briefing_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calendar_credentials"
    ADD CONSTRAINT "calendar_credentials_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_user_id_google_event_id_key" UNIQUE ("user_id", "google_event_id");



ALTER TABLE ONLY "public"."calendar_sync_log"
    ADD CONSTRAINT "calendar_sync_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calendar_sync_logs"
    ADD CONSTRAINT "calendar_sync_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."chat_messages"
    ADD CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_enrichment"
    ADD CONSTRAINT "contact_enrichment_contact_id_key" UNIQUE ("contact_id");



ALTER TABLE ONLY "public"."contact_enrichment"
    ADD CONSTRAINT "contact_enrichment_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_interactions"
    ADD CONSTRAINT "contact_interactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."context_knowledge"
    ADD CONSTRAINT "context_knowledge_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."conversation_embeddings"
    ADD CONSTRAINT "conversation_embeddings_conversation_id_key" UNIQUE ("conversation_id");



ALTER TABLE ONLY "public"."conversation_embeddings"
    ADD CONSTRAINT "conversation_embeddings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."conversation_feedback"
    ADD CONSTRAINT "conversation_feedback_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."conversation_insights"
    ADD CONSTRAINT "conversation_insights_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agent_email_credentials"
    ADD CONSTRAINT "agent_email_credentials_email_address_key" UNIQUE ("email_address");



ALTER TABLE ONLY "public"."agent_email_credentials"
    ADD CONSTRAINT "agent_email_credentials_organization_id_key" UNIQUE ("organization_id");



ALTER TABLE ONLY "public"."agent_email_credentials"
    ADD CONSTRAINT "agent_email_credentials_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deals"
    ADD CONSTRAINT "deals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."digest_log"
    ADD CONSTRAINT "digest_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."document_chunks"
    ADD CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."document_embeddings"
    ADD CONSTRAINT "document_embeddings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."document_use_cases"
    ADD CONSTRAINT "document_use_cases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_approval_requests"
    ADD CONSTRAINT "email_approval_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_approval_workflow_runs"
    ADD CONSTRAINT "email_approval_workflow_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_auto_response_drafts"
    ADD CONSTRAINT "email_auto_response_drafts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_classifications"
    ADD CONSTRAINT "email_classifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_feedback_events"
    ADD CONSTRAINT "email_feedback_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_scheduled_followups"
    ADD CONSTRAINT "email_scheduled_followups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_thread_conversations"
    ADD CONSTRAINT "email_thread_conversations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."feedback_events"
    ADD CONSTRAINT "feedback_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."gmail_poll_state"
    ADD CONSTRAINT "gmail_poll_state_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."gmail_watch_subscriptions"
    ADD CONSTRAINT "gmail_watch_subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."gmail_watch_subscriptions"
    ADD CONSTRAINT "gmail_watch_subscriptions_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."granola_credentials"
    ADD CONSTRAINT "granola_credentials_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."granola_credentials"
    ADD CONSTRAINT "granola_credentials_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."granola_oauth_pending"
    ADD CONSTRAINT "granola_oauth_pending_pkey" PRIMARY KEY ("state");



ALTER TABLE ONLY "public"."incoming_emails"
    ADD CONSTRAINT "incoming_emails_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."langgraph_workflow_runs"
    ADD CONSTRAINT "langgraph_workflow_runs_pkey" PRIMARY KEY ("id");





ALTER TABLE ONLY "public"."meeting_prep_cache"
    ADD CONSTRAINT "meeting_prep_cache_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."oauth_connections"
    ADD CONSTRAINT "oauth_connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."oauth_states"
    ADD CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."onboarding_progress"
    ADD CONSTRAINT "onboarding_progress_organization_id_key" UNIQUE ("organization_id");



ALTER TABLE ONLY "public"."onboarding_progress"
    ADD CONSTRAINT "onboarding_progress_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."org_context"
    ADD CONSTRAINT "org_context_organization_id_key" UNIQUE ("organization_id");



ALTER TABLE ONLY "public"."org_context"
    ADD CONSTRAINT "org_context_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organization_invites"
    ADD CONSTRAINT "organization_invites_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organization_invites"
    ADD CONSTRAINT "organization_invites_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."organization_slack_settings"
    ADD CONSTRAINT "organization_slack_settings_organization_id_key" UNIQUE ("organization_id");



ALTER TABLE ONLY "public"."organization_slack_settings"
    ADD CONSTRAINT "organization_slack_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organization_users"
    ADD CONSTRAINT "organization_users_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_clerk_id_key" UNIQUE ("clerk_id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."pending_actions"
    ADD CONSTRAINT "pending_actions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."plg_users"
    ADD CONSTRAINT "plg_users_original_user_id_key" UNIQUE ("original_user_id");



ALTER TABLE ONLY "public"."plg_users"
    ADD CONSTRAINT "plg_users_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."processed_meetings"
    ADD CONSTRAINT "processed_meetings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."processed_meetings"
    ADD CONSTRAINT "processed_meetings_user_id_source_external_meeting_id_key" UNIQUE ("user_id", "source", "external_meeting_id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."reminders"
    ADD CONSTRAINT "reminders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."salesforce_credentials"
    ADD CONSTRAINT "salesforce_credentials_organization_id_key" UNIQUE ("organization_id");



ALTER TABLE ONLY "public"."salesforce_credentials"
    ADD CONSTRAINT "salesforce_credentials_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."salesforce_oauth_pending"
    ADD CONSTRAINT "salesforce_oauth_pending_pkey" PRIMARY KEY ("state");



ALTER TABLE ONLY "public"."shareable_documents"
    ADD CONSTRAINT "shareable_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."slack_error_events"
    ADD CONSTRAINT "slack_error_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."slack_message_log"
    ADD CONSTRAINT "slack_message_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."slack_oauth_states"
    ADD CONSTRAINT "slack_oauth_states_pkey" PRIMARY KEY ("state");



ALTER TABLE ONLY "public"."slack_thread_conversations"
    ADD CONSTRAINT "slack_thread_conversations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."slack_thread_conversations"
    ADD CONSTRAINT "slack_thread_conversations_thread_unique" UNIQUE ("slack_workspace_id", "slack_channel_id", "slack_thread_ts");



ALTER TABLE ONLY "public"."slack_user_mappings"
    ADD CONSTRAINT "slack_user_mappings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."slack_user_mappings"
    ADD CONSTRAINT "slack_user_mappings_workspace_user_unique" UNIQUE ("slack_workspace_id", "slack_user_id");



ALTER TABLE ONLY "public"."slack_workspaces"
    ADD CONSTRAINT "slack_workspaces_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."training_exports"
    ADD CONSTRAINT "training_exports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."usage_events"
    ADD CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."usage_org_daily"
    ADD CONSTRAINT "usage_org_daily_pkey" PRIMARY KEY ("org_id", "date");



ALTER TABLE ONLY "public"."usage_user_daily"
    ADD CONSTRAINT "usage_user_daily_pkey" PRIMARY KEY ("org_id", "user_id", "date");



ALTER TABLE ONLY "public"."user_context"
    ADD CONSTRAINT "user_context_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_context"
    ADD CONSTRAINT "user_context_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."user_email_style_examples"
    ADD CONSTRAINT "user_email_style_examples_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_learnings"
    ADD CONSTRAINT "user_learnings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_memories"
    ADD CONSTRAINT "user_memories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_preferences"
    ADD CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workflow_runs"
    ADD CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_attio_credentials_org_id" ON "public"."attio_credentials" USING "btree" ("organization_id");



CREATE INDEX "idx_attio_oauth_pending_expires" ON "public"."attio_oauth_pending" USING "btree" ("expires_at");



CREATE INDEX "idx_briefing_log_user_sent" ON "public"."briefing_log" USING "btree" ("user_id", "sent_at" DESC);



CREATE INDEX "idx_chat_messages_conversation_recent" ON "public"."chat_messages" USING "btree" ("conversation_id", "created_at" DESC);



CREATE INDEX "idx_contact_interactions_org_user" ON "public"."contact_interactions" USING "btree" ("organization_id", "user_id") WHERE ("organization_id" IS NOT NULL);



CREATE INDEX "idx_contacts_org_user" ON "public"."contacts" USING "btree" ("organization_id", "user_id") WHERE ("organization_id" IS NOT NULL);



CREATE UNIQUE INDEX "idx_contacts_user_email" ON "public"."contacts" USING "btree" ("user_id", "email");



CREATE INDEX "idx_conversations_org_user" ON "public"."conversations" USING "btree" ("organization_id", "user_id") WHERE ("organization_id" IS NOT NULL);



CREATE INDEX "idx_digest_log_user_sent" ON "public"."digest_log" USING "btree" ("user_id", "sent_at" DESC);



CREATE INDEX "idx_documents_tags_gin" ON "public"."documents" USING "gin" ("tags");



CREATE INDEX "idx_email_classifications_user_msg" ON "public"."email_classifications" USING "btree" ("user_id", "message_id");



CREATE INDEX "idx_email_feedback_events_user" ON "public"."email_feedback_events" USING "btree" ("user_id");



CREATE INDEX "idx_email_feedback_events_user_created" ON "public"."email_feedback_events" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_email_scheduled_followups_pending" ON "public"."email_scheduled_followups" USING "btree" ("scheduled_for") WHERE ("status" = 'scheduled'::"text");



CREATE INDEX "idx_email_thread_conv_followup" ON "public"."email_thread_conversations" USING "btree" ("next_followup_at") WHERE (("followup_status" = 'scheduled'::"text") AND ("next_followup_at" IS NOT NULL));



CREATE UNIQUE INDEX "idx_email_thread_conv_user_thread" ON "public"."email_thread_conversations" USING "btree" ("user_id", "gmail_thread_id");



CREATE INDEX "idx_feedback_events_org" ON "public"."feedback_events" USING "btree" ("organization_id", "created_at" DESC);



CREATE INDEX "idx_feedback_events_unprocessed" ON "public"."feedback_events" USING "btree" ("user_id") WHERE ("processed" = false);



CREATE INDEX "idx_feedback_events_user_domain" ON "public"."feedback_events" USING "btree" ("user_id", "domain", "created_at" DESC);



CREATE INDEX "idx_granola_credentials_sync_status" ON "public"."granola_credentials" USING "btree" ("sync_status");



CREATE INDEX "idx_granola_credentials_user_id" ON "public"."granola_credentials" USING "btree" ("user_id");



CREATE INDEX "idx_granola_oauth_pending_expires" ON "public"."granola_oauth_pending" USING "btree" ("expires_at");



CREATE INDEX "idx_incoming_emails_priority" ON "public"."incoming_emails" USING "btree" ("user_id", "priority", "triaged_at" DESC) WHERE ("triaged_at" IS NOT NULL);











CREATE INDEX "idx_org_context_org_id" ON "public"."org_context" USING "btree" ("organization_id");



CREATE INDEX "idx_organization_users_user_org" ON "public"."organization_users" USING "btree" ("user_id", "organization_id");



CREATE INDEX "idx_organizations_clerk_id" ON "public"."organizations" USING "btree" ("clerk_id");



CREATE INDEX "idx_pending_actions_org_status" ON "public"."pending_actions" USING "btree" ("organization_id", "status") WHERE ("organization_id" IS NOT NULL);



CREATE INDEX "idx_pending_actions_user_status" ON "public"."pending_actions" USING "btree" ("user_id", "status");



CREATE UNIQUE INDEX "idx_processed_meetings_dedup" ON "public"."processed_meetings" USING "btree" ("user_id", "source", "external_meeting_id");



CREATE INDEX "idx_processed_meetings_user_source" ON "public"."processed_meetings" USING "btree" ("user_id", "source", "created_at" DESC);



CREATE INDEX "idx_reminders_due" ON "public"."reminders" USING "btree" ("status", "trigger_at") WHERE ("status" = 'pending'::"text");



CREATE INDEX "idx_reminders_user_status" ON "public"."reminders" USING "btree" ("user_id", "status");



CREATE INDEX "idx_salesforce_credentials_org_id" ON "public"."salesforce_credentials" USING "btree" ("organization_id");



CREATE INDEX "idx_salesforce_credentials_sync_status" ON "public"."salesforce_credentials" USING "btree" ("sync_status");



CREATE INDEX "idx_salesforce_oauth_pending_expires" ON "public"."salesforce_oauth_pending" USING "btree" ("expires_at");



CREATE INDEX "idx_slack_error_events_category" ON "public"."slack_error_events" USING "btree" ("error_category", "occurred_at" DESC);



CREATE INDEX "idx_slack_error_events_occurred_at" ON "public"."slack_error_events" USING "btree" ("occurred_at" DESC);



CREATE INDEX "idx_slack_error_events_org" ON "public"."slack_error_events" USING "btree" ("organization_id", "occurred_at" DESC);



CREATE INDEX "idx_slack_error_events_run" ON "public"."slack_error_events" USING "btree" ("inngest_run_id");



CREATE INDEX "idx_slack_error_events_unresolved" ON "public"."slack_error_events" USING "btree" ("inngest_run_id") WHERE ("resolved_at" IS NULL);



CREATE INDEX "idx_slack_error_events_user" ON "public"."slack_error_events" USING "btree" ("agent_user_id", "occurred_at" DESC);



CREATE INDEX "idx_slack_thread_conversations_lookup" ON "public"."slack_thread_conversations" USING "btree" ("slack_workspace_id", "slack_channel_id", "slack_thread_ts");



CREATE INDEX "idx_slack_user_mappings_active_lookup" ON "public"."slack_user_mappings" USING "btree" ("slack_user_id", "slack_workspace_id") WHERE ("is_active" = true);



CREATE UNIQUE INDEX "idx_slack_user_mappings_workspace_user" ON "public"."slack_user_mappings" USING "btree" ("slack_workspace_id", "slack_user_id");



CREATE INDEX "idx_slack_workspaces_team_id_active" ON "public"."slack_workspaces" USING "btree" ("team_id") WHERE ("is_active" = true);



CREATE INDEX "idx_usage_events_created" ON "public"."usage_events" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_usage_events_org_created" ON "public"."usage_events" USING "btree" ("org_id", "created_at" DESC);



CREATE INDEX "idx_usage_events_org_type_created" ON "public"."usage_events" USING "btree" ("org_id", "event_type", "created_at" DESC);



CREATE INDEX "idx_usage_events_workflow_run" ON "public"."usage_events" USING "btree" ("workflow_run_id") WHERE ("workflow_run_id" IS NOT NULL);



CREATE INDEX "idx_user_email_style_examples_user" ON "public"."user_email_style_examples" USING "btree" ("user_id");



CREATE INDEX "idx_user_learnings_active" ON "public"."user_learnings" USING "btree" ("user_id", "domain") WHERE ("status" = 'active'::"text");



CREATE INDEX "idx_user_learnings_org" ON "public"."user_learnings" USING "btree" ("organization_id") WHERE ("status" = 'active'::"text");



CREATE INDEX "idx_user_memories_category" ON "public"."user_memories" USING "btree" ("category");



CREATE INDEX "idx_user_memories_content_tsv" ON "public"."user_memories" USING "gin" ("content_tsv");



CREATE INDEX "idx_user_memories_embedding" ON "public"."user_memories" USING "hnsw" ("embedding" "public"."vector_cosine_ops");



CREATE INDEX "idx_user_memories_org_user" ON "public"."user_memories" USING "btree" ("organization_id", "user_id");



CREATE UNIQUE INDEX "idx_user_preferences_user_key" ON "public"."user_preferences" USING "btree" ("user_id", "preference_key");



CREATE INDEX "idx_workflow_runs_org_deal" ON "public"."workflow_runs" USING "btree" ("org_id", "deal_id") WHERE ("deal_id" IS NOT NULL);



CREATE INDEX "idx_workflow_runs_org_kind_started" ON "public"."workflow_runs" USING "btree" ("org_id", "workflow_kind", "started_at" DESC);



CREATE INDEX "idx_workflow_runs_org_started" ON "public"."workflow_runs" USING "btree" ("org_id", "started_at" DESC);



CREATE INDEX "idx_workflow_runs_org_user_started" ON "public"."workflow_runs" USING "btree" ("org_id", "user_id", "started_at" DESC);



CREATE UNIQUE INDEX "slack_workspaces_team_app_unique" ON "public"."slack_workspaces" USING "btree" ("team_id", COALESCE("slack_app_id", 'legacy'::"text"));



CREATE OR REPLACE TRIGGER "trg_update_workflow_run_counters" AFTER INSERT ON "public"."usage_events" FOR EACH ROW WHEN (("new"."workflow_run_id" IS NOT NULL)) EXECUTE FUNCTION "public"."update_workflow_run_counters"();



CREATE OR REPLACE TRIGGER "trg_user_memories_tsv" BEFORE INSERT OR UPDATE OF "content" ON "public"."user_memories" FOR EACH ROW EXECUTE FUNCTION "public"."update_user_memories_tsv"();



CREATE OR REPLACE TRIGGER "update_attio_credentials_updated_at" BEFORE UPDATE ON "public"."attio_credentials" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_granola_credentials_updated_at" BEFORE UPDATE ON "public"."granola_credentials" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_salesforce_credentials_updated_at" BEFORE UPDATE ON "public"."salesforce_credentials" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



ALTER TABLE ONLY "public"."ai_models"
    ADD CONSTRAINT "ai_models_training_export_id_fkey" FOREIGN KEY ("training_export_id") REFERENCES "public"."training_exports"("id");



ALTER TABLE ONLY "public"."calendar_credentials"
    ADD CONSTRAINT "calendar_credentials_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."calendar_sync_logs"
    ADD CONSTRAINT "calendar_sync_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."chat_messages"
    ADD CONSTRAINT "chat_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id");



ALTER TABLE ONLY "public"."contact_enrichment"
    ADD CONSTRAINT "contact_enrichment_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id");



ALTER TABLE ONLY "public"."contact_interactions"
    ADD CONSTRAINT "contact_interactions_calendar_event_id_fkey" FOREIGN KEY ("calendar_event_id") REFERENCES "public"."calendar_events"("id");



ALTER TABLE ONLY "public"."contact_interactions"
    ADD CONSTRAINT "contact_interactions_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id");



ALTER TABLE ONLY "public"."contact_interactions"
    ADD CONSTRAINT "contact_interactions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."context_knowledge"
    ADD CONSTRAINT "context_knowledge_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."context_knowledge"
    ADD CONSTRAINT "context_knowledge_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id");



ALTER TABLE ONLY "public"."conversation_embeddings"
    ADD CONSTRAINT "conversation_embeddings_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id");



ALTER TABLE ONLY "public"."conversation_feedback"
    ADD CONSTRAINT "conversation_feedback_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id");



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_anonymized_version_id_fkey" FOREIGN KEY ("anonymized_version_id") REFERENCES "public"."conversations"("id");



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."agent_email_credentials"
    ADD CONSTRAINT "agent_email_credentials_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."deals"
    ADD CONSTRAINT "deals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."document_chunks"
    ADD CONSTRAINT "document_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id");



ALTER TABLE ONLY "public"."document_chunks"
    ADD CONSTRAINT "document_chunks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."document_embeddings"
    ADD CONSTRAINT "document_embeddings_chunk_id_fkey" FOREIGN KEY ("chunk_id") REFERENCES "public"."document_chunks"("id");



ALTER TABLE ONLY "public"."document_embeddings"
    ADD CONSTRAINT "document_embeddings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."document_use_cases"
    ADD CONSTRAINT "document_use_cases_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id");



ALTER TABLE ONLY "public"."document_use_cases"
    ADD CONSTRAINT "document_use_cases_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."email_approval_requests"
    ADD CONSTRAINT "email_approval_requests_slack_workspace_id_fkey" FOREIGN KEY ("slack_workspace_id") REFERENCES "public"."slack_workspaces"("id");



ALTER TABLE ONLY "public"."email_approval_workflow_runs"
    ADD CONSTRAINT "email_approval_workflow_runs_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "public"."email_approval_requests"("id");



ALTER TABLE ONLY "public"."email_auto_response_drafts"
    ADD CONSTRAINT "email_auto_response_drafts_incoming_email_id_fkey" FOREIGN KEY ("incoming_email_id") REFERENCES "public"."incoming_emails"("id");



ALTER TABLE ONLY "public"."email_auto_response_drafts"
    ADD CONSTRAINT "email_auto_response_drafts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."email_auto_response_drafts"
    ADD CONSTRAINT "email_auto_response_drafts_slack_workspace_id_fkey" FOREIGN KEY ("slack_workspace_id") REFERENCES "public"."slack_workspaces"("id");



ALTER TABLE ONLY "public"."email_auto_response_drafts"
    ADD CONSTRAINT "email_auto_response_drafts_thread_conversation_id_fkey" FOREIGN KEY ("thread_conversation_id") REFERENCES "public"."email_thread_conversations"("id");



ALTER TABLE ONLY "public"."email_classifications"
    ADD CONSTRAINT "email_classifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."email_feedback_events"
    ADD CONSTRAINT "email_feedback_events_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "public"."email_auto_response_drafts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."email_scheduled_followups"
    ADD CONSTRAINT "email_scheduled_followups_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."email_scheduled_followups"
    ADD CONSTRAINT "email_scheduled_followups_thread_conversation_id_fkey" FOREIGN KEY ("thread_conversation_id") REFERENCES "public"."email_thread_conversations"("id");



ALTER TABLE ONLY "public"."email_thread_conversations"
    ADD CONSTRAINT "email_thread_conversations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id");



ALTER TABLE ONLY "public"."email_thread_conversations"
    ADD CONSTRAINT "email_thread_conversations_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id");



ALTER TABLE ONLY "public"."email_thread_conversations"
    ADD CONSTRAINT "email_thread_conversations_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."feedback_events"
    ADD CONSTRAINT "feedback_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."incoming_emails"
    ADD CONSTRAINT "incoming_emails_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."langgraph_workflow_runs"
    ADD CONSTRAINT "langgraph_workflow_runs_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id");









ALTER TABLE ONLY "public"."meeting_prep_cache"
    ADD CONSTRAINT "meeting_prep_cache_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id");



ALTER TABLE ONLY "public"."meeting_prep_cache"
    ADD CONSTRAINT "meeting_prep_cache_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."meeting_prep_cache"
    ADD CONSTRAINT "meeting_prep_cache_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."langgraph_workflow_runs"("id");



ALTER TABLE ONLY "public"."oauth_connections"
    ADD CONSTRAINT "oauth_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."oauth_states"
    ADD CONSTRAINT "oauth_states_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."onboarding_progress"
    ADD CONSTRAINT "onboarding_progress_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."org_context"
    ADD CONSTRAINT "org_context_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organization_invites"
    ADD CONSTRAINT "organization_invites_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."organization_slack_settings"
    ADD CONSTRAINT "organization_slack_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."organization_slack_settings"
    ADD CONSTRAINT "organization_slack_settings_slack_workspace_id_fkey" FOREIGN KEY ("slack_workspace_id") REFERENCES "public"."slack_workspaces"("id");



ALTER TABLE ONLY "public"."organization_users"
    ADD CONSTRAINT "organization_users_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."processed_meetings"
    ADD CONSTRAINT "processed_meetings_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id");



ALTER TABLE ONLY "public"."salesforce_credentials"
    ADD CONSTRAINT "salesforce_credentials_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."shareable_documents"
    ADD CONSTRAINT "shareable_documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."slack_error_events"
    ADD CONSTRAINT "slack_error_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."slack_message_log"
    ADD CONSTRAINT "slack_message_log_agent_response_id_fkey" FOREIGN KEY ("agent_response_id") REFERENCES "public"."chat_messages"("id");



ALTER TABLE ONLY "public"."slack_message_log"
    ADD CONSTRAINT "slack_message_log_slack_workspace_id_fkey" FOREIGN KEY ("slack_workspace_id") REFERENCES "public"."slack_workspaces"("id");



ALTER TABLE ONLY "public"."slack_oauth_states"
    ADD CONSTRAINT "slack_oauth_states_slack_workspace_id_fkey" FOREIGN KEY ("slack_workspace_id") REFERENCES "public"."slack_workspaces"("id");



ALTER TABLE ONLY "public"."slack_thread_conversations"
    ADD CONSTRAINT "slack_thread_conversations_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id");



ALTER TABLE ONLY "public"."slack_thread_conversations"
    ADD CONSTRAINT "slack_thread_conversations_slack_workspace_id_fkey" FOREIGN KEY ("slack_workspace_id") REFERENCES "public"."slack_workspaces"("id");



ALTER TABLE ONLY "public"."slack_user_mappings"
    ADD CONSTRAINT "slack_user_mappings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."slack_user_mappings"
    ADD CONSTRAINT "slack_user_mappings_slack_workspace_id_fkey" FOREIGN KEY ("slack_workspace_id") REFERENCES "public"."slack_workspaces"("id");



ALTER TABLE ONLY "public"."slack_workspaces"
    ADD CONSTRAINT "slack_workspaces_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."user_learnings"
    ADD CONSTRAINT "user_learnings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_memories"
    ADD CONSTRAINT "user_memories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



CREATE POLICY "Authenticated users can insert oauth_states" ON "public"."oauth_states" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = (("current_setting"('request.jwt.claims'::"text", true))::json ->> 'sub'::"text")));



CREATE POLICY "Members can view their organizations" ON "public"."organizations" FOR SELECT TO "authenticated" USING ("public"."is_org_member"("id"));



CREATE POLICY "Org admins can delete attio credentials" ON "public"."attio_credentials" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."organization_users" "ou"
  WHERE (("ou"."organization_id" = "attio_credentials"."organization_id") AND ("ou"."user_id" = ("auth"."jwt"() ->> 'sub'::"text")) AND ("ou"."role" = ANY (ARRAY['admin'::"text", 'owner'::"text"]))))));



CREATE POLICY "Org admins can delete salesforce credentials" ON "public"."salesforce_credentials" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."organization_users" "ou"
  WHERE (("ou"."organization_id" = "salesforce_credentials"."organization_id") AND ("ou"."user_id" = ("auth"."jwt"() ->> 'sub'::"text")) AND ("ou"."role" = ANY (ARRAY['admin'::"text", 'owner'::"text"]))))));



CREATE POLICY "Org admins can insert attio credentials" ON "public"."attio_credentials" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."organization_users" "ou"
  WHERE (("ou"."organization_id" = "attio_credentials"."organization_id") AND ("ou"."user_id" = ("auth"."jwt"() ->> 'sub'::"text")) AND ("ou"."role" = ANY (ARRAY['admin'::"text", 'owner'::"text"]))))));



CREATE POLICY "Org admins can insert salesforce credentials" ON "public"."salesforce_credentials" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."organization_users" "ou"
  WHERE (("ou"."organization_id" = "salesforce_credentials"."organization_id") AND ("ou"."user_id" = ("auth"."jwt"() ->> 'sub'::"text")) AND ("ou"."role" = ANY (ARRAY['admin'::"text", 'owner'::"text"]))))));



CREATE POLICY "Org admins can update attio credentials" ON "public"."attio_credentials" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."organization_users" "ou"
  WHERE (("ou"."organization_id" = "attio_credentials"."organization_id") AND ("ou"."user_id" = ("auth"."jwt"() ->> 'sub'::"text")) AND ("ou"."role" = ANY (ARRAY['admin'::"text", 'owner'::"text"]))))));



CREATE POLICY "Org admins can update salesforce credentials" ON "public"."salesforce_credentials" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."organization_users" "ou"
  WHERE (("ou"."organization_id" = "salesforce_credentials"."organization_id") AND ("ou"."user_id" = ("auth"."jwt"() ->> 'sub'::"text")) AND ("ou"."role" = ANY (ARRAY['admin'::"text", 'owner'::"text"]))))));



CREATE POLICY "Org members can delete context_knowledge" ON "public"."context_knowledge" FOR DELETE TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can delete agent_email_credentials" ON "public"."agent_email_credentials" FOR DELETE TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can delete document_chunks" ON "public"."document_chunks" FOR DELETE TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can delete document_embeddings" ON "public"."document_embeddings" FOR DELETE TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can delete document_use_cases" ON "public"."document_use_cases" FOR DELETE TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can delete documents" ON "public"."documents" FOR DELETE TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can delete organization_invites" ON "public"."organization_invites" FOR DELETE TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can delete organization_users" ON "public"."organization_users" FOR DELETE TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can delete shareable_documents" ON "public"."shareable_documents" FOR DELETE TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can insert context_knowledge" ON "public"."context_knowledge" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can insert agent_email_credentials" ON "public"."agent_email_credentials" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can insert document_chunks" ON "public"."document_chunks" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can insert document_embeddings" ON "public"."document_embeddings" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can insert document_use_cases" ON "public"."document_use_cases" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can insert documents" ON "public"."documents" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_org_member"("organization_id"));





CREATE POLICY "Org members can insert oauth_connections" ON "public"."oauth_connections" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can insert organization_invites" ON "public"."organization_invites" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can insert organization_users" ON "public"."organization_users" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can insert shareable_documents" ON "public"."shareable_documents" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can read org daily rollups" ON "public"."usage_org_daily" FOR SELECT USING ("public"."is_org_member"("org_id"));



CREATE POLICY "Org members can read usage events" ON "public"."usage_events" FOR SELECT USING ("public"."is_org_member"("org_id"));



CREATE POLICY "Org members can read user daily rollups" ON "public"."usage_user_daily" FOR SELECT USING ("public"."is_org_member"("org_id"));



CREATE POLICY "Org members can read workflow runs" ON "public"."workflow_runs" FOR SELECT USING ("public"."is_org_member"("org_id"));



CREATE POLICY "Org members can select context_knowledge" ON "public"."context_knowledge" FOR SELECT TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can select agent_email_credentials" ON "public"."agent_email_credentials" FOR SELECT TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can select document_chunks" ON "public"."document_chunks" FOR SELECT TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can select document_embeddings" ON "public"."document_embeddings" FOR SELECT TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can select document_use_cases" ON "public"."document_use_cases" FOR SELECT TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can select documents" ON "public"."documents" FOR SELECT TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can select oauth_connections" ON "public"."oauth_connections" FOR SELECT TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can select onboarding_progress" ON "public"."onboarding_progress" FOR SELECT TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can select organization_invites" ON "public"."organization_invites" FOR SELECT TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can select organization_users" ON "public"."organization_users" FOR SELECT TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can select shareable_documents" ON "public"."shareable_documents" FOR SELECT TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can select slack_user_mappings" ON "public"."slack_user_mappings" FOR SELECT TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can select slack_workspaces" ON "public"."slack_workspaces" FOR SELECT TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can update context_knowledge" ON "public"."context_knowledge" FOR UPDATE TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can update agent_email_credentials" ON "public"."agent_email_credentials" FOR UPDATE TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can update document_use_cases" ON "public"."document_use_cases" FOR UPDATE TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can update documents" ON "public"."documents" FOR UPDATE TO "authenticated" USING ("public"."is_org_member"("organization_id"));





CREATE POLICY "Org members can update oauth_connections" ON "public"."oauth_connections" FOR UPDATE TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can update onboarding_progress" ON "public"."onboarding_progress" FOR UPDATE TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can update organization_invites" ON "public"."organization_invites" FOR UPDATE TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can update organization_users" ON "public"."organization_users" FOR UPDATE TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can update shareable_documents" ON "public"."shareable_documents" FOR UPDATE TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can update slack_workspaces" ON "public"."slack_workspaces" FOR UPDATE TO "authenticated" USING ("public"."is_org_member"("organization_id"));



CREATE POLICY "Org members can view attio credentials" ON "public"."attio_credentials" FOR SELECT USING (("organization_id" IN ( SELECT "ou"."organization_id"
   FROM "public"."organization_users" "ou"
  WHERE ("ou"."user_id" = ("auth"."jwt"() ->> 'sub'::"text")))));





CREATE POLICY "Org members can view salesforce credentials" ON "public"."salesforce_credentials" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."organization_users" "ou"
  WHERE (("ou"."organization_id" = "salesforce_credentials"."organization_id") AND ("ou"."user_id" = ("auth"."jwt"() ->> 'sub'::"text"))))));



CREATE POLICY "Service role full access on email_classifications" ON "public"."email_classifications" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role full access on email_scheduled_followups" ON "public"."email_scheduled_followups" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role full access on email_thread_conversations" ON "public"."email_thread_conversations" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role full access on org_context" ON "public"."org_context" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role full access on organization_slack_settings" ON "public"."organization_slack_settings" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role full access on processed_meetings" ON "public"."processed_meetings" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "Service role full access to attio_oauth_pending" ON "public"."attio_oauth_pending" USING (("current_setting"('role'::"text", true) = 'service_role'::"text"));



CREATE POLICY "Service role full access to briefing_log" ON "public"."briefing_log" USING (("current_setting"('role'::"text", true) = 'service_role'::"text"));



CREATE POLICY "Service role full access to digest_log" ON "public"."digest_log" USING (("current_setting"('role'::"text", true) = 'service_role'::"text"));



CREATE POLICY "Service role full access to granola_oauth_pending" ON "public"."granola_oauth_pending" USING (("current_setting"('role'::"text", true) = 'service_role'::"text"));





CREATE POLICY "Service role full access to reminders" ON "public"."reminders" USING (("current_setting"('role'::"text", true) = 'service_role'::"text"));



CREATE POLICY "Users can delete own calendar_credentials" ON "public"."calendar_credentials" FOR DELETE TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can delete own calendar_events" ON "public"."calendar_events" FOR DELETE TO "authenticated" USING ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can delete own chat_messages" ON "public"."chat_messages" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."conversations"
  WHERE (("conversations"."id" = "chat_messages"."conversation_id") AND ("conversations"."user_id" = "public"."current_user_id"())))));



CREATE POLICY "Users can delete own contact_enrichment" ON "public"."contact_enrichment" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."contacts"
  WHERE (("contacts"."id" = "contact_enrichment"."contact_id") AND ("contacts"."user_id" = "public"."current_user_id"())))));



CREATE POLICY "Users can delete own contact_interactions" ON "public"."contact_interactions" FOR DELETE TO "authenticated" USING ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can delete own contacts" ON "public"."contacts" FOR DELETE TO "authenticated" USING ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can delete own conversation_embeddings" ON "public"."conversation_embeddings" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."conversations"
  WHERE (("conversations"."id" = "conversation_embeddings"."conversation_id") AND ("conversations"."user_id" = "public"."current_user_id"())))));



CREATE POLICY "Users can delete own conversations" ON "public"."conversations" FOR DELETE TO "authenticated" USING ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can delete own deals" ON "public"."deals" FOR DELETE TO "authenticated" USING ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can delete own gmail_watch_subscriptions" ON "public"."gmail_watch_subscriptions" FOR DELETE TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can delete own granola credentials" ON "public"."granola_credentials" FOR DELETE USING ((("auth"."jwt"() ->> 'sub'::"text") = "user_id"));



CREATE POLICY "Users can delete own user_context" ON "public"."user_context" FOR DELETE TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can delete own user_email_style_examples" ON "public"."user_email_style_examples" FOR DELETE TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can delete own user_preferences" ON "public"."user_preferences" FOR DELETE TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can insert own calendar_credentials" ON "public"."calendar_credentials" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can insert own calendar_events" ON "public"."calendar_events" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can insert own calendar_sync_logs" ON "public"."calendar_sync_logs" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can insert own chat_messages" ON "public"."chat_messages" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."conversations"
  WHERE (("conversations"."id" = "chat_messages"."conversation_id") AND ("conversations"."user_id" = "public"."current_user_id"())))));



CREATE POLICY "Users can insert own contact_enrichment" ON "public"."contact_enrichment" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."contacts"
  WHERE (("contacts"."id" = "contact_enrichment"."contact_id") AND ("contacts"."user_id" = "public"."current_user_id"())))));



CREATE POLICY "Users can insert own contact_interactions" ON "public"."contact_interactions" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can insert own contacts" ON "public"."contacts" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can insert own conversation_embeddings" ON "public"."conversation_embeddings" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."conversations"
  WHERE (("conversations"."id" = "conversation_embeddings"."conversation_id") AND ("conversations"."user_id" = "public"."current_user_id"())))));



CREATE POLICY "Users can insert own conversation_feedback" ON "public"."conversation_feedback" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can insert own conversations" ON "public"."conversations" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can insert own deals" ON "public"."deals" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can insert own email_approval_requests" ON "public"."email_approval_requests" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can insert own email_approval_workflow_runs" ON "public"."email_approval_workflow_runs" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can insert own email_auto_response_drafts" ON "public"."email_auto_response_drafts" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can insert own gmail_poll_state" ON "public"."gmail_poll_state" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can insert own gmail_watch_subscriptions" ON "public"."gmail_watch_subscriptions" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can insert own granola credentials" ON "public"."granola_credentials" FOR INSERT WITH CHECK ((("auth"."jwt"() ->> 'sub'::"text") = "user_id"));



CREATE POLICY "Users can insert own incoming_emails" ON "public"."incoming_emails" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can insert own langgraph_workflow_runs" ON "public"."langgraph_workflow_runs" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can insert own meeting_prep_cache" ON "public"."meeting_prep_cache" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can insert own notifications" ON "public"."notifications" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can insert own profile" ON "public"."profiles" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can insert own user_context" ON "public"."user_context" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can insert own user_email_style_examples" ON "public"."user_email_style_examples" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can insert own user_preferences" ON "public"."user_preferences" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can insert their own briefing log" ON "public"."briefing_log" FOR INSERT WITH CHECK (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can select own calendar_credentials" ON "public"."calendar_credentials" FOR SELECT TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can select own calendar_events" ON "public"."calendar_events" FOR SELECT TO "authenticated" USING ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can select own calendar_sync_logs" ON "public"."calendar_sync_logs" FOR SELECT TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can select own chat_messages" ON "public"."chat_messages" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."conversations"
  WHERE (("conversations"."id" = "chat_messages"."conversation_id") AND ("conversations"."user_id" = "public"."current_user_id"())))));



CREATE POLICY "Users can select own contact_enrichment" ON "public"."contact_enrichment" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."contacts"
  WHERE (("contacts"."id" = "contact_enrichment"."contact_id") AND ("contacts"."user_id" = "public"."current_user_id"())))));



CREATE POLICY "Users can select own contact_interactions" ON "public"."contact_interactions" FOR SELECT TO "authenticated" USING ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can select own contacts" ON "public"."contacts" FOR SELECT TO "authenticated" USING ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can select own conversation_embeddings" ON "public"."conversation_embeddings" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."conversations"
  WHERE (("conversations"."id" = "conversation_embeddings"."conversation_id") AND ("conversations"."user_id" = "public"."current_user_id"())))));



CREATE POLICY "Users can select own conversation_feedback" ON "public"."conversation_feedback" FOR SELECT TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can select own conversations" ON "public"."conversations" FOR SELECT TO "authenticated" USING ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can select own deals" ON "public"."deals" FOR SELECT TO "authenticated" USING ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can select own email_approval_requests" ON "public"."email_approval_requests" FOR SELECT TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can select own email_approval_workflow_runs" ON "public"."email_approval_workflow_runs" FOR SELECT TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can select own email_auto_response_drafts" ON "public"."email_auto_response_drafts" FOR SELECT TO "authenticated" USING ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can select own email_feedback_events" ON "public"."email_feedback_events" FOR SELECT TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can select own gmail_poll_state" ON "public"."gmail_poll_state" FOR SELECT TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can select own gmail_watch_subscriptions" ON "public"."gmail_watch_subscriptions" FOR SELECT TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can select own incoming_emails" ON "public"."incoming_emails" FOR SELECT TO "authenticated" USING ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can select own langgraph_workflow_runs" ON "public"."langgraph_workflow_runs" FOR SELECT TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can select own meeting_prep_cache" ON "public"."meeting_prep_cache" FOR SELECT TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can select own notifications" ON "public"."notifications" FOR SELECT TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can select own profile" ON "public"."profiles" FOR SELECT TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can select own user_context" ON "public"."user_context" FOR SELECT TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can select own user_email_style_examples" ON "public"."user_email_style_examples" FOR SELECT TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can select own user_preferences" ON "public"."user_preferences" FOR SELECT TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can select own user_roles" ON "public"."user_roles" FOR SELECT TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can update own calendar_credentials" ON "public"."calendar_credentials" FOR UPDATE TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can update own calendar_events" ON "public"."calendar_events" FOR UPDATE TO "authenticated" USING ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can update own chat_messages" ON "public"."chat_messages" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."conversations"
  WHERE (("conversations"."id" = "chat_messages"."conversation_id") AND ("conversations"."user_id" = "public"."current_user_id"())))));



CREATE POLICY "Users can update own contact_enrichment" ON "public"."contact_enrichment" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."contacts"
  WHERE (("contacts"."id" = "contact_enrichment"."contact_id") AND ("contacts"."user_id" = "public"."current_user_id"())))));



CREATE POLICY "Users can update own contact_interactions" ON "public"."contact_interactions" FOR UPDATE TO "authenticated" USING ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can update own contacts" ON "public"."contacts" FOR UPDATE TO "authenticated" USING ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can update own conversation_embeddings" ON "public"."conversation_embeddings" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."conversations"
  WHERE (("conversations"."id" = "conversation_embeddings"."conversation_id") AND ("conversations"."user_id" = "public"."current_user_id"())))));



CREATE POLICY "Users can update own conversations" ON "public"."conversations" FOR UPDATE TO "authenticated" USING ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can update own deals" ON "public"."deals" FOR UPDATE TO "authenticated" USING ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can update own email_approval_requests" ON "public"."email_approval_requests" FOR UPDATE TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can update own email_approval_workflow_runs" ON "public"."email_approval_workflow_runs" FOR UPDATE TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can update own email_auto_response_drafts" ON "public"."email_auto_response_drafts" FOR UPDATE TO "authenticated" USING ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can update own gmail_poll_state" ON "public"."gmail_poll_state" FOR UPDATE TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can update own gmail_watch_subscriptions" ON "public"."gmail_watch_subscriptions" FOR UPDATE TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can update own granola credentials" ON "public"."granola_credentials" FOR UPDATE USING ((("auth"."jwt"() ->> 'sub'::"text") = "user_id"));



CREATE POLICY "Users can update own incoming_emails" ON "public"."incoming_emails" FOR UPDATE TO "authenticated" USING ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR "public"."is_org_member"("organization_id"))));



CREATE POLICY "Users can update own langgraph_workflow_runs" ON "public"."langgraph_workflow_runs" FOR UPDATE TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can update own meeting_prep_cache" ON "public"."meeting_prep_cache" FOR UPDATE TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can update own notifications" ON "public"."notifications" FOR UPDATE TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can update own profile" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can update own user_context" ON "public"."user_context" FOR UPDATE TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can update own user_email_style_examples" ON "public"."user_email_style_examples" FOR UPDATE TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can update own user_preferences" ON "public"."user_preferences" FOR UPDATE TO "authenticated" USING (("user_id" = "public"."current_user_id"()));



CREATE POLICY "Users can view own granola credentials" ON "public"."granola_credentials" FOR SELECT USING ((("auth"."jwt"() ->> 'sub'::"text") = "user_id"));



CREATE POLICY "Users can view own processed meetings" ON "public"."processed_meetings" FOR SELECT USING (("user_id" = ("auth"."jwt"() ->> 'sub'::"text")));



CREATE POLICY "Users can view own reminders" ON "public"."reminders" FOR SELECT USING (("user_id" = (("current_setting"('request.jwt.claims'::"text", true))::json ->> 'sub'::"text")));



CREATE POLICY "Users can view their own briefing log" ON "public"."briefing_log" FOR SELECT USING (("user_id" = "public"."current_user_id"()));



ALTER TABLE "public"."ai_config" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_models" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."app_secrets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."attio_credentials" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."attio_oauth_pending" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."briefing_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."calendar_credentials" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."calendar_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."calendar_sync_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."calendar_sync_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."chat_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contact_enrichment" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contact_interactions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contacts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."context_knowledge" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."conversation_embeddings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."conversation_feedback" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."conversation_insights" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."conversations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agent_email_credentials" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."digest_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."document_chunks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."document_embeddings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."document_use_cases" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."documents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."email_approval_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."email_approval_workflow_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."email_auto_response_drafts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."email_classifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."email_feedback_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."email_scheduled_followups" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."email_thread_conversations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."feedback_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "feedback_events_service_only" ON "public"."feedback_events" USING (("current_setting"('role'::"text", true) = 'service_role'::"text"));



ALTER TABLE "public"."gmail_poll_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."gmail_watch_subscriptions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."granola_credentials" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."granola_oauth_pending" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."incoming_emails" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."langgraph_workflow_runs" ENABLE ROW LEVEL SECURITY;



ALTER TABLE "public"."meeting_prep_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."oauth_connections" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."oauth_states" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."onboarding_progress" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."org_context" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."organization_invites" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."organization_slack_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."organization_users" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."organizations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pending_actions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."plg_users" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."processed_meetings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reminders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."salesforce_credentials" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."salesforce_oauth_pending" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."shareable_documents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."slack_error_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "slack_error_events_service_only" ON "public"."slack_error_events" USING (("current_setting"('role'::"text", true) = 'service_role'::"text"));



ALTER TABLE "public"."slack_message_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."slack_oauth_states" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."slack_thread_conversations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."slack_user_mappings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."slack_workspaces" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."training_exports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."usage_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."usage_org_daily" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."usage_user_daily" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_context" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_email_style_examples" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_learnings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_learnings_service_only" ON "public"."user_learnings" USING (("current_setting"('role'::"text", true) = 'service_role'::"text"));



ALTER TABLE "public"."user_memories" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_memories_insert" ON "public"."user_memories" FOR INSERT WITH CHECK ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR ("organization_id" IN ( SELECT "ou"."organization_id"
   FROM "public"."organization_users" "ou"
  WHERE ("ou"."user_id" = "public"."current_user_id"()))))));



CREATE POLICY "user_memories_select" ON "public"."user_memories" FOR SELECT USING ((("user_id" = "public"."current_user_id"()) AND (("organization_id" IS NULL) OR ("organization_id" IN ( SELECT "ou"."organization_id"
   FROM "public"."organization_users" "ou"
  WHERE ("ou"."user_id" = "public"."current_user_id"()))))));



CREATE POLICY "user_memories_service" ON "public"."user_memories" USING (("current_setting"('role'::"text", true) = 'service_role'::"text"));



ALTER TABLE "public"."user_preferences" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_roles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."workflow_runs" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."_get_encryption_key"() TO "anon";
GRANT ALL ON FUNCTION "public"."_get_encryption_key"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."_get_encryption_key"() TO "service_role";



GRANT ALL ON FUNCTION "public"."backfill_usage_rollups"("p_start" "date", "p_end" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."backfill_usage_rollups"("p_start" "date", "p_end" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."backfill_usage_rollups"("p_start" "date", "p_end" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."current_org_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."current_org_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_org_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."current_user_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."current_user_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_user_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."decrypt_slack_token"("encrypted_token" "text", "encryption_key" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."decrypt_slack_token"("encrypted_token" "text", "encryption_key" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."decrypt_slack_token"("encrypted_token" "text", "encryption_key" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."decrypt_token"("encrypted_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."decrypt_token"("encrypted_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."decrypt_token"("encrypted_token" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."decrypt_token"("encrypted_access" "text", "encrypted_refresh" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."decrypt_token"("encrypted_access" "text", "encrypted_refresh" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."decrypt_token"("encrypted_access" "text", "encrypted_refresh" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_user_data"("p_user_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_user_data"("p_user_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."encrypt_slack_token"("token" "text", "encryption_key" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."encrypt_slack_token"("token" "text", "encryption_key" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."encrypt_slack_token"("token" "text", "encryption_key" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."encrypt_token"("token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."encrypt_token"("token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."encrypt_token"("token" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."encrypt_token"("access_token" "text", "refresh_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."encrypt_token"("access_token" "text", "refresh_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."encrypt_token"("access_token" "text", "refresh_token" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."hybrid_search_user_memories"("query_embedding" "public"."vector", "query_text" "text", "p_user_id" "text", "p_organization_id" "uuid", "p_skill_namespace" "text", "p_category" "text", "match_threshold" double precision, "match_count" integer, "alpha" double precision) TO "anon";
GRANT ALL ON FUNCTION "public"."hybrid_search_user_memories"("query_embedding" "public"."vector", "query_text" "text", "p_user_id" "text", "p_organization_id" "uuid", "p_skill_namespace" "text", "p_category" "text", "match_threshold" double precision, "match_count" integer, "alpha" double precision) TO "authenticated";
GRANT ALL ON FUNCTION "public"."hybrid_search_user_memories"("query_embedding" "public"."vector", "query_text" "text", "p_user_id" "text", "p_organization_id" "uuid", "p_skill_namespace" "text", "p_category" "text", "match_threshold" double precision, "match_count" integer, "alpha" double precision) TO "service_role";



GRANT ALL ON FUNCTION "public"."is_org_member"("check_org_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_org_member"("check_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_org_member"("check_org_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "anon";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "service_role";



GRANT ALL ON FUNCTION "public"."save_memory_if_unique"("p_user_id" "text", "p_organization_id" "uuid", "p_skill_namespace" "text", "p_content" "text", "p_embedding" "public"."vector", "p_dedup_threshold" double precision) TO "anon";
GRANT ALL ON FUNCTION "public"."save_memory_if_unique"("p_user_id" "text", "p_organization_id" "uuid", "p_skill_namespace" "text", "p_content" "text", "p_embedding" "public"."vector", "p_dedup_threshold" double precision) TO "authenticated";
GRANT ALL ON FUNCTION "public"."save_memory_if_unique"("p_user_id" "text", "p_organization_id" "uuid", "p_skill_namespace" "text", "p_content" "text", "p_embedding" "public"."vector", "p_dedup_threshold" double precision) TO "service_role";



GRANT ALL ON FUNCTION "public"."save_memory_if_unique"("p_user_id" "text", "p_organization_id" "uuid", "p_skill_namespace" "text", "p_content" "text", "p_embedding" "public"."vector", "p_dedup_threshold" double precision, "p_metadata" "jsonb", "p_category" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."save_memory_if_unique"("p_user_id" "text", "p_organization_id" "uuid", "p_skill_namespace" "text", "p_content" "text", "p_embedding" "public"."vector", "p_dedup_threshold" double precision, "p_metadata" "jsonb", "p_category" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."save_memory_if_unique"("p_user_id" "text", "p_organization_id" "uuid", "p_skill_namespace" "text", "p_content" "text", "p_embedding" "public"."vector", "p_dedup_threshold" double precision, "p_metadata" "jsonb", "p_category" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."search_context_knowledge"("query_embedding" "public"."vector", "organization_id_filter" "uuid", "match_threshold" double precision, "match_count" integer, "category_filter" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."search_context_knowledge"("query_embedding" "public"."vector", "organization_id_filter" "uuid", "match_threshold" double precision, "match_count" integer, "category_filter" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_context_knowledge"("query_embedding" "public"."vector", "organization_id_filter" "uuid", "match_threshold" double precision, "match_count" integer, "category_filter" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."search_documents"("query_embedding" "public"."vector", "organization_id_filter" "uuid", "match_threshold" double precision, "match_count" integer, "category_filter" "text", "tag_filter" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."search_documents"("query_embedding" "public"."vector", "organization_id_filter" "uuid", "match_threshold" double precision, "match_count" integer, "category_filter" "text", "tag_filter" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_documents"("query_embedding" "public"."vector", "organization_id_filter" "uuid", "match_threshold" double precision, "match_count" integer, "category_filter" "text", "tag_filter" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."search_shareable_documents"("query_embedding" "public"."vector", "organization_id_filter" "uuid", "match_threshold" double precision, "match_count" integer, "doc_type_filter" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."search_shareable_documents"("query_embedding" "public"."vector", "organization_id_filter" "uuid", "match_threshold" double precision, "match_count" integer, "doc_type_filter" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_shareable_documents"("query_embedding" "public"."vector", "organization_id_filter" "uuid", "match_threshold" double precision, "match_count" integer, "doc_type_filter" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."search_user_memories"("query_embedding" "public"."vector", "p_user_id" "text", "p_organization_id" "uuid", "p_skill_namespace" "text", "match_threshold" double precision, "match_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_user_memories"("query_embedding" "public"."vector", "p_user_id" "text", "p_organization_id" "uuid", "p_skill_namespace" "text", "match_threshold" double precision, "match_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_user_memories"("query_embedding" "public"."vector", "p_user_id" "text", "p_organization_id" "uuid", "p_skill_namespace" "text", "match_threshold" double precision, "match_count" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."set_feature_flag"("p_user_id" "text", "p_flag_key" "text", "p_flag_value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."set_feature_flag"("p_user_id" "text", "p_flag_key" "text", "p_flag_value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_feature_flag"("p_user_id" "text", "p_flag_key" "text", "p_flag_value" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_org_feature_flag"("p_org_id" "uuid", "p_flag_key" "text", "p_flag_value" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."set_org_feature_flag"("p_org_id" "uuid", "p_flag_key" "text", "p_flag_value" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_org_feature_flag"("p_org_id" "uuid", "p_flag_key" "text", "p_flag_value" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_org_setting"("p_org_id" "uuid", "p_setting_key" "text", "p_setting_value" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."set_org_setting"("p_org_id" "uuid", "p_setting_key" "text", "p_setting_value" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_org_setting"("p_org_id" "uuid", "p_setting_key" "text", "p_setting_value" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_user_memories_tsv"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_user_memories_tsv"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_user_memories_tsv"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_workflow_run_counters"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_workflow_run_counters"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_workflow_run_counters"() TO "service_role";



GRANT ALL ON FUNCTION "public"."upsert_contact_from_company"("p_user_id" "text", "p_company_name" "text", "p_company_domain" "text", "p_relationship_type" "text", "p_source" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."upsert_contact_from_company"("p_user_id" "text", "p_company_name" "text", "p_company_domain" "text", "p_relationship_type" "text", "p_source" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."upsert_contact_from_company"("p_user_id" "text", "p_company_name" "text", "p_company_domain" "text", "p_relationship_type" "text", "p_source" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."upsert_contact_from_email"("p_user_id" "text", "p_email" "text", "p_full_name" "text", "p_company_name" "text", "p_relationship_type" "text", "p_source" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."upsert_contact_from_email"("p_user_id" "text", "p_email" "text", "p_full_name" "text", "p_company_name" "text", "p_relationship_type" "text", "p_source" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."upsert_contact_from_email"("p_user_id" "text", "p_email" "text", "p_full_name" "text", "p_company_name" "text", "p_relationship_type" "text", "p_source" "text") TO "service_role";



GRANT ALL ON TABLE "public"."ai_config" TO "anon";
GRANT ALL ON TABLE "public"."ai_config" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_config" TO "service_role";



GRANT ALL ON TABLE "public"."ai_models" TO "anon";
GRANT ALL ON TABLE "public"."ai_models" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_models" TO "service_role";



GRANT ALL ON TABLE "public"."app_secrets" TO "service_role";



GRANT ALL ON TABLE "public"."attio_credentials" TO "anon";
GRANT ALL ON TABLE "public"."attio_credentials" TO "authenticated";
GRANT ALL ON TABLE "public"."attio_credentials" TO "service_role";



GRANT ALL ON TABLE "public"."attio_oauth_pending" TO "service_role";



GRANT ALL ON TABLE "public"."briefing_log" TO "anon";
GRANT ALL ON TABLE "public"."briefing_log" TO "authenticated";
GRANT ALL ON TABLE "public"."briefing_log" TO "service_role";



GRANT ALL ON TABLE "public"."calendar_credentials" TO "anon";
GRANT ALL ON TABLE "public"."calendar_credentials" TO "authenticated";
GRANT ALL ON TABLE "public"."calendar_credentials" TO "service_role";



GRANT ALL ON TABLE "public"."calendar_events" TO "anon";
GRANT ALL ON TABLE "public"."calendar_events" TO "authenticated";
GRANT ALL ON TABLE "public"."calendar_events" TO "service_role";



GRANT ALL ON SEQUENCE "public"."calendar_sync_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."calendar_sync_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."calendar_sync_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."calendar_sync_log" TO "anon";
GRANT ALL ON TABLE "public"."calendar_sync_log" TO "authenticated";
GRANT ALL ON TABLE "public"."calendar_sync_log" TO "service_role";



GRANT ALL ON TABLE "public"."calendar_sync_logs" TO "anon";
GRANT ALL ON TABLE "public"."calendar_sync_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."calendar_sync_logs" TO "service_role";



GRANT ALL ON TABLE "public"."chat_messages" TO "anon";
GRANT ALL ON TABLE "public"."chat_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."chat_messages" TO "service_role";



GRANT ALL ON TABLE "public"."contact_enrichment" TO "anon";
GRANT ALL ON TABLE "public"."contact_enrichment" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_enrichment" TO "service_role";



GRANT ALL ON TABLE "public"."contact_interactions" TO "anon";
GRANT ALL ON TABLE "public"."contact_interactions" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_interactions" TO "service_role";



GRANT ALL ON TABLE "public"."contacts" TO "anon";
GRANT ALL ON TABLE "public"."contacts" TO "authenticated";
GRANT ALL ON TABLE "public"."contacts" TO "service_role";



GRANT ALL ON TABLE "public"."context_knowledge" TO "anon";
GRANT ALL ON TABLE "public"."context_knowledge" TO "authenticated";
GRANT ALL ON TABLE "public"."context_knowledge" TO "service_role";



GRANT ALL ON TABLE "public"."conversation_embeddings" TO "anon";
GRANT ALL ON TABLE "public"."conversation_embeddings" TO "authenticated";
GRANT ALL ON TABLE "public"."conversation_embeddings" TO "service_role";



GRANT ALL ON TABLE "public"."conversation_feedback" TO "anon";
GRANT ALL ON TABLE "public"."conversation_feedback" TO "authenticated";
GRANT ALL ON TABLE "public"."conversation_feedback" TO "service_role";



GRANT ALL ON TABLE "public"."conversation_insights" TO "anon";
GRANT ALL ON TABLE "public"."conversation_insights" TO "authenticated";
GRANT ALL ON TABLE "public"."conversation_insights" TO "service_role";



GRANT ALL ON TABLE "public"."conversations" TO "anon";
GRANT ALL ON TABLE "public"."conversations" TO "authenticated";
GRANT ALL ON TABLE "public"."conversations" TO "service_role";



GRANT ALL ON TABLE "public"."agent_email_credentials" TO "anon";
GRANT ALL ON TABLE "public"."agent_email_credentials" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_email_credentials" TO "service_role";



GRANT ALL ON TABLE "public"."deals" TO "anon";
GRANT ALL ON TABLE "public"."deals" TO "authenticated";
GRANT ALL ON TABLE "public"."deals" TO "service_role";



GRANT ALL ON TABLE "public"."digest_log" TO "anon";
GRANT ALL ON TABLE "public"."digest_log" TO "authenticated";
GRANT ALL ON TABLE "public"."digest_log" TO "service_role";



GRANT ALL ON TABLE "public"."document_chunks" TO "anon";
GRANT ALL ON TABLE "public"."document_chunks" TO "authenticated";
GRANT ALL ON TABLE "public"."document_chunks" TO "service_role";



GRANT ALL ON TABLE "public"."document_embeddings" TO "anon";
GRANT ALL ON TABLE "public"."document_embeddings" TO "authenticated";
GRANT ALL ON TABLE "public"."document_embeddings" TO "service_role";



GRANT ALL ON TABLE "public"."document_use_cases" TO "anon";
GRANT ALL ON TABLE "public"."document_use_cases" TO "authenticated";
GRANT ALL ON TABLE "public"."document_use_cases" TO "service_role";



GRANT ALL ON TABLE "public"."documents" TO "anon";
GRANT ALL ON TABLE "public"."documents" TO "authenticated";
GRANT ALL ON TABLE "public"."documents" TO "service_role";



GRANT ALL ON TABLE "public"."email_approval_requests" TO "anon";
GRANT ALL ON TABLE "public"."email_approval_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."email_approval_requests" TO "service_role";



GRANT ALL ON TABLE "public"."email_approval_workflow_runs" TO "anon";
GRANT ALL ON TABLE "public"."email_approval_workflow_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."email_approval_workflow_runs" TO "service_role";



GRANT ALL ON TABLE "public"."email_auto_response_drafts" TO "anon";
GRANT ALL ON TABLE "public"."email_auto_response_drafts" TO "authenticated";
GRANT ALL ON TABLE "public"."email_auto_response_drafts" TO "service_role";



GRANT ALL ON TABLE "public"."email_classifications" TO "anon";
GRANT ALL ON TABLE "public"."email_classifications" TO "authenticated";
GRANT ALL ON TABLE "public"."email_classifications" TO "service_role";



GRANT ALL ON TABLE "public"."email_feedback_events" TO "anon";
GRANT ALL ON TABLE "public"."email_feedback_events" TO "authenticated";
GRANT ALL ON TABLE "public"."email_feedback_events" TO "service_role";



GRANT ALL ON TABLE "public"."email_scheduled_followups" TO "anon";
GRANT ALL ON TABLE "public"."email_scheduled_followups" TO "authenticated";
GRANT ALL ON TABLE "public"."email_scheduled_followups" TO "service_role";



GRANT ALL ON TABLE "public"."email_thread_conversations" TO "anon";
GRANT ALL ON TABLE "public"."email_thread_conversations" TO "authenticated";
GRANT ALL ON TABLE "public"."email_thread_conversations" TO "service_role";



GRANT ALL ON TABLE "public"."feedback_events" TO "anon";
GRANT ALL ON TABLE "public"."feedback_events" TO "authenticated";
GRANT ALL ON TABLE "public"."feedback_events" TO "service_role";



GRANT ALL ON TABLE "public"."gmail_poll_state" TO "anon";
GRANT ALL ON TABLE "public"."gmail_poll_state" TO "authenticated";
GRANT ALL ON TABLE "public"."gmail_poll_state" TO "service_role";



GRANT ALL ON TABLE "public"."gmail_watch_subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."gmail_watch_subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."gmail_watch_subscriptions" TO "service_role";



GRANT ALL ON TABLE "public"."granola_credentials" TO "anon";
GRANT ALL ON TABLE "public"."granola_credentials" TO "authenticated";
GRANT ALL ON TABLE "public"."granola_credentials" TO "service_role";



GRANT ALL ON TABLE "public"."granola_oauth_pending" TO "service_role";



GRANT ALL ON TABLE "public"."incoming_emails" TO "anon";
GRANT ALL ON TABLE "public"."incoming_emails" TO "authenticated";
GRANT ALL ON TABLE "public"."incoming_emails" TO "service_role";



GRANT ALL ON TABLE "public"."langgraph_workflow_runs" TO "anon";
GRANT ALL ON TABLE "public"."langgraph_workflow_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."langgraph_workflow_runs" TO "service_role";






GRANT ALL ON TABLE "public"."meeting_prep_cache" TO "anon";
GRANT ALL ON TABLE "public"."meeting_prep_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."meeting_prep_cache" TO "service_role";



GRANT ALL ON TABLE "public"."notifications" TO "anon";
GRANT ALL ON TABLE "public"."notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."notifications" TO "service_role";



GRANT ALL ON TABLE "public"."oauth_connections" TO "anon";
GRANT ALL ON TABLE "public"."oauth_connections" TO "authenticated";
GRANT ALL ON TABLE "public"."oauth_connections" TO "service_role";



GRANT ALL ON TABLE "public"."oauth_states" TO "anon";
GRANT ALL ON TABLE "public"."oauth_states" TO "authenticated";
GRANT ALL ON TABLE "public"."oauth_states" TO "service_role";



GRANT ALL ON TABLE "public"."onboarding_progress" TO "anon";
GRANT ALL ON TABLE "public"."onboarding_progress" TO "authenticated";
GRANT ALL ON TABLE "public"."onboarding_progress" TO "service_role";



GRANT ALL ON TABLE "public"."org_context" TO "anon";
GRANT ALL ON TABLE "public"."org_context" TO "authenticated";
GRANT ALL ON TABLE "public"."org_context" TO "service_role";



GRANT ALL ON TABLE "public"."organization_invites" TO "anon";
GRANT ALL ON TABLE "public"."organization_invites" TO "authenticated";
GRANT ALL ON TABLE "public"."organization_invites" TO "service_role";



GRANT ALL ON TABLE "public"."organization_slack_settings" TO "anon";
GRANT ALL ON TABLE "public"."organization_slack_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."organization_slack_settings" TO "service_role";



GRANT ALL ON TABLE "public"."organization_users" TO "anon";
GRANT ALL ON TABLE "public"."organization_users" TO "authenticated";
GRANT ALL ON TABLE "public"."organization_users" TO "service_role";



GRANT ALL ON TABLE "public"."organizations" TO "anon";
GRANT ALL ON TABLE "public"."organizations" TO "authenticated";
GRANT ALL ON TABLE "public"."organizations" TO "service_role";



GRANT ALL ON TABLE "public"."pending_actions" TO "service_role";



GRANT ALL ON TABLE "public"."plg_users" TO "anon";
GRANT ALL ON TABLE "public"."plg_users" TO "authenticated";
GRANT ALL ON TABLE "public"."plg_users" TO "service_role";



GRANT ALL ON TABLE "public"."processed_meetings" TO "anon";
GRANT ALL ON TABLE "public"."processed_meetings" TO "authenticated";
GRANT ALL ON TABLE "public"."processed_meetings" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."reminders" TO "anon";
GRANT ALL ON TABLE "public"."reminders" TO "authenticated";
GRANT ALL ON TABLE "public"."reminders" TO "service_role";



GRANT ALL ON TABLE "public"."salesforce_credentials" TO "anon";
GRANT ALL ON TABLE "public"."salesforce_credentials" TO "authenticated";
GRANT ALL ON TABLE "public"."salesforce_credentials" TO "service_role";



GRANT ALL ON TABLE "public"."salesforce_oauth_pending" TO "anon";
GRANT ALL ON TABLE "public"."salesforce_oauth_pending" TO "authenticated";
GRANT ALL ON TABLE "public"."salesforce_oauth_pending" TO "service_role";



GRANT ALL ON TABLE "public"."shareable_documents" TO "anon";
GRANT ALL ON TABLE "public"."shareable_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."shareable_documents" TO "service_role";



GRANT ALL ON TABLE "public"."slack_error_events" TO "anon";
GRANT ALL ON TABLE "public"."slack_error_events" TO "authenticated";
GRANT ALL ON TABLE "public"."slack_error_events" TO "service_role";



GRANT ALL ON TABLE "public"."slack_message_log" TO "anon";
GRANT ALL ON TABLE "public"."slack_message_log" TO "authenticated";
GRANT ALL ON TABLE "public"."slack_message_log" TO "service_role";



GRANT ALL ON TABLE "public"."slack_oauth_states" TO "anon";
GRANT ALL ON TABLE "public"."slack_oauth_states" TO "authenticated";
GRANT ALL ON TABLE "public"."slack_oauth_states" TO "service_role";



GRANT ALL ON TABLE "public"."slack_thread_conversations" TO "anon";
GRANT ALL ON TABLE "public"."slack_thread_conversations" TO "authenticated";
GRANT ALL ON TABLE "public"."slack_thread_conversations" TO "service_role";



GRANT ALL ON TABLE "public"."slack_user_mappings" TO "anon";
GRANT ALL ON TABLE "public"."slack_user_mappings" TO "authenticated";
GRANT ALL ON TABLE "public"."slack_user_mappings" TO "service_role";



GRANT ALL ON TABLE "public"."slack_workspaces" TO "anon";
GRANT ALL ON TABLE "public"."slack_workspaces" TO "authenticated";
GRANT ALL ON TABLE "public"."slack_workspaces" TO "service_role";



GRANT ALL ON TABLE "public"."training_exports" TO "anon";
GRANT ALL ON TABLE "public"."training_exports" TO "authenticated";
GRANT ALL ON TABLE "public"."training_exports" TO "service_role";



GRANT ALL ON TABLE "public"."usage_events" TO "anon";
GRANT ALL ON TABLE "public"."usage_events" TO "authenticated";
GRANT ALL ON TABLE "public"."usage_events" TO "service_role";



GRANT ALL ON TABLE "public"."usage_org_daily" TO "anon";
GRANT ALL ON TABLE "public"."usage_org_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."usage_org_daily" TO "service_role";



GRANT ALL ON TABLE "public"."usage_user_daily" TO "anon";
GRANT ALL ON TABLE "public"."usage_user_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."usage_user_daily" TO "service_role";



GRANT ALL ON TABLE "public"."user_context" TO "anon";
GRANT ALL ON TABLE "public"."user_context" TO "authenticated";
GRANT ALL ON TABLE "public"."user_context" TO "service_role";



GRANT ALL ON TABLE "public"."user_email_style_examples" TO "anon";
GRANT ALL ON TABLE "public"."user_email_style_examples" TO "authenticated";
GRANT ALL ON TABLE "public"."user_email_style_examples" TO "service_role";



GRANT ALL ON TABLE "public"."user_learnings" TO "anon";
GRANT ALL ON TABLE "public"."user_learnings" TO "authenticated";
GRANT ALL ON TABLE "public"."user_learnings" TO "service_role";



GRANT ALL ON TABLE "public"."user_memories" TO "anon";
GRANT ALL ON TABLE "public"."user_memories" TO "authenticated";
GRANT ALL ON TABLE "public"."user_memories" TO "service_role";



GRANT ALL ON TABLE "public"."user_preferences" TO "anon";
GRANT ALL ON TABLE "public"."user_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."user_preferences" TO "service_role";



GRANT ALL ON TABLE "public"."user_roles" TO "anon";
GRANT ALL ON TABLE "public"."user_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_roles" TO "service_role";



GRANT ALL ON TABLE "public"."workflow_runs" TO "anon";
GRANT ALL ON TABLE "public"."workflow_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."workflow_runs" TO "service_role";



GRANT ALL ON TABLE "public"."v_org_top_users_30d" TO "anon";
GRANT ALL ON TABLE "public"."v_org_top_users_30d" TO "authenticated";
GRANT ALL ON TABLE "public"."v_org_top_users_30d" TO "service_role";



GRANT ALL ON TABLE "public"."v_org_workflow_breakdown_30d" TO "anon";
GRANT ALL ON TABLE "public"."v_org_workflow_breakdown_30d" TO "authenticated";
GRANT ALL ON TABLE "public"."v_org_workflow_breakdown_30d" TO "service_role";



GRANT ALL ON TABLE "public"."v_org_workflow_daily_30d" TO "anon";
GRANT ALL ON TABLE "public"."v_org_workflow_daily_30d" TO "authenticated";
GRANT ALL ON TABLE "public"."v_org_workflow_daily_30d" TO "service_role";



GRANT ALL ON TABLE "public"."v_org_workflow_kpis_30d" TO "anon";
GRANT ALL ON TABLE "public"."v_org_workflow_kpis_30d" TO "authenticated";
GRANT ALL ON TABLE "public"."v_org_workflow_kpis_30d" TO "service_role";



GRANT ALL ON TABLE "public"."v_org_workflow_kpis_7d" TO "anon";
GRANT ALL ON TABLE "public"."v_org_workflow_kpis_7d" TO "authenticated";
GRANT ALL ON TABLE "public"."v_org_workflow_kpis_7d" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







