import { describe, it, expect } from "vitest";
import {
  parseRecentSessions,
  parseChatHistory,
  parseOfficialAccountNames,
  scanWechatInbox,
  scanWechatGroups,
  ownerLastSpokeIn,
} from "./wechat-direct.js";

const NOW = new Date("2026-06-14T22:00:00").getTime();

const SESSIONS = `最近 5 个会话:

[06-14 21:39] 金小奇 芯联集成 (2条未读)
  文本: 主要有几波人见

[06-14 21:10] 陈古龙 (5条未读)
  文本: 毕竟

[06-14 20:25] Hypervisor技术交流 [群] (3条未读)
  文本: 段长江: [OK]

[06-14 21:52] 坦丁
  文本: bro，你已经回到北京了么

[06-14 17:42] 乐乐❤️ (1条未读)
  图片: (无内容)`;

describe("parseRecentSessions", () => {
  it("parses head lines with unread counts, flags groups, skips detail lines", () => {
    const s = parseRecentSessions(SESSIONS, NOW);
    expect(s.map((x) => x.name)).toEqual([
      "金小奇 芯联集成",
      "陈古龙",
      "Hypervisor技术交流",
      "坦丁",
      "乐乐❤️",
    ]);
    const jin = s.find((x) => x.name === "金小奇 芯联集成")!;
    expect(jin.unread).toBe(2);
    expect(jin.isGroup).toBe(false);
    const grp = s.find((x) => x.name === "Hypervisor技术交流")!;
    expect(grp.isGroup).toBe(true);
    expect(grp.unread).toBe(3);
    // 坦丁 has no "(N条未读)" → unread 0 (this is Leo's own outgoing message).
    expect(s.find((x) => x.name === "坦丁")!.unread).toBe(0);
  });
});

describe("parseChatHistory", () => {
  // Real server format: Leo's own messages are labelled "me:" (verified live),
  // the contact's with the contact name. Direction = (label === contactName).
  const HIST = `陈古龙 的消息记录（返回 3 条，offset=0, limit=5）

[2026-06-14 20:00] me: 你好
[2026-06-14 21:08] 陈古龙: 芯片温度也是维持在90度
[2026-06-14 21:10] 陈古龙: 毕竟`;

  it("marks direction by sender label (contact = incoming, 'me' = Leo = outgoing)", () => {
    const msgs = parseChatHistory(HIST, "陈古龙");
    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.isIncoming).toBe(false); // "me" != contact → outgoing (Leo's own)
    expect(msgs[1]!.isIncoming).toBe(true);
    expect(msgs[1]!.text).toBe("芯片温度也是维持在90度");
    expect(msgs[2]!.isIncoming).toBe(true);
  });

  it("extracts image local_id refs", () => {
    const msgs = parseChatHistory(
      "[2026-06-14 21:11] 陈古龙: [图片] (local_id=4567, ts=1781490660)",
      "陈古龙",
    );
    expect(msgs[0]!.isIncoming).toBe(true);
    expect(msgs[0]!.imageLocalIds).toEqual([4567]);
  });
});

describe("parseOfficialAccountNames", () => {
  it("collects 备注/昵称 of gh_ accounts only (real wxid_ people excluded)", () => {
    const contacts = `找到 3 个联系人:

gh_abc123  昵称: Renesas瑞萨电子
gh_def456  备注: 芯片快讯  昵称: ChipNews
wxid_real  备注: 朱桦  昵称: 朱桦 - 瑞萨`;
    const names = parseOfficialAccountNames(contacts);
    expect(names.has("Renesas瑞萨电子")).toBe(true);
    expect(names.has("芯片快讯")).toBe(true);
    expect(names.has("ChipNews")).toBe(true);
    expect(names.has("朱桦")).toBe(false); // wxid_ (real person) not an official account
    expect(names.has("朱桦 - 瑞萨")).toBe(false);
  });
});

describe("scanWechatInbox", () => {
  it("drops 公众号/服务号 sessions listed in officialNames (no card for broadcasts)", async () => {
    const { inbound } = await scanWechatInbox({
      fetchSessions: async () =>
        "最近 1 个会话:\n\n[06-14 21:00] Renesas瑞萨电子 (1条未读)\n  链接/文件: [链接] 招聘",
      fetchHistory: async () => "[2026-06-14 21:00] Renesas瑞萨电子: [链接] 招聘",
      nowMs: NOW,
      officialNames: new Set(["Renesas瑞萨电子"]),
      book: { "Renesas瑞萨电子": { lastSeenMs: 0 } },
    });
    expect(inbound).toHaveLength(0);
  });

  const history: Record<string, string> = {
    "金小奇 芯联集成": `金小奇 芯联集成 的消息记录（返回 2 条）

[2026-06-14 21:35] 金小奇 芯联集成: 大概需要预留3天时间
[2026-06-14 21:39] 金小奇 芯联集成: 主要有几波人见`,
    陈古龙: `陈古龙 的消息记录（返回 1 条）

[2026-06-14 20:00] me: 在路上
[2026-06-14 21:10] 陈古龙: 毕竟`,
  };
  // lastSeenMs 0 = "known, and everything since is new". An ABSENT entry would
  // mean first contact, which seeds the cursor and mints nothing on purpose.
  const opts = {
    fetchSessions: async () => SESSIONS,
    fetchHistory: async (name: string) => history[name] ?? `${name} 无消息记录`,
    nowMs: NOW,
    book: {
      "金小奇 芯联集成": { lastSeenMs: 0 },
      陈古龙: { lastSeenMs: 0 },
      坦丁: { lastSeenMs: 0 },
      乐乐: { lastSeenMs: 0 },
    },
  };

  it("surfaces moved 1:1 chats; drops groups and family", async () => {
    const { inbound } = await scanWechatInbox(opts);
    const names = inbound.map((m) => m.senderHandle);
    // 坦丁's fixture has no history, so it contributes nothing — but it IS
    // fetched now, which unread-gating would never have done.
    expect(names.sort()).toEqual(["金小奇 芯联集成", "陈古龙"].sort());
  });

  // THE REGRESSION. Under unread-gating this chat was invisible: 王凤壮 proposed
  // a meeting, Leo answered 好的！within four minutes, unread went to zero, and
  // the meeting never reached the calendar. A cursor still sees it.
  it("surfaces a chat Leo has already READ and replied to", async () => {
    const { inbound } = await scanWechatInbox({
      ...opts,
      fetchSessions: async () =>
        "最近 1 个会话:\n\n[09-20 14:13] 王凤壮\n  文本: B510",
      fetchHistory: async () =>
        "[2026-09-20 14:07] 王凤壮: 周二上午9点到9点30 B510\n[2026-09-20 14:11] me: 好的！",
      book: { 王凤壮: { lastSeenMs: 0 } },
    });
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.text).toBe("周二上午9点到9点30 B510");
    // Leo's own line is context, never the trigger.
    expect(inbound[0]!.threadContext).toContain("我: 好的！");
  });

  // Direction, not unread, is what keeps Leo from being drafted a reply to
  // himself — and it never depended on the unread count.
  it("mints nothing when only Leo spoke since the cursor", async () => {
    const { inbound, book } = await scanWechatInbox({
      ...opts,
      fetchSessions: async () => "最近 1 个会话:\n\n[06-14 21:52] 坦丁\n  文本: 到了说一声",
      fetchHistory: async () => "[2026-06-14 21:52] me: 到了说一声",
      book: { 坦丁: { lastSeenMs: 1 } },
    });
    expect(inbound).toHaveLength(0);
    // The cursor still advances, or this chat is re-fetched every tick forever.
    expect(book.坦丁!.lastSeenMs).toBeGreaterThan(1);
  });

  // First sight must not pour a contact's whole backlog into the queue.
  it("seeds a first-seen chat and mints nothing", async () => {
    const { inbound, book } = await scanWechatInbox({
      ...opts,
      fetchSessions: async () => "最近 1 个会话:\n\n[06-14 21:00] 新朋友 (3条未读)\n  文本: 你好",
      fetchHistory: async () => "[2026-06-14 21:00] 新朋友: 你好",
      book: {},
    });
    expect(inbound).toHaveLength(0);
    expect(book.新朋友!.lastSeenMs).toBeGreaterThan(0);
  });

  it("combines multiple incoming messages; drops Leo's outgoing lines", async () => {
    const { inbound } = await scanWechatInbox(opts);
    const jin = inbound.find((m) => m.senderHandle === "金小奇 芯联集成")!;
    expect(jin.text).toBe("大概需要预留3天时间\n主要有几波人见"); // both incoming, combined
    const chen = inbound.find((m) => m.senderHandle === "陈古龙")!;
    expect(chen.text).toBe("毕竟"); // "me: 在路上" (Leo's outgoing) excluded
    expect(chen.platform).toBe("wechat");
    expect(chen.isDirectMessage).toBe(true);
  });

  it("carries the recent thread (both sides, 我-labelled) as threadContext, separate from text", async () => {
    const { inbound } = await scanWechatInbox(opts);
    const chen = inbound.find((m) => m.senderHandle === "陈古龙")!;
    // text = only the new unread to respond to; threadContext = the background thread.
    expect(chen.text).toBe("毕竟");
    expect(chen.threadContext).toBe("我: 在路上\n陈古龙: 毕竟");
  });

  it("attaches image refs when an unread message is an image", async () => {
    const { inbound } = await scanWechatInbox({
      ...opts,
      fetchSessions: async () => "最近 1 个会话:\n\n[06-14 21:11] 老王 (1条未读)\n  图片: (无内容)",
      fetchHistory: async () => "[2026-06-14 21:11] 老王: [图片] (local_id=99, ts=1)",
      book: { 老王: { lastSeenMs: 0 } },
    });
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.attachments).toEqual([
      { id: "99", kind: "image", name: "wechat-image local_id=99" },
    ]);
  });
});

describe("groups (2026-09-12: a legal thread lived in a 2-person group, unseen)", () => {
  const H = (lines: Array<[string, string, string]>): string =>
    ["群 的消息记录: [群聊]", "", ...lines.map(([t, who, text]) => `[${t}] ${who}: ${text}`)].join("\n");

  const sessions = [{ name: "台州帮", isGroup: true, unread: 0, tsMs: Date.parse("2026-09-12T17:40:00") }];

  it("reads an allowed group the owner has already read (unread is 0)", async () => {
    const r = await scanWechatGroups({
      sessions,
      book: { "台州帮": { decision: "allow", by: "owner", at: "x", lastSeenMs: 0 } },
      fetchHistory: async () =>
        H([["2026-09-12 17:39", "金小奇 芯联集成", "郭律那边合同怎么走"]]),
      now: () => "2026-09-12T10:00:00Z",
    });
    expect(r.inbound).toHaveLength(1);
    expect(r.inbound[0]!.text).toContain("金小奇 芯联集成: 郭律那边合同怎么走");
    expect(r.inbound[0]!.isDirectMessage).toBe(false);
  });

  it("binds the message to the GROUP, never guessing which persona a speaker is", () => {
    // Exact-match-or-nothing is the one rule this codebase does not bend.
    return scanWechatGroups({
      sessions,
      book: { "台州帮": { decision: "allow", by: "owner", at: "x", lastSeenMs: 0 } },
      fetchHistory: async () => H([["2026-09-12 17:39", "金小奇 芯联集成", "在的"]]),
      now: () => "x",
    }).then((r) => expect(r.inbound[0]!.senderHandle).toBe("台州帮"));
  });

  it("advances the cursor past Leo's own messages without carding them", async () => {
    const hist = H([
      ["2026-09-12 17:39", "me", "我自己说的"],
      ["2026-09-12 17:40", "me", "还是我"],
    ]);
    const r = await scanWechatGroups({
      sessions,
      book: { "台州帮": { decision: "allow", by: "owner", at: "x", lastSeenMs: 0 } },
      fetchHistory: async () => hist,
      now: () => "x",
    });
    expect(r.inbound).toEqual([]);
    expect(r.book["台州帮"]!.lastSeenMs).toBe(Date.parse("2026-09-12T17:40:00"));
  });

  it("does not re-read messages it already turned into inbound", async () => {
    const hist = H([["2026-09-12 17:39", "金小奇 芯联集成", "一条"]]);
    const first = await scanWechatGroups({
      sessions,
      // Covered, nothing seen yet. (No cursor at all means first contact, which
      // seeds and mints nothing — a different scenario, tested separately.)
      book: { "台州帮": { decision: "allow", by: "owner", at: "x", lastSeenMs: 0 } },
      fetchHistory: async () => hist,
      now: () => "x",
    });
    expect(first.inbound).toHaveLength(1);
    const second = await scanWechatGroups({
      sessions,
      book: first.book,
      fetchHistory: async () => hist,
      now: () => "x",
    });
    expect(second.inbound).toEqual([]);
  });

  it("classifies an unknown group and reads it on the NEXT pass, not this one", async () => {
    const hist = H([["2026-09-12 17:39", "甲", "a"], ["2026-09-12 17:39", "乙", "b"]]);
    const r = await scanWechatGroups({
      sessions,
      book: {},
      fetchHistory: async () => hist,
      now: () => "2026-09-12T10:00:00Z",
    });
    expect(r.inbound).toEqual([]);
    expect(r.book["台州帮"]).toMatchObject({ decision: "allow", by: "auto", speakers: 2 });
  });

  it("leaves a group unclassified when its history cannot be read, so it retries", async () => {
    const r = await scanWechatGroups({
      sessions,
      book: {},
      fetchHistory: async () => { throw new Error("db locked"); },
      now: () => "x",
    });
    expect(r.book["台州帮"]).toBeUndefined();
  });
});

describe("ownerLastSpokeIn (an answered WeChat thread never reaches the engine)", () => {
  const H = (lines: Array<[string, string, string]>): string =>
    ["记录:", "", ...lines.map(([t, who, text]) => `[${t}] ${who}: ${text}`)].join("\n");

  it("reports when the owner last spoke, ignoring the contact's messages", async () => {
    const m = await ownerLastSpokeIn(["Leila"], async () =>
      H([
        ["2026-09-13 09:00", "Leila", "什么时候回深圳"],
        ["2026-09-13 09:30", "me", "下周三"],
        ["2026-09-13 09:40", "Leila", "好"],
      ]),
    );
    expect(m.get("Leila")).toBe(Date.parse("2026-09-13T09:30:00"));
  });

  it("omits a conversation the owner has not spoken in at all", async () => {
    const m = await ownerLastSpokeIn(["Leila"], async () =>
      H([["2026-09-13 09:00", "Leila", "在吗"]]),
    );
    expect(m.has("Leila")).toBe(false);
  });

  it("keeps going when one conversation cannot be read", async () => {
    const m = await ownerLastSpokeIn(["bad", "good"], async (name) => {
      if (name === "bad") throw new Error("db locked");
      return H([["2026-09-13 10:00", "me", "回了"]]);
    });
    expect(m.has("bad")).toBe(false);
    expect(m.get("good")).toBe(Date.parse("2026-09-13T10:00:00"));
  });
});

describe("first contact with a group seeds the cursor and mints nothing", () => {
  // REGRESSION: an admitted group with no cursor read its whole recent history
  // as new — «Lucky» produced a reply card from a 2025-06-13 message on
  // 2026-09-12. Coverage begins at admission; older history is not a to-do.
  const H = (lines: Array<[string, string, string]>): string =>
    ["群 的消息记录: [群聊]", "", ...lines.map(([t, who, text]) => `[${t}] ${who}: ${text}`)].join("\n");
  const sessions = [{ name: "Lucky", isGroup: true, unread: 0, tsMs: Date.parse("2026-09-12T11:00:00") }];
  const hist = H([["2025-06-13 21:17", "茉莉", "你们那热吗？"], ["2025-06-13 21:18", "茉莉", "要装空调吗"]]);

  it("emits no inbound on the first pass and records the newest message as the cursor", async () => {
    const r = await scanWechatGroups({
      sessions,
      book: { Lucky: { decision: "allow", by: "auto", at: "x", speakers: 1 } },
      fetchHistory: async () => hist,
      now: () => "x",
    });
    expect(r.inbound).toEqual([]);
    expect(r.book.Lucky!.lastSeenMs).toBe(Date.parse("2025-06-13T21:18:00"));
  });

  it("then only messages newer than that cursor become inbound", async () => {
    const seeded = { Lucky: { decision: "allow" as const, by: "auto" as const, at: "x", lastSeenMs: Date.parse("2025-06-13T21:18:00") } };
    const later = H([["2025-06-13 21:18", "茉莉", "要装空调吗"], ["2026-09-12 10:59", "茉莉", "新的一条"]]);
    const r = await scanWechatGroups({ sessions, book: seeded, fetchHistory: async () => later, now: () => "x" });
    expect(r.inbound).toHaveLength(1);
    expect(r.inbound[0]!.text).toBe("茉莉: 新的一条");
  });
});
