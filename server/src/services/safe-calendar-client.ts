/**
 * CalendarClient — thin wrapper around the Google Calendar API client.
 *
 * Exposes all standard calendar operations: list, get, insert, update,
 * patch, and delete. Delete is gated at the tool layer via Slack button
 * confirmation, not here.
 */

import { calendar_v3 } from 'googleapis';

export class CalendarClient {
  private calendar: calendar_v3.Calendar;

  constructor(calendar: calendar_v3.Calendar) {
    this.calendar = calendar;
  }

  get events() {
    return {
      list: (params: calendar_v3.Params$Resource$Events$List) =>
        this.calendar.events.list(params),

      get: (params: calendar_v3.Params$Resource$Events$Get) =>
        this.calendar.events.get(params),

      insert: (params: calendar_v3.Params$Resource$Events$Insert) =>
        this.calendar.events.insert(params),

      update: (params: calendar_v3.Params$Resource$Events$Update) =>
        this.calendar.events.update(params),

      patch: (params: calendar_v3.Params$Resource$Events$Patch) =>
        this.calendar.events.patch(params),

      delete: (params: calendar_v3.Params$Resource$Events$Delete) =>
        this.calendar.events.delete(params),
    };
  }

  get calendarList() {
    return this.calendar.calendarList;
  }

  get freebusy() {
    return this.calendar.freebusy;
  }

  get colors() {
    return this.calendar.colors;
  }
}

/** @deprecated Use CalendarClient instead. */
export const SafeCalendarClient = CalendarClient;
