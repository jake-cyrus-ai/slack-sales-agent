#!/usr/bin/env tsx
/**
 * Seed Feature Data for Stalled Deals & Meeting Follow-ups
 *
 * Creates realistic development data to exercise:
 *  - scan-stalled-deals cron + stalled-deal-nudge agent
 *  - scan-new-meetings cron + meeting-followup agent
 *
 * Prerequisites: Run `npm run test:seed` first to create the base org, user, and profile.
 *
 * Usage:
 *   npm run test:seed-features
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables (.env.development takes precedence over .env)
dotenv.config({ path: path.resolve(process.cwd(), '.env.development') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ── Date helpers (all relative to runtime) ───────────────────────────────────

const now = new Date();

function daysAgo(n: number): string {
  const d = new Date(now);
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0]; // date type for deals.last_activity
}

function daysAgoTimestamp(n: number): string {
  const d = new Date(now);
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function hoursAgo(n: number): string {
  return new Date(now.getTime() - n * 60 * 60 * 1000).toISOString();
}

function daysFromNow(n: number): string {
  const d = new Date(now);
  d.setDate(d.getDate() + n);
  return d.toISOString();
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function seedFeatureData() {
  console.log('='.repeat(80));
  console.log('🌱 Seeding Feature Data: Stalled Deals & Meeting Follow-ups');
  console.log('='.repeat(80));

  try {
    // ── 1. Fetch prerequisites ──────────────────────────────────────────────

    console.log('\n📦 Fetching test organization...');
    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .select('id')
      .eq('slug', 'test-org')
      .single();

    if (orgError || !org) {
      console.error('❌ Test organization not found. Run `npm run test:seed` first.');
      process.exit(1);
    }
    const orgId = org.id;
    console.log('✅ Organization:', orgId);

    console.log('\n👤 Fetching test user profile...');
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('user_id')
      .eq('email', 'test@example.com')
      .single();

    if (profileError || !profile) {
      console.error('❌ Test user profile not found. Run `npm run test:seed` first.');
      process.exit(1);
    }
    const userId = profile.user_id;
    console.log('✅ User ID:', userId);

    // ── 2. Seed Slack workspace ─────────────────────────────────────────────

    console.log('\n💬 Seeding Slack workspace...');

    const slackBotToken = process.env.SLACK_BOT_TOKEN;
    if (!slackBotToken) {
      console.warn('⚠️  SLACK_BOT_TOKEN not set — Slack workspace will have a dummy token.');
      console.warn('   Set SLACK_BOT_TOKEN in .env.development for real Slack integration.');
    }
    const botToken = slackBotToken || 'xoxb-seed-test-bot-token-000';

    const { data: existingWorkspace } = await supabase
      .from('slack_workspaces')
      .select('id')
      .eq('team_id', 'T_SEED_TEST')
      .limit(1)
      .maybeSingle();

    let workspaceId: string;

    if (existingWorkspace) {
      const { error } = await supabase
        .from('slack_workspaces')
        .update({
          team_name: 'Seed Test Workspace',
          bot_token: botToken,
          bot_user_id: 'U_SEED_BOT',
          access_token: 'xoxp-seed-test-access-token-000',
          is_active: true,
          organization_id: orgId,
        })
        .eq('id', existingWorkspace.id);
      if (error) throw error;
      workspaceId = existingWorkspace.id;
      console.log('✅ Slack workspace updated:', workspaceId);
    } else {
      const { data: ws, error } = await supabase
        .from('slack_workspaces')
        .insert({
          team_id: 'T_SEED_TEST',
          team_name: 'Seed Test Workspace',
          bot_token: botToken,
          bot_user_id: 'U_SEED_BOT',
          access_token: 'xoxp-seed-test-access-token-000',
          is_active: true,
          organization_id: orgId,
        })
        .select('id')
        .single();
      if (error) throw error;
      workspaceId = ws.id;
      console.log('✅ Slack workspace created:', workspaceId);
    }

    // ── 3. Seed Slack user mapping ──────────────────────────────────────────

    console.log('\n🔗 Seeding Slack user mapping...');
    const slackUserId = process.env.SLACK_USER_ID;
    if (!slackUserId) {
      console.warn('⚠️  SLACK_USER_ID not set — Slack user mapping will have a dummy user ID.');
      console.warn('   Set SLACK_USER_ID in .env.development for real Slack DMs.');
    }
    const mappingSlackUserId = slackUserId || 'U_SEED_USER';

    // Delete any stale seed mappings for this user/workspace before upserting
    await supabase
      .from('slack_user_mappings')
      .delete()
      .eq('slack_workspace_id', workspaceId)
      .eq('agent_user_id', userId);

    const { error: mappingError } = await supabase
      .from('slack_user_mappings')
      .upsert(
        {
          slack_workspace_id: workspaceId,
          slack_user_id: mappingSlackUserId,
          slack_email: 'test@example.com',
          agent_user_id: userId,
          is_active: true,
          organization_id: orgId,
        },
        { onConflict: 'slack_workspace_id,slack_user_id' }
      );
    if (mappingError) throw mappingError;
    console.log('✅ Slack user mapping upserted (slack_user_id:', mappingSlackUserId + ')');

    // ── 4. Clean old seed data ──────────────────────────────────────────────

    console.log('\n🧹 Cleaning old seed data...');

    await supabase
      .from('workflow_runs')
      .delete()
      .eq('org_id', orgId)
      .filter('metadata->seeded', 'eq', 'true');

    await supabase
      .from('processed_meetings')
      .delete()
      .eq('user_id', userId)
      .eq('source', 'granola')
      .like('external_meeting_id', 'granola-seed-%');

    await supabase
      .from('calendar_events')
      .delete()
      .eq('user_id', userId)
      .like('google_event_id', 'seed-meeting-%');

    await supabase
      .from('deals')
      .delete()
      .eq('user_id', userId)
      .like('company_name', 'SeedCo%');

    await supabase
      .from('contacts')
      .delete()
      .eq('user_id', userId)
      .like('email', '%@seedco-%.test');

    console.log('✅ Old seed data cleaned');

    // ── 5. Seed deals ───────────────────────────────────────────────────────

    console.log('\n📊 Seeding 8 deals...');
    const dealRecords = [
      {
        user_id: userId,
        organization_id: orgId,
        company_name: 'SeedCo Alpha — Stalled 7d No Activity',
        contact_name: 'Alice Johnson',
        contact_email: 'alice@seedco-alpha.test',
        status: 'Active',
        value: 45000,
        stage: 'Proposal',
        last_activity: daysAgo(7),
        next_milestone: 'Contract review',
        days_until_milestone: 10,
        health_score: 55,
        notes: 'Went quiet after proposal was sent. No response to last 2 emails.',
      },
      {
        user_id: userId,
        organization_id: orgId,
        company_name: 'SeedCo Beta — Milestone Overdue 3d',
        contact_name: 'Bob Martinez',
        contact_email: 'bob@seedco-beta.test',
        status: 'Active',
        value: 120000,
        stage: 'Negotiation',
        last_activity: daysAgo(2),
        next_milestone: 'Legal review completion',
        days_until_milestone: -3,
        health_score: 62,
        notes: 'Legal team has not returned redlines. Was due 3 days ago.',
      },
      {
        user_id: userId,
        organization_id: orgId,
        company_name: 'SeedCo Gamma — Low Health 25',
        contact_name: 'Carol Chen',
        contact_email: 'carol@seedco-gamma.test',
        status: 'Active',
        value: 30000,
        stage: 'Discovery',
        last_activity: daysAgo(3),
        next_milestone: 'Technical demo',
        days_until_milestone: 5,
        health_score: 25,
        notes: 'Champion left the company. New stakeholder seems lukewarm.',
      },
      {
        user_id: userId,
        organization_id: orgId,
        company_name: 'SeedCo Delta — Multi Stall',
        contact_name: 'Dan Williams',
        contact_email: 'dan@seedco-delta.test',
        status: 'Active',
        value: 75000,
        stage: 'Proposal',
        last_activity: daysAgo(10),
        next_milestone: 'Budget approval',
        days_until_milestone: 2,
        health_score: 18,
        notes: 'Budget freeze rumored internally. Multiple missed calls.',
      },
      {
        user_id: userId,
        organization_id: orgId,
        company_name: 'SeedCo Epsilon — Healthy Active',
        contact_name: 'Eve Taylor',
        contact_email: 'eve@seedco-epsilon.test',
        status: 'Active',
        value: 90000,
        stage: 'Negotiation',
        last_activity: daysAgo(1),
        next_milestone: 'Contract signing',
        days_until_milestone: 7,
        health_score: 82,
        notes: 'Strong engagement. Contract in final review.',
      },
      {
        user_id: userId,
        organization_id: orgId,
        company_name: 'SeedCo Zeta — Won Deal',
        contact_name: 'Frank Davis',
        contact_email: 'frank@seedco-zeta.test',
        status: 'Won',
        value: 200000,
        stage: 'Closed Won',
        last_activity: daysAgo(14),
        next_milestone: null,
        days_until_milestone: null,
        health_score: 95,
        notes: 'Deal closed. Onboarding scheduled.',
      },
      {
        user_id: userId,
        organization_id: orgId,
        company_name: 'SeedCo Eta — Lost Deal',
        contact_name: 'Grace Lee',
        contact_email: 'grace@seedco-eta.test',
        status: 'Lost',
        value: 60000,
        stage: 'Proposal',
        last_activity: daysAgo(30),
        next_milestone: null,
        days_until_milestone: null,
        health_score: 10,
        notes: 'Lost to competitor. Price was the deciding factor.',
      },
      {
        user_id: userId,
        organization_id: orgId,
        company_name: 'SeedCo Theta — Paused Deal',
        contact_name: 'Henry Brown',
        contact_email: 'henry@seedco-theta.test',
        status: 'Paused',
        value: 55000,
        stage: 'Discovery',
        last_activity: daysAgo(20),
        next_milestone: 'Reactivation call',
        days_until_milestone: null,
        health_score: 35,
        notes: 'Customer asked to pause while they complete internal restructuring.',
      },
    ];

    const { data: deals, error: dealsError } = await supabase
      .from('deals')
      .insert(dealRecords)
      .select('id, company_name');
    if (dealsError) throw dealsError;
    console.log(`✅ ${deals.length} deals created`);

    // Build a lookup by company prefix for FK references
    const dealByPrefix: Record<string, string> = {};
    for (const d of deals) {
      const prefix = d.company_name.split(' — ')[0]; // e.g. "SeedCo Alpha"
      dealByPrefix[prefix] = d.id;
    }

    // ── 6. Seed contacts ────────────────────────────────────────────────────

    console.log('\n👥 Seeding 8 contacts...');
    const contactRecords = [
      { user_id: userId, first_name: 'Alice', last_name: 'Johnson', full_name: 'Alice Johnson', email: 'alice@seedco-alpha.test', company_name: 'SeedCo Alpha', title: 'VP Sales', relationship_type: 'prospect', relationship_strength: 'warm', source: 'seed' },
      { user_id: userId, first_name: 'Bob', last_name: 'Martinez', full_name: 'Bob Martinez', email: 'bob@seedco-beta.test', company_name: 'SeedCo Beta', title: 'Head of Legal', relationship_type: 'prospect', relationship_strength: 'hot', source: 'seed' },
      { user_id: userId, first_name: 'Carol', last_name: 'Chen', full_name: 'Carol Chen', email: 'carol@seedco-gamma.test', company_name: 'SeedCo Gamma', title: 'CTO', relationship_type: 'prospect', relationship_strength: 'cold', source: 'seed' },
      { user_id: userId, first_name: 'Dan', last_name: 'Williams', full_name: 'Dan Williams', email: 'dan@seedco-delta.test', company_name: 'SeedCo Delta', title: 'CFO', relationship_type: 'prospect', relationship_strength: 'cold', source: 'seed' },
      { user_id: userId, first_name: 'Eve', last_name: 'Taylor', full_name: 'Eve Taylor', email: 'eve@seedco-epsilon.test', company_name: 'SeedCo Epsilon', title: 'CEO', relationship_type: 'prospect', relationship_strength: 'champion', source: 'seed' },
      { user_id: userId, first_name: 'Frank', last_name: 'Davis', full_name: 'Frank Davis', email: 'frank@seedco-zeta.test', company_name: 'SeedCo Zeta', title: 'VP Engineering', relationship_type: 'customer', relationship_strength: 'champion', source: 'seed' },
      { user_id: userId, first_name: 'Grace', last_name: 'Lee', full_name: 'Grace Lee', email: 'grace@seedco-eta.test', company_name: 'SeedCo Eta', title: 'Director of IT', relationship_type: 'prospect', relationship_strength: 'cold', source: 'seed' },
      { user_id: userId, first_name: 'Henry', last_name: 'Brown', full_name: 'Henry Brown', email: 'henry@seedco-theta.test', company_name: 'SeedCo Theta', title: 'COO', relationship_type: 'prospect', relationship_strength: 'warm', source: 'seed' },
    ];

    const { data: contacts, error: contactsError } = await supabase
      .from('contacts')
      .insert(contactRecords)
      .select('id');
    if (contactsError) throw contactsError;
    console.log(`✅ ${contacts.length} contacts created`);

    // ── 7. Seed deal workflow runs (for dedup testing) ──────────────────────

    console.log('\n🔄 Seeding deal workflow runs...');
    const dealWorkflowRecords = [
      {
        org_id: orgId,
        user_id: userId,
        deal_id: dealByPrefix['SeedCo Delta'], // Recent — blocks dedup
        workflow_kind: 'deal_followup',
        status: 'succeeded',
        started_at: daysAgoTimestamp(1),
        metadata: { stalledReason: 'low_health', seeded: true },
      },
      {
        org_id: orgId,
        user_id: userId,
        deal_id: dealByPrefix['SeedCo Alpha'], // Old — does NOT block dedup
        workflow_kind: 'deal_followup',
        status: 'succeeded',
        started_at: daysAgoTimestamp(5),
        metadata: { stalledReason: 'no_activity_5d', seeded: true },
      },
    ];

    const { data: dealRuns, error: dealRunsError } = await supabase
      .from('workflow_runs')
      .insert(dealWorkflowRecords)
      .select('id');
    if (dealRunsError) throw dealRunsError;
    console.log(`✅ ${dealRuns.length} deal workflow runs created`);

    // ── 8. Seed Granola credentials ─────────────────────────────────────────

    console.log('\n🎙️  Seeding Granola credentials...');
    const { error: granolaError } = await supabase
      .from('granola_credentials')
      .upsert(
        {
          user_id: userId,
          organization_id: orgId,
          access_token_encrypted: 'seed-encrypted-access-token-placeholder',
          refresh_token_encrypted: 'seed-encrypted-refresh-token-placeholder',
          token_expiry: daysFromNow(7),
          sync_status: 'disconnected',
          granola_email: 'test@example.com',
        },
        { onConflict: 'user_id' }
      );
    if (granolaError) throw granolaError;
    console.log('✅ Granola credentials upserted');

    // ── 9. Seed calendar events ─────────────────────────────────────────────

    console.log('\n📅 Seeding 4 calendar events...');
    const calendarRecords = [
      {
        user_id: userId,
        google_event_id: 'seed-meeting-001',
        calendar_id: 'primary',
        summary: 'Quarterly Business Review with SeedCo Alpha',
        start_time: hoursAgo(1.5),
        end_time: hoursAgo(0.5),
        attendees: JSON.stringify([
          { email: 'alice@seedco-alpha.test', displayName: 'Alice Johnson', responseStatus: 'accepted' },
        ]),
        organization_id: orgId,
      },
      {
        user_id: userId,
        google_event_id: 'seed-meeting-002',
        calendar_id: 'primary',
        summary: 'Technical Deep Dive — SeedCo Gamma',
        start_time: hoursAgo(4),
        end_time: hoursAgo(3),
        attendees: JSON.stringify([
          { email: 'carol@seedco-gamma.test', displayName: 'Carol Chen', responseStatus: 'accepted' },
        ]),
        organization_id: orgId,
      },
      {
        user_id: userId,
        google_event_id: 'seed-meeting-003',
        calendar_id: 'primary',
        summary: 'Contract Negotiation — SeedCo Beta',
        start_time: hoursAgo(25),
        end_time: hoursAgo(24),
        attendees: JSON.stringify([
          { email: 'bob@seedco-beta.test', displayName: 'Bob Martinez', responseStatus: 'accepted' },
        ]),
        organization_id: orgId,
      },
      {
        user_id: userId,
        google_event_id: 'seed-meeting-004',
        calendar_id: 'primary',
        summary: 'Weekly Sales Standup',
        start_time: hoursAgo(2.5),
        end_time: hoursAgo(2),
        attendees: JSON.stringify([
          { email: 'colleague@test-org.test', displayName: 'Team Member', responseStatus: 'accepted' },
        ]),
        organization_id: orgId,
      },
    ];

    const { data: calEvents, error: calError } = await supabase
      .from('calendar_events')
      .insert(calendarRecords)
      .select('id');
    if (calError) throw calError;
    console.log(`✅ ${calEvents.length} calendar events created`);

    // ── 10. Seed meeting workflow runs ───────────────────────────────────────

    console.log('\n🔄 Seeding meeting workflow runs...');
    const meetingWorkflowRecords = [
      {
        org_id: orgId,
        user_id: userId,
        workflow_kind: 'meeting_followup',
        status: 'succeeded',
        started_at: hoursAgo(2.5),
        metadata: { source: 'granola', externalMeetingId: 'granola-seed-002', seeded: true },
      },
      {
        org_id: orgId,
        user_id: userId,
        workflow_kind: 'meeting_followup',
        status: 'failed',
        started_at: hoursAgo(1.5),
        error_code: 'supervisor_timeout',
        error_message: 'Supervisor agent timed out after 30s',
        metadata: { source: 'granola', externalMeetingId: 'granola-seed-004', seeded: true },
      },
    ];

    const { data: meetingRuns, error: meetingRunsError } = await supabase
      .from('workflow_runs')
      .insert(meetingWorkflowRecords)
      .select('id, metadata');
    if (meetingRunsError) throw meetingRunsError;
    console.log(`✅ ${meetingRuns.length} meeting workflow runs created`);

    // Build lookup for workflow_run_id linking
    const meetingRunByExtId: Record<string, string> = {};
    for (const r of meetingRuns) {
      const extId = (r.metadata as any)?.externalMeetingId;
      if (extId) meetingRunByExtId[extId] = r.id;
    }

    // ── 11. Seed processed meetings ─────────────────────────────────────────

    console.log('\n📝 Seeding 4 processed meetings...');
    const processedMeetingRecords = [
      {
        user_id: userId,
        organization_id: orgId,
        source: 'granola',
        external_meeting_id: 'granola-seed-001',
        meeting_title: 'Quarterly Business Review with SeedCo Alpha',
        meeting_end_time: hoursAgo(0.5),
        status: 'pending',
        workflow_run_id: null,
      },
      {
        user_id: userId,
        organization_id: orgId,
        source: 'granola',
        external_meeting_id: 'granola-seed-002',
        meeting_title: 'Technical Deep Dive — SeedCo Gamma',
        meeting_end_time: hoursAgo(3),
        status: 'sent',
        workflow_run_id: meetingRunByExtId['granola-seed-002'] || null,
      },
      {
        user_id: userId,
        organization_id: orgId,
        source: 'granola',
        external_meeting_id: 'granola-seed-003',
        meeting_title: 'Contract Negotiation — SeedCo Beta',
        meeting_end_time: hoursAgo(24),
        status: 'dismissed',
        workflow_run_id: null,
      },
      {
        user_id: userId,
        organization_id: orgId,
        source: 'granola',
        external_meeting_id: 'granola-seed-004',
        meeting_title: 'Weekly Sales Standup',
        meeting_end_time: hoursAgo(2),
        status: 'error',
        workflow_run_id: meetingRunByExtId['granola-seed-004'] || null,
      },
    ];

    const { data: procMeetings, error: procError } = await supabase
      .from('processed_meetings')
      .upsert(processedMeetingRecords, { onConflict: 'user_id,source,external_meeting_id' })
      .select('id');
    if (procError) throw procError;
    console.log(`✅ ${procMeetings.length} processed meetings upserted`);

    // ── Summary ─────────────────────────────────────────────────────────────

    console.log('\n' + '='.repeat(80));
    console.log('✅ Feature Data Seeded Successfully!');
    console.log('='.repeat(80));

    console.log('\n📋 Stalled Deals Summary:');
    console.log('   Deals created: 8');
    console.log('     → 4 should trigger stalled scan (Alpha, Beta, Gamma, Delta)');
    console.log('     → 1 blocked by dedup (Delta — nudged 1 day ago)');
    console.log('     → 3 should receive nudge (Alpha, Beta, Gamma)');
    console.log('     → 4 should NOT trigger (Epsilon=healthy, Zeta=won, Eta=lost, Theta=paused)');
    console.log('   Contacts created: 8');
    console.log('   Deal workflow runs: 2 (1 recent for dedup, 1 old)');

    console.log('\n📋 Meeting Follow-ups Summary:');
    console.log('   Granola credentials: active');
    console.log('   Calendar events: 4');
    console.log('   Processed meetings: 4 (pending, sent, dismissed, error)');
    console.log('   Meeting workflow runs: 2 (succeeded, failed)');

    console.log('\n📋 Slack Infrastructure:');
    console.log(`   Workspace: ${workspaceId} (T_SEED_TEST)`);
    console.log(`   User mapping: ${userId} → U_SEED_USER`);

    console.log('\n💡 You can now test these features locally!');
    console.log('   - Stalled deals: trigger scan-stalled-deals via Inngest dashboard');
    console.log('   - Meeting follow-ups: trigger scan-new-meetings via Inngest dashboard');
    console.log('\n' + '='.repeat(80));

  } catch (error) {
    console.error('\n❌ Error seeding feature data:', error);
    process.exit(1);
  }
}

// Run
seedFeatureData().catch(console.error);
