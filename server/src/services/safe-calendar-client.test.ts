import test from 'node:test';
import assert from 'node:assert/strict';
import { CalendarClient } from './safe-calendar-client.js';

/** Minimal mock of calendar_v3.Calendar with just the events resource. */
function makeMockCalendar() {
  const calls: { method: string; params: unknown }[] = [];
  return {
    calls,
    events: {
      list: (params: unknown) => { calls.push({ method: 'list', params }); return Promise.resolve({ data: { items: [] } }); },
      get: (params: unknown) => { calls.push({ method: 'get', params }); return Promise.resolve({ data: {} }); },
      insert: (params: unknown) => { calls.push({ method: 'insert', params }); return Promise.resolve({ data: {} }); },
      update: (params: unknown) => { calls.push({ method: 'update', params }); return Promise.resolve({ data: {} }); },
      patch: (params: unknown) => { calls.push({ method: 'patch', params }); return Promise.resolve({ data: {} }); },
      delete: (params: unknown) => { calls.push({ method: 'delete', params }); return Promise.resolve({}); },
    },
    calendarList: { list: () => Promise.resolve({ data: {} }) },
    freebusy: { query: () => Promise.resolve({ data: {} }) },
    colors: { get: () => Promise.resolve({ data: {} }) },
  };
}

test('CalendarClient — events.list passes through to real client', async () => {
  const mock = makeMockCalendar();
  const client = new CalendarClient(mock as any);
  const params = { calendarId: 'primary' };

  await client.events.list(params as any);

  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].method, 'list');
  assert.deepEqual(mock.calls[0].params, params);
});

test('CalendarClient — events.get passes through to real client', async () => {
  const mock = makeMockCalendar();
  const client = new CalendarClient(mock as any);
  const params = { calendarId: 'primary', eventId: 'abc123' };

  await client.events.get(params as any);

  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].method, 'get');
});

test('CalendarClient — events.insert passes through to real client', async () => {
  const mock = makeMockCalendar();
  const client = new CalendarClient(mock as any);
  const params = { calendarId: 'primary', requestBody: { summary: 'Test Event' } };

  await client.events.insert(params as any);

  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].method, 'insert');
});

test('CalendarClient — events.update passes through to real client', async () => {
  const mock = makeMockCalendar();
  const client = new CalendarClient(mock as any);
  const params = { calendarId: 'primary', eventId: 'abc123', requestBody: { summary: 'Updated' } };

  await client.events.update(params as any);

  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].method, 'update');
});

test('CalendarClient — events.patch passes through to real client', async () => {
  const mock = makeMockCalendar();
  const client = new CalendarClient(mock as any);
  const params = { calendarId: 'primary', eventId: 'abc123', requestBody: { summary: 'Patched' } };

  await client.events.patch(params as any);

  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].method, 'patch');
});

test('CalendarClient — events.delete passes through to real client', async () => {
  const mock = makeMockCalendar();
  const client = new CalendarClient(mock as any);
  const params = { calendarId: 'primary', eventId: 'abc123' };

  await client.events.delete(params as any);

  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].method, 'delete');
  assert.deepEqual(mock.calls[0].params, params);
});

test('CalendarClient — calendarList, freebusy, colors pass through', () => {
  const mock = makeMockCalendar();
  const client = new CalendarClient(mock as any);

  assert.equal(client.calendarList, mock.calendarList);
  assert.equal(client.freebusy, mock.freebusy);
  assert.equal(client.colors, mock.colors);
});
