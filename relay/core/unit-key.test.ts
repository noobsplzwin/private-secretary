import { describe, it, expect } from "vitest";
import {
  clusterKey,
  stableHash,
  unitKey,
  resolvePlanKey,
  inheritSupersededTaskIds,
} from "./unit-key.js";
import type { ActionItem } from "./action-item.js";

function card(id: string, over: Partial<ActionItem> = {}): ActionItem {
  return {
    id,
    source_message_id: `wechat:${id}`,
    action_type: "reply",
    target: { platform: "wechat", personaKey: null },
    reason: "r",
    confidence: 0.5,
    params: {},
    status: "suggested",
    created_at: "2026-07-28T00:00:00Z",
    context: { sender_handle: "张工" },
    ...over,
  };
}

describe("stableHash", () => {
  it("is deterministic and input-sensitive", () => {
    expect(stableHash("wechat::张工")).toBe(stableHash("wechat::张工"));
    expect(stableHash("wechat::张工")).not.toBe(stableHash("wechat::李工"));
    expect(stableHash("")).toMatch(/^[0-9a-f]+$/);
  });
});

describe("clusterKey", () => {
  it("platform prefix + sender; null without a sender", () => {
    expect(clusterKey(card("a"))).toBe("wechat::张工");
    expect(clusterKey(card("a", { context: undefined }))).toBeNull();
    expect(clusterKey(card("a", { context: {} }))).toBeNull();
  });
});

describe("unitKey", () => {
  it("task_id wins", () => {
    expect(unitKey(card("a", { task_id: "t9" }))).toBe("t9");
  });

  it("same sender → same key across different action ids (stable across supersede)", () => {
    const k1 = unitKey(card("a"));
    const k2 = unitKey(card("b")); // a fresh card replacing "a"
    expect(k1).toBe(k2);
    expect(k1).toBe(`__ungrouped_${stableHash("wechat::张工")}`);
  });

  it("different sender → different key", () => {
    expect(unitKey(card("a"))).not.toBe(
      unitKey(card("a", { context: { sender_handle: "李工" } })),
    );
  });

  it("no sender → falls back to the action id (never supersedes anyway)", () => {
    expect(unitKey(card("a", { context: undefined }))).toBe("__ungrouped_a");
  });
});

describe("resolvePlanKey", () => {
  it("task_id passes through", () => {
    expect(resolvePlanKey("t9", [card("a")])).toBe("t9");
  });

  it("an ungrouped identity resolves to the stable conversation key (not the action id)", () => {
    const a = card("a");
    const identity = `__ungrouped_${a.id}`;
    const stable = `__ungrouped_${stableHash("wechat::张工")}`;
    expect(resolvePlanKey(identity, [a])).toBe(stable);
    // distinct from the identity itself — the shared conversation key, not the per-card id
    expect(resolvePlanKey(identity, [a])).not.toBe(identity);
  });

  it("an unknown identity falls back to itself (defensive)", () => {
    expect(resolvePlanKey("__ungrouped_ghost", [card("a")])).toBe("__ungrouped_ghost");
  });
});

describe("inheritSupersededTaskIds", () => {
  it("a fresh card inherits the superseded same-conversation card's task_id", () => {
    const doomed = [card("old", { task_id: "task_zf" })];
    const out = inheritSupersededTaskIds([card("new")], doomed);
    expect(out[0]!.task_id).toBe("task_zf");
    expect(out[0]!.id).toBe("new");
  });

  // REGRESSION: inheritance is keyed by conversation, so one dropped card's
  // task_id used to be claimed by EVERY fresh card from that sender. One tick
  // produced three cards from Cody — an applicant review, a background check,
  // and a Jira ticket he sent — and all three were absorbed into "Senior
  // Android JD 修订版", a task minted three days earlier for another subject.
  // Repeated, a contact's task_id accumulates everything they ever say under
  // whichever title came first, which is what made the owner's list unusable.
  it("does NOT inherit when the conversation yielded SEVERAL fresh cards", () => {
    const doomed = [card("old", { task_id: "task_jd" })];
    const out = inheritSupersededTaskIds(
      [card("applicant"), card("diligence"), card("jira")],
      doomed,
    );
    expect(out.map((a) => a.task_id)).toEqual([undefined, undefined, undefined]);
  });

  // The 1:1 case is what P1 was about — one chatty contact, one evolving card,
  // whose plan/override must not detach — so it still inherits.
  it("still inherits on a 1:1 supersede, per P1", () => {
    const doomed = [card("old", { task_id: "task_zf" })];
    expect(inheritSupersededTaskIds([card("new")], doomed)[0]!.task_id).toBe("task_zf");
  });

  // Per conversation, not globally: a second contact's single card is still an
  // unambiguous replacement even while the first contact yielded several.
  it("counts fresh cards per conversation", () => {
    const other = (id: string) => card(id, { context: { sender_handle: "李工" } });
    const doomed = [card("oldA", { task_id: "task_a" }), other("oldB")];
    doomed[1]!.task_id = "task_b";
    const out = inheritSupersededTaskIds([card("a1"), card("a2"), other("b1")], doomed);
    expect(out[0]!.task_id).toBeUndefined(); // 张工 sent two → ambiguous
    expect(out[1]!.task_id).toBeUndefined();
    expect(out[2]!.task_id).toBe("task_b"); // 李工 sent one → inherits
  });

  it("fills only MISSING task_ids — never overwrites", () => {
    const doomed = [card("old", { task_id: "task_zf" })];
    const out = inheritSupersededTaskIds([card("new", { task_id: "task_own" })], doomed);
    expect(out[0]!.task_id).toBe("task_own");
  });

  it("inherits only on a key match — other senders / sender-less cards untouched", () => {
    const doomed = [card("old", { task_id: "task_zf" })];
    const other = card("new", { context: { sender_handle: "李工" } });
    const noSender = card("new2", { context: undefined });
    const out = inheritSupersededTaskIds([other, noSender], doomed);
    expect(out[0]!.task_id).toBeUndefined();
    expect(out[1]!.task_id).toBeUndefined();
  });

  it("does not mutate inputs", () => {
    const incoming = [card("new")];
    const doomed = [card("old", { task_id: "task_zf" })];
    inheritSupersededTaskIds(incoming, doomed);
    expect(incoming[0]!.task_id).toBeUndefined();
  });
});
