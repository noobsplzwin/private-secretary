import { describe, it, expect } from "vitest";
import { existingFor, googleEventFor, mirrorHash, parseAgenda, planMirror, type FeishuEvent } from "./feishu-mirror.js";
import type { CalendarEvent } from "../io/calendar-api.js";

// Shaped like `lark-cli calendar +agenda --as user`, 2026-11-03.
const AGENDA = {
  ok: true,
  data: [
    {
      event_id: "32b4bf19_0",
      summary: "冉朱旭同学面试",
      start_time: { datetime: "2026-11-03T19:00:00-06:00", timezone: "Asia/Shanghai" },
      end_time: { datetime: "2026-11-03T20:30:00-06:00", timezone: "Asia/Shanghai" },
      vchat: { meeting_url: "https://vc.feishu.cn/j/609620959", vc_type: "vc" },
      event_organizer: { display_name: "陈古龙" },
      self_rsvp_status: "accept",
      app_link: "https://applink.feishu.cn/client/calendar/event/detail?key=32b4bf19",
    },
    { event_id: "osyx_0", summary: "OSyx交流", start_time: { datetime: "2026-11-05T06:00:00-06:00" }, end_time: { datetime: "2026-11-05T07:00:00-06:00" }, vchat: { meeting_url: "https://vc.feishu.cn/j/111222333" }, self_rsvp_status: "needs_action" },
    { event_id: "no_0", summary: "不去的会", start_time: { datetime: "2026-11-06T06:00:00-06:00" }, end_time: { datetime: "2026-11-06T07:00:00-06:00" }, self_rsvp_status: "decline" },
    { event_id: "allday_0", summary: "全天", start_time: { date: "2026-11-07" }, end_time: { date: "2026-11-08" } },
  ],
};
const NOW = Date.parse("2026-11-03T12:00:00-06:00");
const END = NOW + 30 * 86_400_000;
const [ran, osyx] = parseAgenda(AGENDA) as [FeishuEvent, FeishuEvent];

describe("parseAgenda", () => {
  it("keeps timed events he has not declined, with their meeting link", () => {
    expect(parseAgenda(AGENDA).map((e) => e.id)).toEqual(["32b4bf19_0", "osyx_0"]);
    expect(ran).toMatchObject({ summary: "冉朱旭同学面试", url: "https://vc.feishu.cn/j/609620959", organizer: "陈古龙", rsvp: "accept" });
    expect(parseAgenda({ ok: false })).toEqual([]);
  });
});

describe("googleEventFor", () => {
  it("leads with the meeting link and keeps Feishu's own offset", () => {
    const g = googleEventFor(ran);
    expect(g).toMatchObject({ summary: "冉朱旭同学面试", location: "https://vc.feishu.cn/j/609620959", start: { dateTime: "2026-11-03T19:00:00-06:00" } });
    expect(g.description!.split("\n")[0]).toBe("飞书会议：https://vc.feishu.cn/j/609620959");
  });
});

describe("existingFor — the same meeting already on his calendar", () => {
  const booked = (over: Partial<CalendarEvent>): CalendarEvent => ({ id: "g1", start: { dateTime: "2026-11-04T01:00:00Z" }, end: { dateTime: "2026-11-04T02:30:00Z" }, ...over });
  it("matches by meeting link or number at the same time", () => {
    expect(existingFor(ran, [booked({ summary: "面试", location: "https://vc.feishu.cn/j/609620959" })])?.id).toBe("g1");
    expect(existingFor(ran, [booked({ summary: "面试", description: "会议 ID：609 620 959" })])?.id).toBe("g1");
  });
  it("matches by title at the same time, when there is no link", () => {
    expect(existingFor(ran, [booked({ summary: "冉朱旭同学面试" })])?.id).toBe("g1");
  });
  it("never matches another hour, or another meeting in the same slot", () => {
    expect(existingFor(ran, [booked({ summary: "冉朱旭同学面试", start: { dateTime: "2026-11-04T03:00:00Z" } })])).toBeNull();
    expect(existingFor(ran, [booked({ summary: "Jordan & Leo 1 on 1" })])).toBeNull();
  });
});

describe("planMirror", () => {
  it("creates what is new, adopts what is already booked", () => {
    const already: CalendarEvent = { id: "manual", summary: "冉朱旭同学面试", start: { dateTime: "2026-11-04T01:00:00Z" }, end: { dateTime: "2026-11-04T02:30:00Z" } };
    const p = planMirror([ran, osyx], {}, [already], NOW, END);
    expect(p.adopt).toEqual([{ event: ran, googleId: "manual" }]);
    expect(p.create).toEqual([osyx]);
  });

  it("updates its own event when Feishu moves it; never an adopted one", () => {
    const moved = { ...osyx, start: "2026-11-05T07:00:00-06:00", end: "2026-11-05T08:00:00-06:00" };
    const p = planMirror([moved, { ...ran, summary: "改名了" }], {
      osyx_0: { googleId: "mine", hash: mirrorHash(osyx), start: osyx.start },
      "32b4bf19_0": { googleId: "manual", hash: mirrorHash(ran), start: ran.start, adopted: true },
    }, [], NOW, END);
    expect(p.update).toEqual([{ event: moved, googleId: "mine" }]);
  });

  it("removes its own event when Feishu drops it; forgets adopted and past ones", () => {
    const p = planMirror([], {
      osyx_0: { googleId: "mine", hash: "h", start: osyx.start },
      "32b4bf19_0": { googleId: "manual", hash: "h", start: ran.start, adopted: true },
      old: { googleId: "old-g", hash: "h", start: "2026-10-01T06:00:00-06:00" },
      later: { googleId: "later-g", hash: "h", start: "2027-03-01T06:00:00-06:00" },
    }, [], NOW, END);
    expect(p.remove).toEqual([{ feishuId: "osyx_0", googleId: "mine" }]);
    expect(p.forget.sort()).toEqual(["32b4bf19_0", "old"]);
  });
});
