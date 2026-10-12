import { describe, it, expect } from "vitest";
import { buildSameMeetingRequest, comparableEvents, parseSameMeeting } from "./same-meeting.js";
import type { CalendarEvent } from "../io/calendar-api.js";

const invite: CalendarEvent = {
  id: "_60q30c1g60o30e1i",
  summary: "OSYX SoW and Contact review",
  start: { dateTime: "2026-10-12T14:30:00+08:00" },
  end: { dateTime: "2026-10-12T15:00:00+08:00" },
  organizer: { email: "wei.du.ks@renesas.com", displayName: "Wei Du" },
};

describe("comparableEvents", () => {
  it("drops TickTick mirrors, all-day items and cancelled events", () => {
    const mirror = { ...invite, id: "6ac9fb558f0866cdaa7d5a93", summary: "Join online call with 瑞萨" };
    const daily = { ...invite, id: "6a7deddb8f08538b410d6b79_20261012" };
    const allDay = { ...invite, id: "x1", start: { date: "2026-10-12" }, end: { date: "2026-10-13" } };
    const gone = { ...invite, id: "x2", status: "cancelled" as const };
    expect(comparableEvents([invite, mirror, daily, allDay, gone])).toEqual([invite]);
  });
});

describe("same meeting", () => {
  it("shows the model the organizer, so 「duwei」 can meet Wei Du", () => {
    const req = buildSameMeetingRequest(
      { title: "与金小奇视频会议（古龙参加，duwei线上）", start: "2026-10-12T13:00", end: "2026-10-12T14:00", said: "那我先约周一下午 1 点", people: ["金小奇 芯联集成 (wechat id qh_jin)"] },
      [invite],
    );
    expect(req.userText).toContain("E1. OSYX SoW and Contact review");
    expect(req.userText).toContain("Wei Du");
    expect(req.userText).toContain("duwei");
    expect(req.userText).toContain("conversation with: 金小奇 芯联集成 (wechat id qh_jin)");
  });

  it("accepts only an event it was shown", () => {
    expect(parseSameMeeting({ event: "E1" }, [invite])).toBe(invite);
    expect(parseSameMeeting({ event: "E2" }, [invite])).toBeNull();
    expect(parseSameMeeting({ event: "none" }, [invite])).toBeNull();
    expect(parseSameMeeting(null, [invite])).toBeNull();
  });
});
