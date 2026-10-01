import { describe, expect, it } from "vitest";
import { enqueue, settle, takeForDraft, MAX_DRAFT_ATTEMPTS, type InboxEntry } from "./inbox.js";
import type { InboundMessage } from "./types.js";

const msg = (id: string, sender = "金小奇", ts = 1): InboundMessage =>
  ({
    id,
    platform: "wechat",
    senderHandle: sender,
    timestampMs: ts,
    text: id,
    source: `wechat:${sender}`,
  }) as InboundMessage;

const AT = "2026-10-01T10:00:00Z";

describe("enqueue", () => {
  it("adds new messages and never the same one twice", () => {
    const a = enqueue([], [msg("m1"), msg("m2")], AT).inbox;
    const b = enqueue(a, [msg("m2"), msg("m3")], AT).inbox;
    expect(b.map((e) => e.msg.id)).toEqual(["m1", "m2", "m3"]);
    expect(b.every((e) => e.attempts === 0)).toBe(true);
  });

  // Overflow drops the OLDEST and hands them back to be logged — never silent.
  it("drops the oldest over the cap, and says which", () => {
    const r = enqueue(enqueue([], [msg("m1"), msg("m2")], AT).inbox, [msg("m3")], AT, 2);
    expect(r.inbox.map((e) => e.msg.id)).toEqual(["m2", "m3"]);
    expect(r.overflow.map((e) => e.msg.id)).toEqual(["m1"]);
  });
});

describe("takeForDraft", () => {
  // REGRESSION: over maxDraftCandidates used to be counted as `draftSkipped`
  // and dropped. Now it simply waits.
  it("takes the newest up to the cap; the rest stay queued", () => {
    const inbox = enqueue([], [msg("old", "a", 1), msg("new", "b", 3), msg("mid", "c", 2)], AT).inbox;
    expect(takeForDraft(inbox, 2).map((m) => m.id)).toEqual(["new", "mid"]);
    expect(takeForDraft(inbox).map((m) => m.id)).toEqual(["old", "new", "mid"]);
  });
});

describe("settle", () => {
  const inbox: InboxEntry[] = enqueue([], [msg("ok", "陈古龙"), msg("bad", "金小奇"), msg("later", "孙陈")], AT).inbox;
  const attempted = [msg("ok", "陈古龙"), msg("bad", "金小奇")];

  it("removes what drafted, keeps what failed with one more attempt", () => {
    const r = settle(inbox, attempted, new Set(["金小奇"]), false);
    expect(r.inbox.map((e) => [e.msg.id, e.attempts])).toEqual([
      ["bad", 1],
      ["later", 0], // never attempted — untouched
    ]);
    expect(r.gaveUp).toEqual([]);
  });

  // A whole-call failure names nobody, so nothing it was given may be removed.
  it("keeps EVERY attempted message when the whole call failed", () => {
    const r = settle(inbox, attempted, new Set(), true);
    expect(r.inbox.map((e) => e.msg.id).sort()).toEqual(["bad", "later", "ok"]);
  });

  it("gives up on a message that keeps failing, and reports it", () => {
    let box = inbox;
    let gaveUp: InboxEntry[] = [];
    for (let i = 0; i < MAX_DRAFT_ATTEMPTS; i++) ({ inbox: box, gaveUp } = settle(box, attempted, new Set(["金小奇"]), false));
    expect(box.some((e) => e.msg.id === "bad")).toBe(false);
    expect(gaveUp.map((e) => e.msg.id)).toEqual(["bad"]);
  });

  // The analyser settles against the FRESH inbox read under the lock; a message
  // the fetch lane added while the draft ran must survive the settle.
  it("never loses a message enqueued while the draft was running", () => {
    const fresh = enqueue(inbox, [msg("arrived-mid-draft", "朱桦")], AT).inbox;
    const r = settle(fresh, attempted, new Set(), false);
    expect(r.inbox.map((e) => e.msg.id)).toEqual(["later", "arrived-mid-draft"]);
  });
});
