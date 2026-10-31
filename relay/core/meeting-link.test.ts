import { describe, it, expect } from "vitest";
import { bookedMeetingFor, descriptionWithLink, joinLinkBlock, pendingMeetingFor } from "./meeting-link.js";
import type { ActionItem } from "./action-item.js";

// 徐志成's invite, 2026-10-09, as it reached the group.
const INVITE = `北京市君合律师事务所
徐志成 邀请您参加腾讯会议
会议主题：欧思克斯-交易文件沟通
会议时间：2026/10/10 16:00-17:00 (GMT+08:00) 中国标准时间 - 北京
点击链接入会，或添加至会议列表：
https://meeting.tencent.com/dm/n5GwDugMTwDU
#腾讯会议：451-561-296`;

describe("joinLinkBlock", () => {
  it("takes the URL and the meeting number", () => {
    expect(joinLinkBlock(INVITE)).toEqual({
      url: "https://meeting.tencent.com/dm/n5GwDugMTwDU",
      block: "https://meeting.tencent.com/dm/n5GwDugMTwDU\n#腾讯会议：451-561-296",
    });
  });

  it("reads the English Tencent invite's meeting number too (2026-10-31, PQC)", () => {
    const en = "https://meeting.tencent.com/dm/1ud6Aa9AqNeu\n\n#TencentMeeting：944-572-985\n\nCopy this invitation and open in Tencent Meeting app";
    expect(joinLinkBlock(en)?.block).toBe("https://meeting.tencent.com/dm/1ud6Aa9AqNeu\n#TencentMeeting：944-572-985");
  });

  it("knows Teams, Zoom, Feishu and Meet; ignores other links", () => {
    expect(joinLinkBlock("加入: https://teams.microsoft.com/meet/446953618298255?p=za1n 密码: Nk7KJ3tJ")?.url).toBe(
      "https://teams.microsoft.com/meet/446953618298255?p=za1n",
    );
    expect(joinLinkBlock("https://us02web.zoom.us/j/123456")?.url).toBe("https://us02web.zoom.us/j/123456");
    expect(joinLinkBlock("https://vc.feishu.cn/j/572394931")?.url).toBe("https://vc.feishu.cn/j/572394931");
    expect(joinLinkBlock("https://meet.google.com/oqi-ijbh-cko")?.url).toBe("https://meet.google.com/oqi-ijbh-cko");
    expect(joinLinkBlock("看下这个 https://github.com/x/y")).toBeNull();
  });
});

describe("bookedMeetingFor", () => {
  const NOW = Date.parse("2026-10-09T08:00:00Z");
  const booked = (id: string, start: string, handle = "F26 奇绩-欧思克斯法律工作群"): ActionItem =>
    ({
      id,
      action_type: "calendar",
      status: "executed",
      params: { start, execution_receipt: { kind: "calendar_event", ref: `ev-${id}` } },
      context: { sender_handle: handle },
    }) as unknown as ActionItem;

  it("finds the one upcoming event booked from this chat", () => {
    expect(bookedMeetingFor([booked("a", "2026-10-10T08:00:00Z")], "F26 奇绩-欧思克斯法律工作群", NOW)?.id).toBe("a");
  });

  it("nothing when two could be meant, when it is past, or when it is another chat's", () => {
    expect(bookedMeetingFor([booked("a", "2026-10-10T08:00:00Z"), booked("b", "2026-10-11T08:00:00Z")], "F26 奇绩-欧思克斯法律工作群", NOW)).toBeNull();
    expect(bookedMeetingFor([booked("a", "2026-10-08T08:00:00Z")], "F26 奇绩-欧思克斯法律工作群", NOW)).toBeNull();
    expect(bookedMeetingFor([booked("a", "2026-10-10T08:00:00Z", "金小奇")], "F26 奇绩-欧思克斯法律工作群", NOW)).toBeNull();
  });
});

describe("pendingMeetingFor", () => {
  const NOW = Date.parse("2026-10-31T11:00:00Z");
  const card = (id: string, status: string): ActionItem =>
    ({ id, action_type: "calendar", status, params: { start: "2026-11-05T01:00:00.000Z" }, context: { sender_handle: "26056426628@chatroom" } }) as unknown as ActionItem;
  it("finds the one card from this chat still waiting to be booked", () => {
    expect(pendingMeetingFor([card("p", "suggested")], "26056426628@chatroom", NOW)?.id).toBe("p");
    expect(pendingMeetingFor([card("p", "executed")], "26056426628@chatroom", NOW)).toBeNull();
    expect(pendingMeetingFor([card("p", "suggested"), card("q", "suggested")], "26056426628@chatroom", NOW)).toBeNull();
  });
});

describe("descriptionWithLink", () => {
  const link = { url: "https://meeting.tencent.com/dm/x", block: "https://meeting.tencent.com/dm/x\n#腾讯会议：451" };
  it("puts the link on top, once", () => {
    expect(descriptionWithLink("过投资协议", link)).toBe("https://meeting.tencent.com/dm/x\n#腾讯会议：451\n\n过投资协议");
    expect(descriptionWithLink("https://meeting.tencent.com/dm/x\n过投资协议", link)).toBeNull();
    expect(descriptionWithLink(undefined, link)).toBe(link.block);
  });
});
