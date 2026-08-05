/**
 * Attio tool registry — grouped by read vs. write operations.
 * All tools take organizationId to authenticate via MCP client.
 */

import { createAttioCompanyLookupTool } from './company-lookup.js';
import { createAttioListCompaniesTool } from './list-companies.js';
import { createAttioPeopleLookupTool } from './people-lookup.js';
import { createAttioDealsTool } from './deals.js';
import { createAttioListsTool } from './lists.js';
import { createAttioNotesTool } from './notes.js';
import { createAttioTasksTool } from './tasks.js';
import { createAttioUpdateDealTool } from './update-deal.js';
import { createAttioCreateTaskTool } from './create-task.js';
import { createAttioCreateNoteTool } from './create-note.js';
import { createAttioCreateDealTool } from './create-deal.js';
import { createAttioSearchEmailsTool } from './search-emails.js';
import { createAttioSearchMeetingsTool } from './search-meetings.js';
import { createAttioSearchCallsTool } from './search-calls.js';

export function readAttioTools(organizationId: string) {
  return [
    createAttioCompanyLookupTool(organizationId),
    createAttioListCompaniesTool(organizationId),
    createAttioPeopleLookupTool(organizationId),
    createAttioDealsTool(organizationId),
    createAttioListsTool(organizationId),
    createAttioNotesTool(organizationId),
    createAttioTasksTool(organizationId),
    createAttioSearchEmailsTool(organizationId),
    createAttioSearchMeetingsTool(organizationId),
    createAttioSearchCallsTool(organizationId),
  ];
}

export function writeAttioTools(organizationId: string, userEmail?: string | null) {
  return [
    createAttioUpdateDealTool(organizationId),
    createAttioCreateDealTool(organizationId, userEmail),
    createAttioCreateTaskTool(organizationId),
    createAttioCreateNoteTool(organizationId),
  ];
}

export function allAttioTools(organizationId: string, userEmail?: string | null) {
  return [...readAttioTools(organizationId), ...writeAttioTools(organizationId, userEmail)];
}

export {
  createAttioCompanyLookupTool,
  createAttioListCompaniesTool,
  createAttioPeopleLookupTool,
  createAttioDealsTool,
  createAttioListsTool,
  createAttioNotesTool,
  createAttioTasksTool,
  createAttioUpdateDealTool,
  createAttioCreateTaskTool,
  createAttioCreateNoteTool,
  createAttioSearchEmailsTool,
  createAttioSearchMeetingsTool,
  createAttioSearchCallsTool,
  createAttioCreateDealTool,
};
