import { describe, it, expect } from "vitest";
import { consolidateTasks } from "./consolidate.js";
import { buildConsolidationRequest } from "./consolidate-prompt.js";
import type { ActionItem } from "../core/action-item.js";
import type { TaskRegistry } from "../core/tasks.js";

function card(id: string, over: Partial<ActionItem> = {}): ActionItem {
  return {
    id,
    source_message_id: `wechat:${id}`,
    action_type: "task",
    target: {},
    reason: "r",
    confidence: 0.5,
    params: {},
    status: "suggested",
    created_at: "2026-06-23T00:00:00Z",
    ...over,
  };
}

// Stub JSON caller: returns a fixed assignments payload.
function jsonStub(assignments: Array<{ card_id: string; task_title: string }>) {
  return { json: async () => ({ assignments }), now: () => "2026-06-23T12:00:00Z" };
}

describe("consolidateTasks", () => {
  it("groups two cards with the same title under one shared, stable task_id", async () => {
    const cards = [card("a"), card("b")];
    const title = "采埃孚悬挂 实车测试@安亭 · 约张工";
    const r = await consolidateTasks(cards, {}, jsonStub([
      { card_id: "a", task_title: title },
      { card_id: "b", task_title: title },
    ]));
    expect(r.updatedActions).toHaveLength(2);
    const ids = new Set(r.updatedActions.map((a) => a.task_id));
    expect(ids.size).toBe(1); // both share one id
    const id = r.updatedActions[0]!.task_id!;
    expect(r.registryAdditions[id]?.title).toBe(title);
  });

  it("does NOT group a brand-new task with a single member (stays standalone)", async () => {
    const cards = [card("a"), card("b")];
    const r = await consolidateTasks(cards, {}, jsonStub([
      { card_id: "a", task_title: "solo task only a is in" },
    ]));
    expect(r.updatedActions).toHaveLength(0);
    expect(r.registryAdditions).toEqual({});
  });

  it("attaches a single card to an EXISTING task (any member count)", async () => {
    const registry: TaskRegistry = {
      task_existing: { title: "ZF suspension visit", created_at: "2026-06-20T00:00:00Z" },
    };
    const cards = [card("a"), card("b", { task_id: "task_existing" })];
    const r = await consolidateTasks(cards, registry, jsonStub([
      { card_id: "a", task_title: "ZF suspension visit" }, // exact existing title → attach
      { card_id: "b", task_title: "ZF suspension visit" }, // re-affirm b's membership
    ]));
    expect(r.updatedActions).toHaveLength(1); // only a changed; b unchanged
    expect(r.updatedActions[0]!.id).toBe("a");
    expect(r.updatedActions[0]!.task_id).toBe("task_existing");
    expect(r.registryAdditions).toEqual({}); // no new task minted
  });

  it("self-heals: a tagged card the model no longer groups is DETACHED", async () => {
    const registry: TaskRegistry = {
      task_x: { title: "real task", created_at: "2026-06-20T00:00:00Z" },
    };
    // 'a' stays in the task; 'b' was wrongly folded in earlier and the model now
    // omits it (it's standalone small-talk). 'b' must be detached, not frozen.
    const cards = [
      card("a", { task_id: "task_x" }),
      card("b", { task_id: "task_x" }),
    ];
    const r = await consolidateTasks(cards, registry, jsonStub([
      { card_id: "a", task_title: "real task" }, // re-affirm a only
    ]));
    expect(r.updatedActions).toHaveLength(1);
    expect(r.updatedActions[0]!.id).toBe("b");
    expect(r.updatedActions[0]!.task_id).toBeUndefined(); // detached
  });

  it("is idempotent: cards already on the right task_id produce no updates", async () => {
    const title = "shared thing";
    // First pass to learn the stable id.
    const first = await consolidateTasks([card("a"), card("b")], {}, jsonStub([
      { card_id: "a", task_title: title },
      { card_id: "b", task_title: title },
    ]));
    const id = first.updatedActions[0]!.task_id!;
    const registry: TaskRegistry = { [id]: { title, created_at: "x" } };
    const cards = [card("a", { task_id: id }), card("b", { task_id: id })];
    const second = await consolidateTasks(cards, registry, jsonStub([
      { card_id: "a", task_title: title },
      { card_id: "b", task_title: title },
    ]));
    expect(second.updatedActions).toHaveLength(0);
    expect(second.registryAdditions).toEqual({});
  });

  it("ignores hallucinated card ids the model returns", async () => {
    const cards = [card("a"), card("b")];
    const r = await consolidateTasks(cards, {}, jsonStub([
      { card_id: "a", task_title: "t" },
      { card_id: "ghost", task_title: "t" }, // not an open card
    ]));
    // Only 'a' is real → single member of a new task → not applied.
    expect(r.updatedActions).toHaveLength(0);
  });

  it("no-ops with fewer than two open cards", async () => {
    const r = await consolidateTasks([card("a")], {}, jsonStub([{ card_id: "a", task_title: "t" }]));
    expect(r.updatedActions).toHaveLength(0);
    expect(r.registryAdditions).toEqual({});
  });

  it("no-ops when the model returns no assignments", async () => {
    const r = await consolidateTasks([card("a"), card("b")], {}, jsonStub([]));
    expect(r.updatedActions).toHaveLength(0);
  });
});

// Each of these rules is a merge that really happened and made the owner's list
// unusable. Deleting one brings that merge back.
describe("consolidate prompt: what is NOT one task", () => {
  const system = buildConsolidationRequest({ cards: [], registry: {} }).system;

  it("forbids an invented umbrella, naming the merge that caused the rule", () => {
    expect(system).toContain("NEVER INVENT AN UMBRELLA");
    expect(system).toContain("中国出差网络与设备安全方案");
  });

  it("rejects a title that joins two objectives", () => {
    expect(system).toContain('needs "+" or "与" to join TWO objectives');
  });

  it("keeps the same-person, same-supplier, same-keyword and same-message rules", () => {
    expect(system).toContain("The SAME sender is NOT enough to group");
    expect(system).toContain("The SAME supplier / vendor / partner");
    expect(system).toContain("A shared KEYWORD is not a shared");
    expect(system).toContain("The SAME MESSAGE is not enough");
  });
});
