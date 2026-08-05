/**
 * Attio tool schema and validation tests.
 *
 * All tool factories require organizationId (and some take userEmail).
 * We pass a test org ID since these tests only validate schema shape,
 * not actual MCP connectivity.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttioCompanyLookupTool } from '../company-lookup.js';
import { createAttioListCompaniesTool } from '../list-companies.js';
import { createAttioPeopleLookupTool } from '../people-lookup.js';
import { createAttioDealsTool } from '../deals.js';
import { createAttioListsTool } from '../lists.js';
import { createAttioNotesTool } from '../notes.js';
import { createAttioTasksTool } from '../tasks.js';
import { createAttioUpdateDealTool } from '../update-deal.js';
import { createAttioCreateTaskTool } from '../create-task.js';
import { createAttioCreateNoteTool } from '../create-note.js';
import { createAttioCreateDealTool } from '../create-deal.js';
import { createAttioSearchEmailsTool } from '../search-emails.js';
import { createAttioSearchMeetingsTool } from '../search-meetings.js';
import { createAttioSearchCallsTool } from '../search-calls.js';
import { readAttioTools, writeAttioTools, allAttioTools } from '../index.js';

const TEST_ORG_ID = 'test-org-00000000-0000-0000-0000-000000000000';
const TEST_EMAIL = 'test@example.com';

// ─── Read tools ──────────────────────────────────────────────────────────

test('attio_company_lookup: tool has correct name and schema', () => {
  const tool = createAttioCompanyLookupTool(TEST_ORG_ID);
  assert.equal(tool.name, 'attio_company_lookup');
  assert.ok(tool.description.includes('company'));
  assert.ok(tool.schema.shape.companyName);
});

test('attio_list_companies: tool has correct name and schema', () => {
  const tool = createAttioListCompaniesTool(TEST_ORG_ID);
  assert.equal(tool.name, 'attio_list_companies');
  assert.ok(tool.description.includes('companies'));
  assert.ok(tool.schema.shape.query);
});

test('attio_people_lookup: tool has correct name and schema', () => {
  const tool = createAttioPeopleLookupTool(TEST_ORG_ID);
  assert.equal(tool.name, 'attio_people_lookup');
  assert.ok(tool.description.includes('people'));
  assert.ok(tool.schema.shape.query);
});

test('attio_deals: tool has correct name and schema', () => {
  const tool = createAttioDealsTool(TEST_ORG_ID);
  assert.equal(tool.name, 'attio_deals');
  assert.ok(tool.description.includes('deals'));
  assert.ok(tool.schema.shape.dealName);
});

test('attio_lists: tool has correct name and schema', () => {
  const tool = createAttioListsTool(TEST_ORG_ID);
  assert.equal(tool.name, 'attio_lists');
  assert.ok(tool.description.includes('list'));
  assert.ok(tool.schema.shape.query);
  assert.ok(tool.schema.shape.listName);
});

test('attio_notes: tool has correct name and schema', () => {
  const tool = createAttioNotesTool(TEST_ORG_ID);
  assert.equal(tool.name, 'attio_notes');
  assert.ok(tool.description.includes('notes'));
  assert.ok(tool.schema.shape.query);
  assert.ok(tool.schema.shape.parentObject);
  assert.ok(tool.schema.shape.parentRecordId);
});

test('attio_tasks: tool has correct name and schema', () => {
  const tool = createAttioTasksTool(TEST_ORG_ID);
  assert.equal(tool.name, 'attio_tasks');
  assert.ok(tool.description.includes('tasks'));
  assert.ok(tool.schema.shape.query);
});

test('attio_search_emails: tool has correct name and schema', () => {
  const tool = createAttioSearchEmailsTool(TEST_ORG_ID);
  assert.equal(tool.name, 'attio_search_emails');
  assert.ok(tool.description.includes('email'));
  assert.ok(tool.schema.shape.query);
});

test('attio_search_meetings: tool has correct name and schema', () => {
  const tool = createAttioSearchMeetingsTool(TEST_ORG_ID);
  assert.equal(tool.name, 'attio_search_meetings');
  assert.ok(tool.description.includes('meeting'));
  assert.ok(tool.schema.shape.query);
});

test('attio_search_calls: tool has correct name and schema', () => {
  const tool = createAttioSearchCallsTool(TEST_ORG_ID);
  assert.equal(tool.name, 'attio_search_calls');
  assert.ok(tool.description.includes('call'));
  assert.ok(tool.schema.shape.query);
});

// ─── Write tools ─────────────────────────────────────────────────────────────

test('attio_update_deal: tool has correct name and schema', () => {
  const tool = createAttioUpdateDealTool(TEST_ORG_ID);
  assert.equal(tool.name, 'attio_update_deal');
  assert.ok(tool.description.includes('Update'));
  assert.ok(tool.schema.shape.dealName);
  assert.ok(tool.schema.shape.stage);
  assert.ok(tool.schema.shape.value);
  assert.ok(tool.schema.shape.closeDate);
});

test('attio_update_deal: returns error when no fields to update', async () => {
  const tool = createAttioUpdateDealTool(TEST_ORG_ID);
  const result = await tool.func(
    { dealName: 'Test Deal', stage: undefined, value: undefined, closeDate: undefined },
    { configurable: {} } as any,
  );
  const parsed = JSON.parse(result);
  assert.ok(parsed.error);
});

test('attio_create_deal: tool has correct name and schema', () => {
  const tool = createAttioCreateDealTool(TEST_ORG_ID, TEST_EMAIL);
  assert.equal(tool.name, 'attio_create_deal');
  assert.ok(tool.description.includes('deal'));
  assert.ok(tool.schema.shape.name);
  assert.ok(tool.schema.shape.stage);
  assert.ok(tool.schema.shape.value);
  assert.ok(tool.schema.shape.companyName);
});

test('attio_create_task: tool has correct name and schema', () => {
  const tool = createAttioCreateTaskTool(TEST_ORG_ID);
  assert.equal(tool.name, 'attio_create_task');
  assert.ok(tool.description.includes('task'));
  assert.ok(tool.schema.shape.content);
  assert.ok(tool.schema.shape.deadline);
  assert.ok(tool.schema.shape.linkedRecordName);
});

test('attio_create_note: tool has correct name and schema', () => {
  const tool = createAttioCreateNoteTool(TEST_ORG_ID);
  assert.equal(tool.name, 'attio_create_note');
  assert.ok(tool.description.includes('note'));
  const noteSchema = (tool.schema as any)._def.schema;
  assert.ok(noteSchema.shape.title);
  assert.ok(noteSchema.shape.content);
  assert.ok(noteSchema.shape.parentObject);
  assert.ok(noteSchema.shape.parentRecordId);
});

// ─── Tool registry ───────────────────────────────────────────────────────────

test('readAttioTools returns 10 read-only tools', () => {
  const tools = readAttioTools(TEST_ORG_ID);
  assert.equal(tools.length, 10);
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('attio_company_lookup'));
  assert.ok(names.includes('attio_list_companies'));
  assert.ok(names.includes('attio_people_lookup'));
  assert.ok(names.includes('attio_deals'));
  assert.ok(names.includes('attio_lists'));
  assert.ok(names.includes('attio_notes'));
  assert.ok(names.includes('attio_tasks'));
  assert.ok(names.includes('attio_search_emails'));
  assert.ok(names.includes('attio_search_meetings'));
  assert.ok(names.includes('attio_search_calls'));
});

test('writeAttioTools returns 4 write tools', () => {
  const tools = writeAttioTools(TEST_ORG_ID, TEST_EMAIL);
  assert.equal(tools.length, 4);
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('attio_update_deal'));
  assert.ok(names.includes('attio_create_deal'));
  assert.ok(names.includes('attio_create_task'));
  assert.ok(names.includes('attio_create_note'));
});

test('allAttioTools returns all 14 tools', () => {
  const tools = allAttioTools(TEST_ORG_ID, TEST_EMAIL);
  assert.equal(tools.length, 14);
});

test('all Attio tools have unique names', () => {
  const tools = allAttioTools(TEST_ORG_ID, TEST_EMAIL);
  const names = tools.map((t) => t.name);
  const uniqueNames = new Set(names);
  assert.equal(names.length, uniqueNames.size, `Duplicate tool names found: ${names}`);
});

test('all Attio tools have non-empty descriptions', () => {
  const tools = allAttioTools(TEST_ORG_ID, TEST_EMAIL);
  for (const tool of tools) {
    assert.ok(tool.description.length > 10, `Tool "${tool.name}" has a short/empty description`);
  }
});
