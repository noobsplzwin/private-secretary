import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFeishuMirror, loadMirrorMap, type MirrorCalendar } from "./feishu-mirror.js";
import type { FeishuEvent } from "../core/feishu-mirror.js";
import { CalendarApiError, type CalendarEvent } from "../io/calendar-api.js";

const NOW = Date.parse("2026-11-03T12:00:00-06:00");
const OTA: FeishuEvent = { id: "ota_0", summary: "小鹏-瑞萨-OSYX OTA方案技术细节澄清", start: "2026-11-05T06:00:00-06:00", end: "2026-11-05T06:30:00-06:00", url: "https://vc.feishu.cn/j/616218788", organizer: "余启业" };

let mapPath: string;
beforeEach(() => {
  mapPath = join(mkdtempSync(join(tmpdir(), "fm-")), "feishu-mirror.json");
});

const calendar = (existing: CalendarEvent[] = []) => {
  const insertEvent = vi.fn(async ({ event }: { event: CalendarEvent }) => ({ ...event, id: "g-new" }));
  const patchEvent = vi.fn(async () => ({ id: "x", start: {}, end: {} }) as CalendarEvent);
  const deleteEvent = vi.fn(async () => {});
  const cal: MirrorCalendar = { listAllEvents: async () => existing, insertEvent, patchEvent, deleteEvent };
  return { cal, insertEvent, patchEvent, deleteEvent };
};

describe("runFeishuMirror", () => {
  it("books a new Feishu meeting with its link, emailing nobody, and remembers it", async () => {
    const { cal, insertEvent } = calendar();
    const r = await runFeishuMirror({ fetchAgenda: async () => [OTA], calendar: cal, mapPath, nowMs: NOW });
    expect(r.created).toEqual([OTA.summary]);
    expect(insertEvent).toHaveBeenCalledWith(expect.objectContaining({ sendUpdates: "none" }));
    expect((insertEvent.mock.calls[0]![0] as { event: CalendarEvent }).event.location).toBe(OTA.url);
    expect(loadMirrorMap(mapPath)).toMatchObject({ ota_0: { googleId: "g-new" } });
    // A second pass writes nothing.
    const again = await runFeishuMirror({ fetchAgenda: async () => [OTA], calendar: cal, mapPath, nowMs: NOW });
    expect(again.created).toEqual([]);
    expect(insertEvent).toHaveBeenCalledTimes(1);
  });

  it("adopts the same meeting already booked, and never books a TickTick mirror's twin", async () => {
    const manual: CalendarEvent = { id: "manual", summary: "OTA", location: OTA.url, start: { dateTime: "2026-11-05T12:00:00Z" }, end: { dateTime: "2026-11-05T12:30:00Z" } };
    const { cal, insertEvent } = calendar([manual]);
    const r = await runFeishuMirror({ fetchAgenda: async () => [OTA], calendar: cal, mapPath, nowMs: NOW });
    expect(r.adopted).toEqual([OTA.summary]);
    expect(insertEvent).not.toHaveBeenCalled();
    // A TickTick mirror with the same title at the same minute is not a meeting.
    const mirror: CalendarEvent = { ...manual, id: "6ac9fb558f0866cdaa7d5a93", location: undefined, summary: OTA.summary };
    const t = calendar([mirror]);
    const r2 = await runFeishuMirror({ fetchAgenda: async () => [OTA], calendar: t.cal, mapPath: mapPath + "2", nowMs: NOW });
    expect(r2.created).toEqual([OTA.summary]);
  });

  it("follows a move and a cancellation; an event he already deleted counts as removed", async () => {
    const { cal, patchEvent, deleteEvent } = calendar();
    await runFeishuMirror({ fetchAgenda: async () => [OTA], calendar: cal, mapPath, nowMs: NOW });
    await runFeishuMirror({ fetchAgenda: async () => [{ ...OTA, start: "2026-11-05T07:00:00-06:00", end: "2026-11-05T07:30:00-06:00" }], calendar: cal, mapPath, nowMs: NOW });
    expect(patchEvent).toHaveBeenCalledTimes(1);
    deleteEvent.mockRejectedValueOnce(new CalendarApiError("events/g-new", 410, null));
    const r = await runFeishuMirror({ fetchAgenda: async () => [], calendar: cal, mapPath, nowMs: NOW });
    expect(r.removed).toEqual(["g-new"]);
    expect(r.errors).toEqual([]);
    expect(JSON.parse(readFileSync(mapPath, "utf8"))).toEqual({});
  });

  it("a Feishu read that fails writes nothing", async () => {
    const { cal, insertEvent, deleteEvent } = calendar();
    await expect(runFeishuMirror({ fetchAgenda: async () => { throw new Error("lark-cli down"); }, calendar: cal, mapPath, nowMs: NOW })).rejects.toThrow("lark-cli down");
    expect(insertEvent).not.toHaveBeenCalled();
    expect(deleteEvent).not.toHaveBeenCalled();
  });
});
