/**
 * SFDC tool schema and validation tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSfdcAccountLookupTool } from '../account-lookup.js';
import { createSfdcOpportunitiesTool } from '../opportunities.js';
import { createSfdcContactsTool } from '../contacts.js';
import { createSfdcLeadsTool } from '../leads.js';
import { createSfdcCasesTool } from '../cases.js';
import { createSfdcTasksEventsTool } from '../tasks-events.js';
import { createSfdcNotesTool } from '../notes.js';
import { createSfdcReportsTool } from '../reports.js';
import { createSfdcUpdateOpportunityTool } from '../update-opportunity.js';
import { createSfdcCreateTaskTool } from '../create-task.js';
import { createSfdcCreateOpportunityTool } from '../create-opportunity.js';
import { createSfdcLogActivityTool } from '../log-activity.js';
import { readSfdcTools, writeSfdcTools, allSfdcTools } from '../index.js';

// ─── Existing tools ──────────────────────────────────────────────────────────

test('sfdc_account_lookup: tool has correct name and schema', () => {
  const tool = createSfdcAccountLookupTool();
  assert.equal(tool.name, 'sfdc_account_lookup');
  assert.ok(tool.description.includes('Salesforce'));
  assert.ok(tool.schema.shape.accountName);
});

test('sfdc_opportunities: tool has correct name and schema', () => {
  const tool = createSfdcOpportunitiesTool();
  assert.equal(tool.name, 'sfdc_opportunities');
  assert.ok(tool.description.includes('opportunities'));
  assert.ok(tool.schema.shape.accountId);
  assert.ok(tool.schema.shape.accountName);
});

test('sfdc_opportunities: returns error when no input provided', async () => {
  const tool = createSfdcOpportunitiesTool();
  const result = await tool.func({ accountId: undefined, accountName: undefined }, { configurable: {} } as any);
  const parsed = JSON.parse(result);
  assert.ok(parsed.error);
  assert.equal(parsed.results.length, 0);
});

// ─── New read tools ──────────────────────────────────────────────────────────

test('sfdc_contacts: tool has correct name and schema', () => {
  const tool = createSfdcContactsTool();
  assert.equal(tool.name, 'sfdc_contacts');
  assert.ok(tool.description.includes('contacts'));
  assert.ok(tool.schema.shape.contactName);
  assert.ok(tool.schema.shape.email);
  assert.ok(tool.schema.shape.accountId);
  assert.ok(tool.schema.shape.accountName);
  assert.ok(tool.schema.shape.title);
});

test('sfdc_contacts: returns error when no input provided', async () => {
  const tool = createSfdcContactsTool();
  const result = await tool.func(
    { contactName: undefined, email: undefined, accountId: undefined, accountName: undefined, title: undefined },
    { configurable: {} } as any,
  );
  const parsed = JSON.parse(result);
  assert.ok(parsed.error);
  assert.deepEqual(parsed.results, []);
});

test('sfdc_leads: tool has correct name and schema', () => {
  const tool = createSfdcLeadsTool();
  assert.equal(tool.name, 'sfdc_leads');
  assert.ok(tool.description.includes('leads'));
  assert.ok(tool.schema.shape.leadName);
  assert.ok(tool.schema.shape.company);
  assert.ok(tool.schema.shape.email);
  assert.ok(tool.schema.shape.status);
});

test('sfdc_leads: returns error when no input provided', async () => {
  const tool = createSfdcLeadsTool();
  const result = await tool.func(
    { leadName: undefined, company: undefined, email: undefined, status: undefined },
    { configurable: {} } as any,
  );
  const parsed = JSON.parse(result);
  assert.ok(parsed.error);
  assert.deepEqual(parsed.results, []);
});

test('sfdc_cases: tool has correct name and schema', () => {
  const tool = createSfdcCasesTool();
  assert.equal(tool.name, 'sfdc_cases');
  assert.ok(tool.description.includes('cases'));
  assert.ok(tool.schema.shape.accountId);
  assert.ok(tool.schema.shape.accountName);
  assert.ok(tool.schema.shape.contactId);
  assert.ok(tool.schema.shape.status);
  assert.ok(tool.schema.shape.caseNumber);
});

test('sfdc_cases: returns error when no input provided', async () => {
  const tool = createSfdcCasesTool();
  const result = await tool.func(
    { accountId: undefined, accountName: undefined, contactId: undefined, status: undefined, caseNumber: undefined },
    { configurable: {} } as any,
  );
  const parsed = JSON.parse(result);
  assert.ok(parsed.error);
  assert.deepEqual(parsed.results, []);
});

test('sfdc_tasks_events: tool has correct name and schema', () => {
  const tool = createSfdcTasksEventsTool();
  assert.equal(tool.name, 'sfdc_tasks_events');
  assert.ok(tool.description.includes('tasks'));
  assert.ok(tool.schema.shape.whatId);
  assert.ok(tool.schema.shape.whoId);
  assert.ok(tool.schema.shape.accountName);
});

test('sfdc_tasks_events: returns error when no input provided', async () => {
  const tool = createSfdcTasksEventsTool();
  const result = await tool.func(
    { whatId: undefined, whoId: undefined, accountName: undefined, status: undefined, type: 'both', includeCompleted: false },
    { configurable: {} } as any,
  );
  const parsed = JSON.parse(result);
  assert.ok(parsed.error);
  assert.deepEqual(parsed.results, { tasks: [], events: [] });
});

test('sfdc_notes: tool has correct name and schema', () => {
  const tool = createSfdcNotesTool();
  assert.equal(tool.name, 'sfdc_notes');
  assert.ok(tool.description.includes('notes'));
  assert.ok(tool.schema.shape.parentId);
  assert.ok(tool.schema.shape.searchText);
});

test('sfdc_reports: tool has correct name and schema', () => {
  const tool = createSfdcReportsTool();
  assert.equal(tool.name, 'sfdc_reports');
  assert.ok(tool.description.includes('reports'));
  assert.ok(tool.schema.shape.action);
  assert.ok(tool.schema.shape.reportName);
  assert.ok(tool.schema.shape.reportId);
});

// ─── Write tools ─────────────────────────────────────────────────────────────

test('sfdc_update_opportunity: tool has correct name and schema', () => {
  const tool = createSfdcUpdateOpportunityTool();
  assert.equal(tool.name, 'sfdc_update_opportunity');
  assert.ok(tool.description.includes('Update'));
  assert.ok(tool.schema.shape.opportunityId);
  assert.ok(tool.schema.shape.stageName);
  assert.ok(tool.schema.shape.amount);
  assert.ok(tool.schema.shape.closeDate);
  assert.ok(tool.schema.shape.nextStep);
  assert.ok(tool.schema.shape.probability);
});

test('sfdc_update_opportunity: returns error when no fields to update', async () => {
  const tool = createSfdcUpdateOpportunityTool();
  const result = await tool.func(
    { opportunityId: '006abc', stageName: undefined, amount: undefined, closeDate: undefined, nextStep: undefined, description: undefined, probability: undefined },
    { configurable: {} } as any,
  );
  const parsed = JSON.parse(result);
  assert.ok(parsed.error);
});

test('sfdc_create_task: tool has correct name and schema', () => {
  const tool = createSfdcCreateTaskTool();
  assert.equal(tool.name, 'sfdc_create_task');
  assert.ok(tool.description.includes('task'));
  assert.ok(tool.schema.shape.subject);
  assert.ok(tool.schema.shape.whatId);
  assert.ok(tool.schema.shape.whoId);
  assert.ok(tool.schema.shape.dueDate);
  assert.ok(tool.schema.shape.priority);
  assert.ok(tool.schema.shape.status);
});

test('sfdc_create_opportunity: tool has correct name and schema', () => {
  const tool = createSfdcCreateOpportunityTool('test-org');
  assert.equal(tool.name, 'sfdc_create_opportunity');
  assert.ok(tool.description.includes('Opportunity') || tool.description.includes('deal'));
  assert.ok(tool.schema.shape.opportunityName);
  assert.ok(tool.schema.shape.stageName);
  assert.ok(tool.schema.shape.closeDate);
  assert.ok(tool.schema.shape.accountName);
  assert.ok(tool.schema.shape.amount);
  assert.ok(tool.schema.shape.probability);
});

test('sfdc_log_activity: tool has correct name and schema', () => {
  const tool = createSfdcLogActivityTool();
  assert.equal(tool.name, 'sfdc_log_activity');
  assert.ok(tool.description.includes('activity'));
  assert.ok(tool.schema.shape.activityType);
  assert.ok(tool.schema.shape.subject);
  assert.ok(tool.schema.shape.whatId);
  assert.ok(tool.schema.shape.whoId);
  assert.ok(tool.schema.shape.description);
  assert.ok(tool.schema.shape.activityDate);
});

// ─── Tool registry ───────────────────────────────────────────────────────────

const TEST_ORG_ID = 'test-org-id';

test('readSfdcTools returns 9 read-only tools', () => {
  const tools = readSfdcTools(TEST_ORG_ID);
  assert.equal(tools.length, 9);
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('sfdc_account_lookup'));
  assert.ok(names.includes('sfdc_list_accounts'));
  assert.ok(names.includes('sfdc_opportunities'));
  assert.ok(names.includes('sfdc_contacts'));
  assert.ok(names.includes('sfdc_leads'));
  assert.ok(names.includes('sfdc_cases'));
  assert.ok(names.includes('sfdc_tasks_events'));
  assert.ok(names.includes('sfdc_notes'));
  assert.ok(names.includes('sfdc_reports'));
});

test('writeSfdcTools returns 13 write tools', () => {
  const tools = writeSfdcTools(TEST_ORG_ID);
  assert.equal(tools.length, 13);
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('sfdc_update_opportunity'));
  assert.ok(names.includes('sfdc_create_opportunity'));
  assert.ok(names.includes('sfdc_create_task'));
  assert.ok(names.includes('sfdc_log_activity'));
});

test('allSfdcTools returns all 22 tools', () => {
  const tools = allSfdcTools(TEST_ORG_ID);
  assert.equal(tools.length, 22);
});

test('all tools have unique names', () => {
  const tools = allSfdcTools(TEST_ORG_ID);
  const names = tools.map((t) => t.name);
  const uniqueNames = new Set(names);
  assert.equal(names.length, uniqueNames.size, `Duplicate tool names found: ${names}`);
});

test('all tools have non-empty descriptions', () => {
  const tools = allSfdcTools(TEST_ORG_ID);
  for (const tool of tools) {
    assert.ok(tool.description.length > 10, `Tool "${tool.name}" has a short/empty description`);
  }
});
