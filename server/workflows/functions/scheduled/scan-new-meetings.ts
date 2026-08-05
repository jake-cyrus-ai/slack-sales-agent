/**
 * Scan New Meetings — Scheduled Vercel Workflow Function (Granola source)
 *
 * Polls Granola MCP every 15 minutes for recently completed meetings.
 * For each new meeting, extracts highlights and action items, inserts
 * a dedup row into processed_meetings, and fans out source-agnostic
 * "meeting/followup-ready" events.
 *
 * Extensibility: other meeting-note sources (Otter, Fireflies, etc.)
 * create their own scanner that emits the same event. The downstream
 * handler (meeting-followup.ts) never imports Granola code.
 */

import { workflow } from "../../client";
import { getSupabaseAdmin } from "../../utils";
import { getGranolaClient } from "../../../src/services/granola-client.js";
import { logger } from "../../../lib/logger";

const log = logger.child({ fn: "scan-new-meetings" });
import type { MeetingFollowupReadyData } from "../../events";

const MAX_RAW_NOTES_LENGTH = 4000;

export const scanNewMeetings = workflow.createFunction(
  {
    id: "scan-new-meetings",
    retries: 2,
  },
  { cron: "*/15 * * * *" },
  async ({ step }) => {
        log.info("Starting Granola meeting scan");

    const supabase = getSupabaseAdmin();

    // Step 1: Find users with active Granola connections
    const granolaUsers = await step.run("find-granola-users", async () => {
            const { data, error } = await supabase
        .from("granola_credentials")
        .select("user_id, organization_id")
        .eq("sync_status", "active");

      if (error) {
        log.error({ err: error }, "Error fetching Granola users");
        return [];
      }
      return data || [];
    });

    if (granolaUsers.length === 0) {
      log.info("No active Granola users found");
      return { processed: 0 };
    }

    // Step 2: Poll each user's Granola meetings individually (one step.run per user
    // to avoid a single step timing out when processing many users sequentially)
    const allResults: MeetingFollowupReadyData[][] = [];

    for (const user of granolaUsers) {
      const userMeetings = await step.run(`poll-user-${user.user_id}`, async () => {
              const meetings: MeetingFollowupReadyData[] = [];

        try {
          const client = await getGranolaClient(user.user_id);
          if (!client) {
            log.warn({ userId: user.user_id }, "Could not get Granola client for user");
            return meetings;
          }

          try {
            // Search for recent meetings
            log.info({ userId: user.user_id }, "Calling list_meetings for user");
            const searchResult = await client.callTool({
              name: "list_meetings",
              arguments: { query: "", limit: 5 },
            });

            const searchContent = searchResult.content;
            log.info({ response: JSON.stringify(searchContent)?.slice(0, 500) }, "list_meetings response");
            if (!searchContent || !Array.isArray(searchContent)) {
              log.info("No valid content from list_meetings, skipping");
              await client.close();
              return meetings;
            }

            // Parse meeting list from MCP response
            const meetingList = parseMcpMeetingList(searchContent);
            log.info({ count: meetingList.length }, "Parsed meetings from MCP response");

            // Only process meetings that ended within the last hour
            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
            const now = new Date();
            const recentMeetings = meetingList.filter((m) => {
              if (!m.endTime) return false;
              const endDate = new Date(m.endTime);
              return !isNaN(endDate.getTime()) && endDate >= oneHourAgo && endDate <= now;
            });
            log.info({ recent: recentMeetings.length, total: meetingList.length }, "Meetings within the last hour");

            for (const meeting of recentMeetings) {
              if (!meeting.id) continue;

              // Atomically claim this meeting — upsert ignores duplicates
              const { data: inserted, error: upsertErr } = await supabase
                .from("processed_meetings")
                .upsert(
                  {
                    user_id: user.user_id,
                    organization_id: user.organization_id,
                    source: "granola",
                    external_meeting_id: meeting.id,
                    meeting_title: meeting.title,
                    meeting_end_time: meeting.endTime || new Date().toISOString(),
                    status: "pending",
                  },
                  { onConflict: "user_id,source,external_meeting_id", ignoreDuplicates: true }
                )
                .select("id")
                .maybeSingle();

              if (upsertErr) {
                log.error({ meetingId: meeting.id, err: upsertErr }, "Upsert error for meeting");
                continue;
              }

              // If upsert returned nothing, this meeting was already processed
              if (!inserted) continue;

              // Per-meeting try/catch so a single MCP/parse failure doesn't
              // orphan the pending row (dedup index would block retry forever).
              try {
                const fullResult = await client.callTool({
                  name: "get_meetings",
                  arguments: { meeting_ids: [meeting.id] },
                });

                const parsed = parseMcpMeetingContent(fullResult.content, meeting);

                // If no notes were extracted, fetch the transcript as fallback
                if (!parsed.rawNotes && !parsed.highlights.length) {
                  try {
                    const transcriptResult = await client.callTool({
                      name: "get_meeting_transcript",
                      arguments: { meeting_id: meeting.id },
                    });
                    const transcriptBlocks = Array.isArray(transcriptResult.content) ? transcriptResult.content : [];
                    for (const block of transcriptBlocks) {
                      if (block.type === "text" && block.text) {
                        parsed.rawNotes = block.text.slice(0, MAX_RAW_NOTES_LENGTH);
                        break;
                      }
                    }
                  } catch (err) {
                    log.warn({ meetingId: meeting.id, err }, "Transcript fetch failed for meeting");
                  }
                }

                // Update the row with full parsed content
                await supabase
                  .from("processed_meetings")
                  .update({
                    meeting_title: parsed.title,
                    meeting_end_time: parsed.endTime || new Date().toISOString(),
                  })
                  .eq("id", inserted.id);

                meetings.push({
                  userId: user.user_id,
                  organizationId: user.organization_id,
                  source: "granola",
                  externalMeetingId: meeting.id,
                  title: parsed.title,
                  endTime: parsed.endTime || new Date().toISOString(),
                  attendees: parsed.attendees,
                  highlights: parsed.highlights,
                  actionItems: parsed.actionItems,
                  rawNotes: parsed.rawNotes?.slice(0, MAX_RAW_NOTES_LENGTH),
                  transcriptUrl: `https://notes.granola.ai/t/${meeting.id}`,
                });
              } catch (err) {
                // Drop the pending row so the next cron can retry this meeting.
                log.error({ meetingId: meeting.id, err }, "Failed to fetch/parse meeting content; removing pending row for retry");
                await supabase
                  .from("processed_meetings")
                  .delete()
                  .eq("id", inserted.id);
              }
            }

            await client.close();
          } catch (err) {
            log.error({ userId: user.user_id, err }, "Error polling meetings for user");
            await client.close().catch(() => {});
          }
        } catch (err) {
          log.error({ userId: user.user_id, err }, "Error processing user");
        }

        return meetings;
      });

      // step.run returns JsonifyObject<T> (all fields optional for serialization); cast back.
      allResults.push(userMeetings as MeetingFollowupReadyData[]);
    }

    const newMeetings = allResults.flat();

    if (newMeetings.length === 0) {
      log.info("No new meetings found");
      return { processed: 0 };
    }

    // Step 3: Fan out follow-up events
    await step.sendEvent(
      "fan-out-followups",
      newMeetings.map((meeting) => ({
        name: "meeting/followup-ready" as const,
        data: meeting,
      }))
    );

    log.info({ count: newMeetings.length }, "Emitted follow-up events");
    return { processed: newMeetings.length };
  }
);

// ── MCP Response Parsers ─────────────────────────────────────────────────────

interface ParsedMeetingListItem {
  id: string;
  title: string;
  endTime?: string;
}

interface ParsedMeetingContent {
  title: string;
  endTime?: string;
  attendees: Array<{ name: string; email?: string }>;
  highlights: string[];
  actionItems: string[];
  rawNotes?: string;
}

/**
 * Parse the MCP list_meetings response into a flat meeting list.
 * MCP tools return content as an array of { type, text } blocks.
 */
function parseMcpMeetingList(content: any[]): ParsedMeetingListItem[] {
  const meetings: ParsedMeetingListItem[] = [];

  for (const block of content) {
    if (block.type !== "text" || !block.text) continue;

    // Try JSON first
    try {
      const parsed = JSON.parse(block.text);
      const items = Array.isArray(parsed) ? parsed : parsed.meetings || parsed.results || [parsed];
      for (const item of items) {
        if (item.id) {
          meetings.push({
            id: item.id,
            title: item.title || item.name || "Untitled Meeting",
            endTime: item.end_time || item.endTime || item.ended_at,
          });
        }
      }
      continue;
    } catch {
      // Not JSON — fall through to XML/text parsing
    }

    // Parse XML-style <meeting ...> tags with order-independent attribute extraction
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
        meetings.push({
          id: attrs.id,
          title: attrs.title || "Untitled Meeting",
          endTime: attrs.date,
        });
      }
    }
  }

  return meetings;
}

/**
 * Parse the MCP get_meetings response into structured meeting content.
 */
function parseMcpMeetingContent(
  content: any,
  fallback: ParsedMeetingListItem
): ParsedMeetingContent {
  const result: ParsedMeetingContent = {
    title: fallback.title,
    endTime: fallback.endTime,
    attendees: [],
    highlights: [],
    actionItems: [],
  };

  const blocks = Array.isArray(content) ? content : [];

  for (const block of blocks) {
    if (block.type !== "text" || !block.text) continue;

    try {
      const parsed = JSON.parse(block.text);

      // Title and timing
      if (parsed.title) result.title = parsed.title;
      if (parsed.end_time || parsed.endTime || parsed.ended_at) {
        result.endTime = parsed.end_time || parsed.endTime || parsed.ended_at;
      }

      // Attendees
      if (Array.isArray(parsed.attendees)) {
        result.attendees = parsed.attendees.map((a: any) => ({
          name: a.name || a.display_name || a.email || "Unknown",
          email: a.email || undefined,
        }));
      } else if (Array.isArray(parsed.participants)) {
        result.attendees = parsed.participants.map((a: any) => ({
          name: a.name || a.display_name || a.email || "Unknown",
          email: a.email || undefined,
        }));
      }

      // Highlights / summary
      if (Array.isArray(parsed.highlights)) {
        result.highlights = parsed.highlights;
      } else if (parsed.summary) {
        // Split summary into bullet points
        result.highlights = String(parsed.summary)
          .split(/\n/)
          .map((l: string) => l.replace(/^[-•*]\s*/, "").trim())
          .filter(Boolean);
      }

      // Action items
      if (Array.isArray(parsed.action_items)) {
        result.actionItems = parsed.action_items.map((a: any) =>
          typeof a === "string" ? a : a.text || a.description || String(a)
        );
      } else if (Array.isArray(parsed.actionItems)) {
        result.actionItems = parsed.actionItems.map((a: any) =>
          typeof a === "string" ? a : a.text || a.description || String(a)
        );
      }

      // Raw notes
      if (parsed.notes || parsed.enhanced_notes || parsed.content) {
        result.rawNotes = parsed.notes || parsed.enhanced_notes || parsed.content;
      }
    } catch {
      // Not JSON — try XML parsing
      const text = block.text;

      // Extract title from <meeting> tag
      const titleMatch = text.match(/<meeting\b[^>]*\btitle="([^"]+)"/);
      if (titleMatch) result.title = titleMatch[1];

      // Extract date
      const dateMatch = text.match(/<meeting\b[^>]*\bdate="([^"]+)"/);
      if (dateMatch) result.endTime = dateMatch[1];

      // Extract participants from <known_participants> blocks
      const participantsMatch = text.match(/<known_participants>([\s\S]*?)<\/known_participants>/);
      if (participantsMatch && result.attendees.length === 0) {
        const participantLines = participantsMatch[1].trim().split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of participantLines) {
          const emailMatch = line.match(/<([^>]+@[^>]+)>/);
          const nameMatch = line.match(/^([^(<]+)/);
          if (nameMatch) {
            result.attendees.push({
              name: nameMatch[1].trim(),
              email: emailMatch?.[1],
            });
          }
        }
      }

      // Extract notes/content sections
      const notesMatch = text.match(/<notes>([\s\S]*?)<\/notes>/) ||
                          text.match(/<enhanced_notes>([\s\S]*?)<\/enhanced_notes>/) ||
                          text.match(/<content>([\s\S]*?)<\/content>/);
      if (notesMatch) {
        result.rawNotes = notesMatch[1].trim();
      } else if (!result.rawNotes) {
        // Only use raw text if it doesn't look like XML/structured data
        const looksLikeXml = /<\w+[\s>]/.test(text.trim().slice(0, 50));
        if (!looksLikeXml) {
          result.rawNotes = text;
        }
      }

      // Extract action items
      const actionMatch = text.match(/<action_items>([\s\S]*?)<\/action_items>/);
      if (actionMatch && result.actionItems.length === 0) {
        result.actionItems = actionMatch[1].trim().split('\n')
          .map(l => l.replace(/^[-•*]\s*/, '').trim())
          .filter(Boolean);
      }

      // Extract highlights/summary
      const highlightMatch = text.match(/<highlights>([\s\S]*?)<\/highlights>/) ||
                              text.match(/<summary>([\s\S]*?)<\/summary>/);
      if (highlightMatch && result.highlights.length === 0) {
        result.highlights = highlightMatch[1].trim().split('\n')
          .map(l => l.replace(/^[-•*]\s*/, '').trim())
          .filter(Boolean);
      }
    }
  }

  return result;
}
