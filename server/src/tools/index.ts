/**
 * Tool registry — grouped by skill domain.
 */

import type { DynamicStructuredTool } from '@langchain/core/tools';
import { createGmailSearchTool } from './gmail-search.js';
import { createGmailReadTool } from './gmail-read.js';
import { createCalendarSearchTool } from './calendar-search.js';
import { createCalendarCreateTool } from './calendar-create.js';
import { createCalendarUpdateTool } from './calendar-update.js';
import { createCalendarDeleteTool } from './calendar-delete.js';
import { createContactLookupTool } from './contact-lookup.js';
import { createContextKBTool } from './context-kb.js';
import { createShareableDocsTool } from './shareable-docs.js';
import { createDriveSearchTool } from './drive-search.js';
import { createExaResearchTool } from './exa-research.js';
import { createWebBrowseTool } from './web-browse.js';
import { createSlackHistoryTool } from './slack-history.js';
import { createSlackSendDmTool } from './slack-send-dm.js';
import { createSlackGroupChatTool } from './slack-create-group-chat.js';
import { createSlackInviteToChannelTool } from './slack-invite-to-channel.js';
import { createSlackMentionInThreadTool } from './slack-mention-in-thread.js';
import { createGranolaSearchMeetingsTool } from './granola-search-meetings.js';
import { createGranolaGetMeetingTool } from './granola-get-meeting.js';
import { createGranolaQueryTool } from './granola-query.js';
import { createGranolaTranscriptTool } from './granola-transcript.js';
import { createGmailDraftTool } from './gmail-draft.js';
import { createGmailSendTool } from './gmail-send.js';
import { createUpdateEmailStyleTool } from './update-email-style.js';
import { isSalesforceConfigured } from '../salesforce/client.js';
import { allSfdcTools } from '../salesforce/tools/index.js';
import type { GranolaClientScope } from '../services/granola-client.js';

// ─── Intent types for conditional tool loading ───────────────────────────────

export type CalendarIntent = 'create' | null;

/** All 4 Granola MCP tools for meeting notes access. */
export function granolaTools(userId: string, scope?: GranolaClientScope) {
  return [
    createGranolaSearchMeetingsTool(userId, scope),
    createGranolaGetMeetingTool(userId, scope),
    createGranolaQueryTool(userId, scope),
    createGranolaTranscriptTool(userId, scope),
  ];
}

export function salesTools(
  userId: string,
  orgId: string | null,
  slackContext?: { channelId: string; threadTs: string; botToken?: string } | null,
  calendarIntent?: CalendarIntent,
  userTimezone?: string,
  scope?: GranolaClientScope,
) {
  const tools: DynamicStructuredTool<any>[] = [
    createGmailSearchTool(userId),
    createGmailReadTool(userId),
    createCalendarSearchTool(userId),
    createCalendarCreateTool(userId, userTimezone),
    createContactLookupTool(userId, orgId),
    createContextKBTool(userId, orgId),
    createGranolaSearchMeetingsTool(userId, scope),
    createGranolaGetMeetingTool(userId, scope),
    createGmailDraftTool({ userId, organizationId: orgId, slackContext: slackContext || undefined }),
    createUpdateEmailStyleTool(userId),
  ];

  // gmail-send is always available — the tool guards Slack API calls internally when botToken is empty
  tools.push(createGmailSendTool({ userId, organizationId: orgId, slackContext: slackContext || { channelId: '', threadTs: '', botToken: '' } }));

  if (orgId && isSalesforceConfigured()) {
    tools.push(...allSfdcTools(orgId));
  }

  return tools;
}

// ─── Sub-agent tool sets ──────────────────────────────────────────────────────

/** Calendar skill: search, create, update, delete. */
export function calendarAgentTools(
  userId: string,
  userTimezone?: string,
  slackContext?: { channelId: string; threadTs: string; botToken?: string } | null,
) {
  return [
    createCalendarSearchTool(userId),
    createCalendarCreateTool(userId, userTimezone),
    createCalendarUpdateTool(userId, userTimezone),
    createCalendarDeleteTool(userId, slackContext),
  ];
}

/** Transcript skill: fast Granola tools only (no granola_query). */
export function transcriptTools(userId: string, scope?: GranolaClientScope) {
  return [
    createGranolaSearchMeetingsTool(userId, scope),
    createGranolaGetMeetingTool(userId, scope),
  ];
}

/** Enablement skill: KB, docs, drive. */
export function enablementTools(userId: string, orgId: string | null) {
  return [
    createContextKBTool(userId, orgId),
    createShareableDocsTool(userId, orgId),
    createDriveSearchTool(userId),
  ];
}

/** Prospecting / research skill: web research, browsing, Slack history, conversations. */
export function prospectingTools(userId: string, _orgId: string | null, botToken: string) {
  const tools: DynamicStructuredTool<any>[] = [
    createExaResearchTool(),
    createWebBrowseTool(),
  ];

  // Slack tools require a valid bot token — skip for web/widget channels
  if (botToken) {
    tools.push(
      createSlackHistoryTool(botToken),
      createSlackSendDmTool(botToken),
      createSlackGroupChatTool(botToken),
      createSlackInviteToChannelTool(botToken),
      createSlackMentionInThreadTool(botToken),
    );
  }

  return tools;
}
