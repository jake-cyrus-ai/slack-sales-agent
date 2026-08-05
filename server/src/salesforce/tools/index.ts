/**
 * Salesforce tool registry — grouped by read vs. write operations.
 */

import { createSfdcAccountLookupTool } from './account-lookup.js';
import { createSfdcListAccountsTool } from './list-accounts.js';
import { createSfdcOpportunitiesTool } from './opportunities.js';
import { createSfdcContactsTool } from './contacts.js';
import { createSfdcLeadsTool } from './leads.js';
import { createSfdcCasesTool } from './cases.js';
import { createSfdcTasksEventsTool } from './tasks-events.js';
import { createSfdcNotesTool } from './notes.js';
import { createSfdcReportsTool } from './reports.js';
import { createSfdcUpdateOpportunityTool } from './update-opportunity.js';
import { createSfdcCreateTaskTool } from './create-task.js';
import { createSfdcCreateOpportunityTool } from './create-opportunity.js';
import { createSfdcLogActivityTool } from './log-activity.js';
import { createSfdcCreateAccountTool } from './create-account.js';
import { createSfdcCreateContactTool } from './create-contact.js';
import { createSfdcUpdateContactTool } from './update-contact.js';
import { createSfdcUpdateAccountTool } from './update-account.js';
import { createSfdcUpdateTaskTool } from './update-task.js';
import { createSfdcDeleteAccountTool } from './delete-account.js';
import { createSfdcDeleteContactTool } from './delete-contact.js';
import { createSfdcDeleteOpportunityTool } from './delete-opportunity.js';
import { createSfdcDeleteTaskTool } from './delete-task.js';

export function readSfdcTools(organizationId: string) {
  return [
    createSfdcAccountLookupTool(organizationId),
    createSfdcListAccountsTool(organizationId),
    createSfdcOpportunitiesTool(organizationId),
    createSfdcContactsTool(organizationId),
    createSfdcLeadsTool(organizationId),
    createSfdcCasesTool(organizationId),
    createSfdcTasksEventsTool(organizationId),
    createSfdcNotesTool(organizationId),
    createSfdcReportsTool(organizationId),
  ];
}

export function writeSfdcTools(organizationId: string, actorEmail?: string | null) {
  return [
    createSfdcUpdateOpportunityTool(organizationId, actorEmail),
    createSfdcCreateOpportunityTool(organizationId, actorEmail),
    createSfdcCreateTaskTool(organizationId, actorEmail),
    createSfdcLogActivityTool(organizationId, actorEmail),
    createSfdcCreateAccountTool(organizationId, actorEmail),
    createSfdcCreateContactTool(organizationId, actorEmail),
    createSfdcUpdateContactTool(organizationId, actorEmail),
    createSfdcUpdateAccountTool(organizationId, actorEmail),
    createSfdcUpdateTaskTool(organizationId, actorEmail),
    createSfdcDeleteAccountTool(organizationId),
    createSfdcDeleteContactTool(organizationId),
    createSfdcDeleteOpportunityTool(organizationId),
    createSfdcDeleteTaskTool(organizationId),
  ];
}

export function allSfdcTools(organizationId: string, actorEmail?: string | null) {
  return [...readSfdcTools(organizationId), ...writeSfdcTools(organizationId, actorEmail)];
}

export {
  createSfdcAccountLookupTool,
  createSfdcListAccountsTool,
  createSfdcOpportunitiesTool,
  createSfdcContactsTool,
  createSfdcLeadsTool,
  createSfdcCasesTool,
  createSfdcTasksEventsTool,
  createSfdcNotesTool,
  createSfdcReportsTool,
  createSfdcUpdateOpportunityTool,
  createSfdcCreateTaskTool,
  createSfdcCreateOpportunityTool,
  createSfdcLogActivityTool,
  createSfdcCreateAccountTool,
  createSfdcCreateContactTool,
  createSfdcUpdateContactTool,
  createSfdcUpdateAccountTool,
  createSfdcUpdateTaskTool,
  createSfdcDeleteAccountTool,
  createSfdcDeleteContactTool,
  createSfdcDeleteOpportunityTool,
  createSfdcDeleteTaskTool,
};
