// Google Calendar v3 wire layer. Per-mailbox calendar client driven by
// the OAuth token in Keychain (relay/io/google-oauth.ts). Spec position:
// Calendar is an EXECUTOR TARGET, not a scan source — the secretary
// queries it for conflict-check before booking an event, and writes to
// it via events.insert after the user approves.
//
// Endpoints wrapped:
//   - listEvents (events.list with timeMin/timeMax)
//   - getEvent (events.get)
//   - insertEvent (events.insert)
//   - deleteEvent (events.delete) — included so the executor can
//     undo on retry, not used in the v1 happy path
//
// Retry policy mirrors GmailClient (429/5xx with Retry-After). Serial
// per-client to stay under the per-user quota.

import { getBearerToken } from "./google-oauth.js";

export const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

export class CalendarApiError extends Error {
  constructor(
    public path: string,
    public httpStatus: number,
    public body: unknown,
  ) {
    super(`Calendar ${path} failed: HTTP ${httpStatus}`);
    this.name = "CalendarApiError";
  }
}

// ─── shapes (subset; only what the secretary touches) ──────────────

export interface CalendarEventDateTime {
  dateTime?: string; // RFC 3339, e.g. "2026-06-14T15:00:00-05:00"
  date?: string; // YYYY-MM-DD for all-day events
  timeZone?: string;
}

export interface CalendarEventAttendee {
  email: string;
  displayName?: string;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
  organizer?: boolean;
  self?: boolean;
  optional?: boolean;
}

export interface CalendarEvent {
  id?: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  start: CalendarEventDateTime;
  end: CalendarEventDateTime;
  attendees?: CalendarEventAttendee[];
  organizer?: { email: string; displayName?: string; self?: boolean };
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: unknown;
  recurringEventId?: string;
  // Marks events the user marked as not-busy. conflict-check ignores
  // these so a "free time" block doesn't read as a conflict.
  transparency?: "opaque" | "transparent";
  // Marks events the user has explicitly declined. conflict-check
  // should treat these as non-blocking.
  attendeesOmitted?: boolean;
  visibility?: string;
  iCalUID?: string;
  // Notification reminders. useDefault:false + overrides lets us set explicit
  // popup/email reminders on create (Google honors these in the events.insert
  // body). Omitted → the calendar's default reminders apply.
  reminders?: {
    useDefault?: boolean;
    overrides?: Array<{ method: "popup" | "email"; minutes: number }>;
  };
}

export interface CalendarEventsListResponse {
  kind?: string;
  etag?: string;
  summary?: string;
  description?: string;
  updated?: string;
  timeZone?: string;
  nextPageToken?: string;
  nextSyncToken?: string;
  items: CalendarEvent[];
}

// ─── client ────────────────────────────────────────────────────────

export interface CalendarClientOptions {
  email: string;
  // Default: "primary" (the user's main calendar). Override for shared cals.
  calendarId?: string;
  fetchFn?: typeof fetch;
  baseUrl?: string;
  maxRetries?: number;
  // Pass a fixed token for tests; prod uses getBearerToken(email).
  tokenOverride?: string;
}

export class CalendarClient {
  readonly email: string;
  readonly calendarId: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly maxRetries: number;
  private readonly tokenOverride?: string;
  private inFlight: Promise<unknown> = Promise.resolve();

  constructor(opts: CalendarClientOptions) {
    this.email = opts.email;
    this.calendarId = opts.calendarId ?? "primary";
    this.baseUrl = opts.baseUrl ?? CALENDAR_API_BASE;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.tokenOverride = opts.tokenOverride;
  }

  private async token(): Promise<string> {
    if (this.tokenOverride !== undefined) return this.tokenOverride;
    return getBearerToken(this.email);
  }

  private async call<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const result = this.inFlight.then(() => this.callRaw<T>(method, path, body));
    this.inFlight = result.catch(() => undefined);
    return result;
  }

  private async callRaw<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${await this.token()}`,
      };
      let payload: BodyInit | undefined;
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        payload = JSON.stringify(body);
      }
      const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
      const resp = await this.fetchFn(url, { method, headers, body: payload });
      if (resp.status === 429 || resp.status >= 500) {
        const retryAfterHeader = resp.headers.get("Retry-After");
        const wait = retryAfterHeader
          ? parseFloat(retryAfterHeader) * 1000
          : 2000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, Math.min(wait, 30_000)));
        lastErr = new Error(`Calendar ${path} HTTP ${resp.status}`);
        continue;
      }
      if (!resp.ok) {
        let errBody: unknown = null;
        try {
          errBody = await resp.json();
        } catch {
          errBody = await resp.text();
        }
        throw new CalendarApiError(path, resp.status, errBody);
      }
      // events.delete returns 204 No Content — caller's T is `void`
      if (resp.status === 204) return undefined as T;
      return (await resp.json()) as T;
    }
    throw lastErr ?? new Error(`Calendar ${path} exhausted retries`);
  }

  // ─── typed endpoints ──────────────────────────────────────────

  // List events on this calendar in [timeMin, timeMax). Always orders
  // by start time + expands single occurrences out of recurring rules,
  // because that's the only shape conflict-check needs to reason about.
  async listEvents(opts: {
    timeMin: string; // RFC 3339
    timeMax: string;
    singleEvents?: boolean; // default true
    orderBy?: "startTime" | "updated"; // default startTime
    showDeleted?: boolean;
    q?: string; // free-text search
    maxResults?: number;
    pageToken?: string;
    timeZone?: string;
  }): Promise<CalendarEventsListResponse> {
    const qs = new URLSearchParams({
      timeMin: opts.timeMin,
      timeMax: opts.timeMax,
      singleEvents: String(opts.singleEvents ?? true),
      orderBy: opts.orderBy ?? "startTime",
      maxResults: String(opts.maxResults ?? 250),
    });
    if (opts.showDeleted) qs.set("showDeleted", "true");
    if (opts.q) qs.set("q", opts.q);
    if (opts.pageToken) qs.set("pageToken", opts.pageToken);
    if (opts.timeZone) qs.set("timeZone", opts.timeZone);
    return this.call(
      "GET",
      `/calendars/${encodeURIComponent(this.calendarId)}/events?${qs.toString()}`,
    );
  }

  async listAllEvents(opts: {
    timeMin: string;
    timeMax: string;
    timeZone?: string;
    q?: string;
  }): Promise<CalendarEvent[]> {
    let pageToken: string | undefined;
    const all: CalendarEvent[] = [];
    while (true) {
      const resp = await this.listEvents({ ...opts, pageToken });
      all.push(...resp.items);
      pageToken = resp.nextPageToken;
      if (!pageToken) break;
    }
    return all;
  }

  async getEvent(eventId: string): Promise<CalendarEvent> {
    return this.call(
      "GET",
      `/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(eventId)}`,
    );
  }

  // Create an event. The secretary's executor uses this AFTER the user
  // approves a `calendar` action item AND the conflict-check passes.
  async insertEvent(opts: {
    event: CalendarEvent;
    sendUpdates?: "all" | "externalOnly" | "none";
    // Must be 1 for a conferenceData.createRequest (Meet link) to be honored.
    conferenceDataVersion?: number;
  }): Promise<CalendarEvent> {
    const qs = new URLSearchParams();
    if (opts.sendUpdates) qs.set("sendUpdates", opts.sendUpdates);
    if (opts.conferenceDataVersion != null)
      qs.set("conferenceDataVersion", String(opts.conferenceDataVersion));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.call(
      "POST",
      `/calendars/${encodeURIComponent(this.calendarId)}/events${suffix}`,
      opts.event,
    );
  }

  async deleteEvent(opts: {
    eventId: string;
    sendUpdates?: "all" | "externalOnly" | "none";
  }): Promise<void> {
    const qs = new URLSearchParams();
    if (opts.sendUpdates) qs.set("sendUpdates", opts.sendUpdates);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    await this.call(
      "DELETE",
      `/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(opts.eventId)}${suffix}`,
    );
  }
}

// The calendar we BOOK on is one; the calendars a meeting may ALREADY be on
// are all of his. 2026-10-09: Qualcomm's 「OSYX QCS6490 Dual OS Demo」 sat on
// leo@osyx.tech while the check read only the booking calendar, so the two
// cards for that very meeting saw a free slot. Reads span every calendar;
// inserts go to the booking one. A calendar this token cannot see (403/404) is
// skipped; any other failure throws, so the card waits for the next tick
// rather than being booked against a half-read calendar.
export function ownerCalendars(book: CalendarClient, alsoRead: readonly CalendarClient[]) {
  return {
    async listAllEvents(opts: { timeMin: string; timeMax: string }): Promise<CalendarEvent[]> {
      const lists = await Promise.all([
        book.listAllEvents(opts),
        ...alsoRead.map((c) =>
          c.listAllEvents(opts).catch((e: unknown) => {
            if (e instanceof CalendarApiError && (e.httpStatus === 403 || e.httpStatus === 404)) return [];
            throw e;
          }),
        ),
      ]);
      return lists.flat();
    },
    insertEvent: (opts: Parameters<CalendarClient["insertEvent"]>[0]) => book.insertEvent(opts),
  };
}
