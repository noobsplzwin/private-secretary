import { describe, expect, it } from "vitest";
import { planDirectScan, advanceCursor, type DirectBook, type DirectSession } from "./wechat-direct-cursor.js";

const s = (name: string, tsMs: number, isGroup = false): DirectSession => ({ name, isGroup, tsMs });

describe("planDirectScan", () => {
  // THE BUG THIS REPLACES. 王凤壮 proposed 周二上午9点到9点30 B510 at 14:07 and Leo
  // answered 好的！at 14:11. Unread went to zero and the meeting never reached
  // the calendar. Under a cursor the chat is still scannable.
  it("scans a chat that moved even with nothing unread", () => {
    const book: DirectBook = { "王凤壮": { lastSeenMs: 1_000 } };
    expect(planDirectScan([s("王凤壮", 2_000)], book).fetch).toEqual(["王凤壮"]);
  });

  it("leaves a chat alone until it moves", () => {
    const book: DirectBook = { a: { lastSeenMs: 2_000 } };
    expect(planDirectScan([s("a", 2_000)], book).fetch).toEqual([]);
    expect(planDirectScan([s("a", 1_999)], book).fetch).toEqual([]);
  });

  // Same rule the group scan needed: a contact seen for the first time must not
  // dump years of history into the queue as though it all arrived today.
  it("seeds a first-seen chat instead of scanning it", () => {
    const plan = planDirectScan([s("新朋友", 9_000)], {});
    expect(plan.seed).toEqual(["新朋友"]);
    expect(plan.fetch).toEqual([]);
  });

  it("skips groups, folded placeholders, family and official accounts", () => {
    const plan = planDirectScan(
      [s("工作群", 9_000, true), s("@placeholder_foldgroup", 9_000), s("", 9_000), s("乐乐", 9_000), s("招商银行", 9_000)],
      { "工作群": { lastSeenMs: 0 }, "@placeholder_foldgroup": { lastSeenMs: 0 }, "": { lastSeenMs: 0 }, "乐乐": { lastSeenMs: 0 }, "招商银行": { lastSeenMs: 0 } },
      { exclude: ["乐乐"], official: new Set(["招商银行"]) },
    );
    expect(plan.fetch).toEqual([]);
    expect(plan.seed).toEqual([]);
  });
});

describe("advanceCursor", () => {
  // Session lines carry MINUTE precision, so two scans inside one minute must
  // not re-open a chat that was already consumed.
  it("never moves backwards", () => {
    const book = advanceCursor({ a: { lastSeenMs: 5_000 } }, "a", 4_000);
    expect(book.a!.lastSeenMs).toBe(5_000);
  });

  it("advances on a newer message and seeds an unknown chat", () => {
    expect(advanceCursor({ a: { lastSeenMs: 5_000 } }, "a", 6_000).a!.lastSeenMs).toBe(6_000);
    expect(advanceCursor({}, "b", 7_000).b!.lastSeenMs).toBe(7_000);
  });
});
