import { describe, it, expect } from "vitest";
import { CalendarApiError, CalendarClient, ownerCalendars } from "./calendar-api.js";

function fakeFetch(
  responder: (url: string, init: RequestInit) => {
    ok: boolean;
    status?: number;
    headers?: Record<string, string>;
    body: unknown;
  },
): { fetchFn: typeof fetch; calls: Array<{ url: string; method: string; body?: string }> } {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const r = responder(url, init ?? {});
    const headers = new Map(Object.entries(r.headers ?? {}));
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      headers: { get: (k: string) => headers.get(k) ?? null } as Headers,
      json: async () => r.body,
      text: async () =>
        typeof r.body === "string" ? r.body : JSON.stringify(r.body),
    } as Response;
  };
  return { fetchFn, calls };
}

describe("CalendarClient — wire layer", () => {
  it("listEvents builds the right URL with timeMin/timeMax + defaults", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({
      ok: true,
      body: { items: [] },
    }));
    const c = new CalendarClient({
      email: "leo@taiv.tv",
      fetchFn,
      tokenOverride: "t",
    });
    await c.listEvents({
      timeMin: "2026-06-14T00:00:00Z",
      timeMax: "2026-06-15T00:00:00Z",
    });
    const url = calls[0]?.url ?? "";
    expect(url).toContain("/calendars/primary/events");
    expect(url).toContain("timeMin=2026-06-14T00");
    expect(url).toContain("timeMax=2026-06-15T00");
    // defaults
    expect(url).toContain("singleEvents=true");
    expect(url).toContain("orderBy=startTime");
  });

  it("uses the provided calendarId (URL-encoded)", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({
      ok: true,
      body: { items: [] },
    }));
    const c = new CalendarClient({
      email: "leo@taiv.tv",
      calendarId: "team@example.com",
      fetchFn,
      tokenOverride: "t",
    });
    await c.listEvents({
      timeMin: "2026-06-14T00:00:00Z",
      timeMax: "2026-06-15T00:00:00Z",
    });
    expect(calls[0]?.url).toContain("/calendars/team%40example.com/events");
  });

  it("listAllEvents paginates via nextPageToken", async () => {
    let n = 0;
    const { fetchFn } = fakeFetch(() => {
      n++;
      if (n === 1) {
        return {
          ok: true,
          body: {
            items: [{ id: "E1", start: {}, end: {} }],
            nextPageToken: "tok2",
          },
        };
      }
      return {
        ok: true,
        body: { items: [{ id: "E2", start: {}, end: {} }] },
      };
    });
    const c = new CalendarClient({
      email: "leo@taiv.tv",
      fetchFn,
      tokenOverride: "t",
    });
    const events = await c.listAllEvents({
      timeMin: "2026-06-14T00:00:00Z",
      timeMax: "2026-06-15T00:00:00Z",
    });
    expect(events.map((e) => e.id)).toEqual(["E1", "E2"]);
  });

  it("insertEvent POSTs JSON body to /events with sendUpdates flag", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({
      ok: true,
      body: { id: "E1", summary: "test", start: {}, end: {} },
    }));
    const c = new CalendarClient({
      email: "leo@taiv.tv",
      fetchFn,
      tokenOverride: "t",
    });
    await c.insertEvent({
      event: {
        summary: "test",
        start: { dateTime: "2026-06-14T15:00:00Z" },
        end: { dateTime: "2026-06-14T16:00:00Z" },
      },
      sendUpdates: "all",
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("sendUpdates=all");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.summary).toBe("test");
  });

  it("deleteEvent issues DELETE and tolerates 204 No Content", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({
      ok: true,
      status: 204,
      body: "",
    }));
    const c = new CalendarClient({
      email: "leo@taiv.tv",
      fetchFn,
      tokenOverride: "t",
    });
    await expect(c.deleteEvent({ eventId: "E1" })).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe("DELETE");
  });

  it("retries on 429 then succeeds", async () => {
    let n = 0;
    const { fetchFn } = fakeFetch(() => {
      n++;
      if (n === 1)
        return { ok: false, status: 429, headers: { "Retry-After": "0" }, body: {} };
      return { ok: true, body: { items: [] } };
    });
    const c = new CalendarClient({
      email: "leo@taiv.tv",
      fetchFn,
      tokenOverride: "t",
      maxRetries: 2,
    });
    await c.listEvents({
      timeMin: "2026-06-14T00:00:00Z",
      timeMax: "2026-06-15T00:00:00Z",
    });
    expect(n).toBe(2);
  });

  it("throws CalendarApiError on 4xx", async () => {
    const { fetchFn } = fakeFetch(() => ({
      ok: false,
      status: 404,
      body: { error: { code: 404, message: "Not Found" } },
    }));
    const c = new CalendarClient({
      email: "leo@taiv.tv",
      fetchFn,
      tokenOverride: "t",
      maxRetries: 0,
    });
    await expect(c.getEvent("E1")).rejects.toBeInstanceOf(CalendarApiError);
  });
});

// 2026-10-09: the meeting was already on leo@osyx.tech; the check read only the
// booking calendar and two cards for it saw a free slot.
describe("ownerCalendars", () => {
  const client = (calendarId: string, responder: Parameters<typeof fakeFetch>[0]) => {
    const f = fakeFetch(responder);
    return { c: new CalendarClient({ email: "me@x.com", calendarId, fetchFn: f.fetchFn, tokenOverride: "t", maxRetries: 0 }), calls: f.calls };
  };
  const window = { timeMin: "2026-10-16T00:00:00+08:00", timeMax: "2026-10-17T00:00:00+08:00" };

  it("reads every calendar and books on one", async () => {
    const book = client("primary", (_u, init) => ({ ok: true, body: init.method === "POST" ? { id: "new" } : { items: [{ id: "p" }] } }));
    const osyx = client("leo@osyx.tech", () => ({ ok: true, body: { items: [{ id: "qcs" }] } }));
    const cal = ownerCalendars(book.c, [osyx.c]);
    expect((await cal.listAllEvents(window)).map((e) => e.id)).toEqual(["p", "qcs"]);
    await cal.insertEvent({ event: { summary: "x", start: {}, end: {} } });
    expect(osyx.calls.every((c) => c.method === "GET")).toBe(true);
    expect(book.calls.some((c) => c.method === "POST")).toBe(true);
  });

  it("skips a calendar it cannot see, but not one that failed", async () => {
    const book = client("primary", () => ({ ok: true, body: { items: [] } }));
    const gone = client("old@x.com", () => ({ ok: false, status: 404, body: {} }));
    expect(await ownerCalendars(book.c, [gone.c]).listAllEvents(window)).toEqual([]);
    const broken = client("leo@osyx.tech", () => ({ ok: false, status: 400, body: {} }));
    await expect(ownerCalendars(book.c, [broken.c]).listAllEvents(window)).rejects.toThrow();
  });
});
