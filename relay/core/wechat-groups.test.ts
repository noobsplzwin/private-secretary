import { describe, it, expect } from "vitest";
import {
  AUTO_ADMIT_MAX_SPEAKERS,
  classifyGroup,
  countSpeakers,
  planGroupScan,
  type GroupBook,
} from "./wechat-groups.js";

const AT = "2026-09-12T10:00:00Z";

const history = (lines: Array<[string, string]>): string =>
  ["群名 的消息记录（返回 N 条）: [群聊]", "", ...lines.map(([who, text]) => `[2026-09-12 17:39] ${who}: ${text}`)].join("\n");

describe("countSpeakers", () => {
  it("counts distinct people in a history block", () => {
    expect(countSpeakers(history([["me", "a"], ["金小奇 芯联集成", "b"], ["me", "c"]]))).toBe(2);
  });

  // REGRESSION: the first cut matched "anything before a colon", so fragments of
  // a forwarded message — 「建议的折中」, 「一句话收」 — counted as people and
  // inflated 「Leo和台州帮」 from 3 speakers to 8. A real work group pushed over
  // the threshold by its own quoted text is exactly the miss this gate exists
  // to prevent, so the line must be anchored on the full timestamp.
  it("does not count continuation lines of a quoted message as speakers", () => {
    const raw = [
      "[2026-09-12 17:39] me: 转发一段",
      "建议的折中: 先做 A",
      "一句话收: 就这样",
      "[2026-09-12 17:40] 金小奇 芯联集成: 收到",
    ].join("\n");
    expect(countSpeakers(raw)).toBe(2);
  });

  it("does not count the system pseudo-sender", () => {
    expect(countSpeakers(history([["me", "a"], ["[系统]", "<sysmsg/>"]]))).toBe(1);
  });

  it("is 0 for a block with no parseable messages", () => {
    expect(countSpeakers("no messages here")).toBe(0);
  });
});

describe("classifyGroup", () => {
  it("admits a small group and denies a crowd", () => {
    expect(classifyGroup(3, AT).decision).toBe("allow");
    expect(classifyGroup(AUTO_ADMIT_MAX_SPEAKERS, AT).decision).toBe("allow");
    expect(classifyGroup(AUTO_ADMIT_MAX_SPEAKERS + 1, AT).decision).toBe("deny");
  });

  it("denies a group it could not read rather than admitting it blind", () => {
    expect(classifyGroup(0, AT).decision).toBe("deny");
  });

  it("records the count it judged on, so a later look can tell why", () => {
    expect(classifyGroup(4, AT)).toMatchObject({ speakers: 4, by: "auto", at: AT });
  });
});

describe("planGroupScan", () => {
  const book: GroupBook = {
    "Leo和台州帮": { decision: "allow", by: "owner", at: AT, lastSeenMs: 1000 },
    "Waterloo二手闲置": { decision: "deny", by: "auto", at: AT },
  };
  const g = (name: string, tsMs: number, isGroup = true) => ({ name, isGroup, tsMs });

  it("fetches an allowed group only when its latest message is newer than the cursor", () => {
    expect(planGroupScan([g("Leo和台州帮", 2000)], book).fetch).toEqual(["Leo和台州帮"]);
    expect(planGroupScan([g("Leo和台州帮", 1000)], book).fetch).toEqual([]);
  });

  // The unread count is what made the legal thread unreachable: the owner reads
  // his working groups immediately, so they sit at 0 unread forever. The cursor
  // must not care whether he has read them.
  it("fetches a group the owner has already read", () => {
    const read = [{ name: "Leo和台州帮", isGroup: true, tsMs: 5000, unread: 0 }];
    expect(planGroupScan(read, book).fetch).toEqual(["Leo和台州帮"]);
  });

  it("never fetches a denied group, however new its messages", () => {
    expect(planGroupScan([g("Waterloo二手闲置", 9e12)], book).fetch).toEqual([]);
  });

  it("queues an unknown group for classification instead of guessing", () => {
    const p = planGroupScan([g("新的三人群", 2000)], book);
    expect(p.classify).toEqual(["新的三人群"]);
    expect(p.fetch).toEqual([]);
  });

  it("ignores 1:1 sessions and the folded-group placeholder", () => {
    const p = planGroupScan(
      [g("金小奇", 9e12, false), g("@placeholder_foldgroup", 9e12)],
      book,
    );
    expect(p).toEqual({ fetch: [], classify: [] });
  });
});
