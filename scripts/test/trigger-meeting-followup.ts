#!/usr/bin/env tsx
/**
 * Trigger Meeting Follow-Up with Real Granola Data
 *
 * Fetches your recent Granola meetings, lets you pick one, and sends
 * a "meeting/followup-ready" event to the local Inngest dev server.
 *
 * Prerequisites:
 *   - Inngest dev server running (npx inngest-cli@latest dev)
 *   - Local server running (npm run dev)
 *   - Active Granola connection for your user
 *
 * Usage:
 *   npx tsx scripts/test/trigger-meeting-followup.ts <your-email>
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as readline from 'readline';

dotenv.config({ path: path.resolve(process.cwd(), '.env.development') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY;
const INNGEST_URL = process.env.INNGEST_DEV_URL || 'http://localhost:8288';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: npx tsx scripts/test/trigger-meeting-followup.ts <your-email>');
    process.exit(1);
  }

  console.log('='.repeat(80));
  console.log('Trigger Meeting Follow-Up (real Granola data)');
  console.log('='.repeat(80));

  // Look up user by email
  const { data: profile, error: profileErr } = await supabase
    .from('profiles')
    .select('user_id, first_name, last_name, email')
    .eq('email', email)
    .single();

  if (profileErr || !profile) {
    console.error(`No profile found for email: ${email}`);
    process.exit(1);
  }

  const userId = profile.user_id;
  console.log(`User: ${profile.first_name} ${profile.last_name} (${userId})`);

  // Find their org
  const { data: membership } = await supabase
    .from('organization_users')
    .select('organization_id')
    .eq('user_id', userId)
    .limit(1)
    .single();

  if (!membership) {
    console.error('No organization found for this user');
    process.exit(1);
  }

  const organizationId = membership.organization_id;
  console.log(`Org:  ${organizationId}`);

  // Connect to Granola via MCP
  console.log('\nConnecting to Granola...');

  // Dynamic import to use the project's granola client
  const { getGranolaClient } = await import('../../server/src/services/granola-client.js');
  const client = await getGranolaClient(userId);

  if (!client) {
    console.error('Could not connect to Granola. Check that this user has active Granola credentials.');
    process.exit(1);
  }

  // List recent meetings
  console.log('Fetching recent meetings...\n');
  const listResult = await client.callTool({
    name: 'list_meetings',
    arguments: { query: '', limit: 10 },
  });

  const meetings = parseMeetingList(listResult.content);

  if (meetings.length === 0) {
    console.error('No meetings found in Granola.');
    await client.close();
    process.exit(1);
  }

  // Display meetings for selection
  for (let i = 0; i < meetings.length; i++) {
    const m = meetings[i];
    const timeStr = m.endTime ? new Date(m.endTime).toLocaleString() : 'unknown time';
    console.log(`  [${i + 1}] ${m.title} — ${timeStr}`);
  }

  const choice = await ask(`\nPick a meeting (1-${meetings.length}): `);
  const idx = parseInt(choice, 10) - 1;

  if (isNaN(idx) || idx < 0 || idx >= meetings.length) {
    console.error('Invalid selection.');
    await client.close();
    process.exit(1);
  }

  const selected = meetings[idx];
  console.log(`\nFetching full details for: "${selected.title}"...`);

  // Get full meeting content
  const fullResult = await client.callTool({
    name: 'get_meetings',
    arguments: { meeting_ids: [selected.id] },
  });

  await client.close();

  const parsed = parseMeetingContent(fullResult.content, selected);

  console.log(`  Attendees: ${parsed.attendees.map((a) => a.name).join(', ') || 'none found'}`);
  console.log(`  Highlights: ${parsed.highlights.length}`);
  console.log(`  Action items: ${parsed.actionItems.length}`);
  if (parsed.rawNotes) {
    console.log(`  Notes: ${parsed.rawNotes.length} chars`);
  }

  // Build the event
  const meetingData = {
    userId,
    organizationId,
    source: 'granola',
    externalMeetingId: selected.id,
    title: parsed.title,
    endTime: parsed.endTime || new Date().toISOString(),
    attendees: parsed.attendees,
    highlights: parsed.highlights,
    actionItems: parsed.actionItems,
    rawNotes: parsed.rawNotes?.slice(0, 4000),
    transcriptUrl: `https://notes.granola.ai/t/${selected.id}`,
  };

  // Insert processed_meetings row
  const { error: pmError } = await supabase
    .from('processed_meetings')
    .upsert(
      {
        user_id: userId,
        organization_id: organizationId,
        source: 'granola',
        external_meeting_id: meetingData.externalMeetingId,
        meeting_title: meetingData.title,
        meeting_end_time: meetingData.endTime,
        status: 'pending',
      },
      { onConflict: 'user_id,source,external_meeting_id' }
    );

  if (pmError) {
    console.error('Failed to insert processed_meeting row:', pmError.message);
  }

  // Send to Inngest
  const inngestEvent = {
    name: 'meeting/followup-ready',
    data: meetingData,
    user: {},
    v: '1',
    ts: Date.now(),
  };

  console.log(`\nSending meeting/followup-ready to ${INNGEST_URL}/e/agent-ai ...`);

  const resp = await fetch(`${INNGEST_URL}/e/agent-ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(inngestEvent),
  });

  if (resp.ok) {
    const data = await resp.json();
    console.log('\nEvent sent successfully:', JSON.stringify(data));
    console.log(`\nOpen ${INNGEST_URL} to watch the meeting-followup function execute.`);
  } else {
    const text = await resp.text();
    console.error(`\nFailed to send event (${resp.status}):`, text);
    console.log('Make sure the Inngest dev server is running: npx inngest-cli@latest dev');
  }
}

// ── Parsers (reused from scan-new-meetings) ─────────────────────────────────

interface MeetingListItem {
  id: string;
  title: string;
  endTime?: string;
}

interface MeetingContent {
  title: string;
  endTime?: string;
  attendees: Array<{ name: string; email?: string }>;
  highlights: string[];
  actionItems: string[];
  rawNotes?: string;
}

function parseMeetingList(content: any): MeetingListItem[] {
  const meetings: MeetingListItem[] = [];
  const blocks = Array.isArray(content) ? content : [];

  for (const block of blocks) {
    if (block.type !== 'text' || !block.text) continue;

    try {
      const parsed = JSON.parse(block.text);
      const items = Array.isArray(parsed) ? parsed : parsed.meetings || parsed.results || [parsed];
      for (const item of items) {
        if (item.id) {
          meetings.push({
            id: item.id,
            title: item.title || item.name || 'Untitled Meeting',
            endTime: item.end_time || item.endTime || item.ended_at,
          });
        }
      }
      continue;
    } catch { /* skip malformed blocks */ }

    const tagRegex = /<meeting\b([^>]+)>/g;
    const attrRegex = /(\w+)="([^"]+)"/g;
    let tagMatch;
    while ((tagMatch = tagRegex.exec(block.text)) !== null) {
      const attrs: Record<string, string> = {};
      let attrMatch;
      while ((attrMatch = attrRegex.exec(tagMatch[1])) !== null) {
        attrs[attrMatch[1]] = attrMatch[2];
      }
      if (attrs.id) {
        meetings.push({ id: attrs.id, title: attrs.title || 'Untitled Meeting', endTime: attrs.date });
      }
    }
  }

  return meetings;
}

function parseMeetingContent(content: any, fallback: MeetingListItem): MeetingContent {
  const result: MeetingContent = {
    title: fallback.title,
    endTime: fallback.endTime,
    attendees: [],
    highlights: [],
    actionItems: [],
  };

  const blocks = Array.isArray(content) ? content : [];

  for (const block of blocks) {
    if (block.type !== 'text' || !block.text) continue;

    try {
      const parsed = JSON.parse(block.text);

      if (parsed.title) result.title = parsed.title;
      if (parsed.end_time || parsed.endTime || parsed.ended_at) {
        result.endTime = parsed.end_time || parsed.endTime || parsed.ended_at;
      }

      if (Array.isArray(parsed.attendees)) {
        result.attendees = parsed.attendees.map((a: any) => ({
          name: a.name || a.display_name || a.email || 'Unknown',
          email: a.email || undefined,
        }));
      } else if (Array.isArray(parsed.participants)) {
        result.attendees = parsed.participants.map((a: any) => ({
          name: a.name || a.display_name || a.email || 'Unknown',
          email: a.email || undefined,
        }));
      }

      if (Array.isArray(parsed.highlights)) {
        result.highlights = parsed.highlights;
      } else if (parsed.summary) {
        result.highlights = String(parsed.summary).split(/\n/).map((l: string) => l.replace(/^[-•*]\s*/, '').trim()).filter(Boolean);
      }

      if (Array.isArray(parsed.action_items)) {
        result.actionItems = parsed.action_items.map((a: any) => typeof a === 'string' ? a : a.text || a.description || String(a));
      } else if (Array.isArray(parsed.actionItems)) {
        result.actionItems = parsed.actionItems.map((a: any) => typeof a === 'string' ? a : a.text || a.description || String(a));
      }

      if (parsed.notes || parsed.enhanced_notes || parsed.content) {
        result.rawNotes = parsed.notes || parsed.enhanced_notes || parsed.content;
      }
    } catch {
      const text = block.text;

      const titleMatch = text.match(/<meeting\b[^>]*\btitle="([^"]+)"/);
      if (titleMatch) result.title = titleMatch[1];

      const dateMatch = text.match(/<meeting\b[^>]*\bdate="([^"]+)"/);
      if (dateMatch) result.endTime = dateMatch[1];

      const participantsMatch = text.match(/<known_participants>([\s\S]*?)<\/known_participants>/);
      if (participantsMatch && result.attendees.length === 0) {
        const lines = participantsMatch[1].trim().split('\n').map((l) => l.trim()).filter(Boolean);
        for (const line of lines) {
          const emailMatch = line.match(/<([^>]+@[^>]+)>/);
          const nameMatch = line.match(/^([^(<]+)/);
          if (nameMatch) {
            result.attendees.push({ name: nameMatch[1].trim(), email: emailMatch?.[1] });
          }
        }
      }

      const notesMatch = text.match(/<notes>([\s\S]*?)<\/notes>/) ||
        text.match(/<enhanced_notes>([\s\S]*?)<\/enhanced_notes>/) ||
        text.match(/<content>([\s\S]*?)<\/content>/);
      if (notesMatch) {
        result.rawNotes = notesMatch[1].trim();
      } else if (!result.rawNotes) {
        result.rawNotes = text;
      }

      const actionMatch = text.match(/<action_items>([\s\S]*?)<\/action_items>/);
      if (actionMatch && result.actionItems.length === 0) {
        result.actionItems = actionMatch[1].trim().split('\n').map((l) => l.replace(/^[-•*]\s*/, '').trim()).filter(Boolean);
      }

      const highlightMatch = text.match(/<highlights>([\s\S]*?)<\/highlights>/) ||
        text.match(/<summary>([\s\S]*?)<\/summary>/);
      if (highlightMatch && result.highlights.length === 0) {
        result.highlights = highlightMatch[1].trim().split('\n').map((l) => l.replace(/^[-•*]\s*/, '').trim()).filter(Boolean);
      }
    }
  }

  return result;
}

main().catch(console.error);
