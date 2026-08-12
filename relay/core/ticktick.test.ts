import { describe, expect, it } from "vitest";
import {
  ENGINE_TAG,
  buildTickTickTask,
  resolveTickTickProject,
  tierToPriority,
} from "./ticktick.js";
import type { ActionItem } from "./action-item.js";
import type { TaskPlan } from "./tasks.js";

function task(over: Partial<ActionItem> = {}): ActionItem {
  return {
    id: "a1",
    source_message_id: "slack:C1:123",
    action_type: "task",
    target: { platform: "slack" },
    reason: "Leo owns this",
    confidence: 0.8,
    params: { title: "Send the SoW" },
    status: "approved",
    created_at: "2026-08-12T00:00:00Z",
    ...over,
  };
}

function plan(over: Partial<TaskPlan> = {}): TaskPlan {
  return { tier: "A", rank: 0, why: "client is blocked", at: "2026-08-12T00:00:00Z", ...over };
}

describe("tierToPriority", () => {
  it("maps A/B/C/D onto TickTick's 5/3/1/0", () => {
    expect(tierToPriority("A")).toBe(5);
    expect(tierToPriority("B")).toBe(3);
    expect(tierToPriority("C")).toBe(1);
    expect(tierToPriority("D")).toBe(0);
  });

  // An unranked card must not get an invented middle priority — that silently
  // reorders a real to-do list.
  it("is 'none' when the ranking pass hasn't run yet", () => {
    expect(tierToPriority(undefined)).toBe(0);
  });
});

describe("buildTickTickTask", () => {
  it("carries the title, the plan priority and the engine tag", () => {
    const p = buildTickTickTask(task(), { plan: plan({ tier: "B" }) });
    expect(p.title).toBe("Send the SoW");
    expect(p.priority).toBe(3);
    expect(p.tags).toEqual([ENGINE_TAG]);
  });

  it("is a TEXT task with notes when there are no next actions", () => {
    const p = buildTickTickTask(task({ summary: "Client asked for the SoW." }), { plan: plan() });
    expect(p.kind).toBe("TEXT");
    expect(p.items).toBeUndefined();
    expect(p.content).toContain("Client asked for the SoW.");
    expect(p.content).toContain("Why now: client is blocked");
  });

  it("turns next_actions into an unchecked checklist", () => {
    const p = buildTickTickTask(task({ next_actions: ["Draft it", "  ", "Send to Kevin"] }), {});
    expect(p.kind).toBe("CHECKLIST");
    expect(p.items).toEqual([
      { title: "Draft it", status: 0, sortOrder: 0 },
      { title: "Send to Kevin", status: 0, sortOrder: 1 },
    ]);
    // Notes move to desc for a CHECKLIST — TickTick ignores content there.
    expect(p.desc).toBeTruthy();
    expect(p.content).toBeUndefined();
  });

  it("records provenance so the to-do is traceable without the cockpit", () => {
    const p = buildTickTickTask(
      task({ context: { sender_name: "Kevin", sent_at: "2026-06-11T10:00:00Z" } }),
      {},
    );
    expect(p.content).toContain("slack");
    expect(p.content).toContain("Kevin");
    expect(p.content).toContain("2026-06-11");
  });

  it("includes plan entities, which are what the user needs to finish it", () => {
    const p = buildTickTickTask(task(), {
      plan: plan({ entities: [{ kind: "price", label: "创达报价", value: "¥6,712", source: "WeChat · 张工" }] }),
    });
    expect(p.content).toContain("创达报价: ¥6,712");
    expect(p.content).toContain("WeChat · 张工");
  });

  it("throws rather than inventing a placeholder title", () => {
    expect(() => buildTickTickTask(task({ params: { title: "  " } }))).toThrow(/no params.title/);
  });
});

describe("resolveTickTickProject", () => {
  const projects = [
    { id: "1", name: "💼Work" },
    { id: "2", name: "🏡Memo" },
    { id: "3", name: "秦老师" },
  ];

  it("resolves an exact name, ignoring case and surrounding space", () => {
    expect(resolveTickTickProject("  💼work ", projects)).toEqual({ status: "resolved", id: "1" });
    expect(resolveTickTickProject("秦老师", projects)).toEqual({ status: "resolved", id: "3" });
  });

  // ASK-not-GUESS: a near miss must not file the to-do somewhere the user
  // never looks.
  it("does not resolve a partial or fuzzy match", () => {
    expect(resolveTickTickProject("Work", projects)).toEqual({ status: "not_found" });
    expect(resolveTickTickProject("", projects)).toEqual({ status: "not_found" });
  });

  it("reports ambiguity instead of picking one", () => {
    const dupes = [{ id: "1", name: "Work" }, { id: "2", name: "work" }];
    expect(resolveTickTickProject("Work", dupes)).toEqual({
      status: "ambiguous",
      matches: ["1", "2"],
    });
  });
});
