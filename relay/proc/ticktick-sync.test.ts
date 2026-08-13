import { describe, expect, it, vi } from "vitest";
import { readbackFromTickTick, syncToTickTick, taskUnitsFrom, type TickTickWriter } from "./ticktick-sync.js";
import type { SyncMap } from "../core/ticktick-sync.js";
import type { ActionItem } from "../core/action-item.js";
import type { LoopState } from "../io/state.js";

const action = (over: Partial<ActionItem> = {}): ActionItem => ({
  id: "a1",
  source_message_id: "slack:C1:1",
  action_type: "task",
  target: {},
  reason: "r",
  confidence: 0.9,
  params: { title: "订机票" },
  status: "suggested",
  created_at: "2026-08-12T00:00:00Z",
  ...over,
});

const state = (over: Partial<LoopState> = {}): LoopState =>
  ({
    version: 2,
    marks: {},
    actions: [],
    outcomes: [],
    sourceErrors: {},
    tasks: {},
    plans: {},
    ...over,
  }) as LoopState;

function writer(over: Partial<TickTickWriter> = {}): TickTickWriter {
  return {
    createTask: vi.fn(async () => ({ id: "tt1", projectId: "p", itemIds: [] })),
    updateTask: vi.fn(async () => ({ itemIds: [] })),
    completeTasks: vi.fn(async () => {}),
    ...over,
  };
}

describe("taskUnitsFrom", () => {
  it("makes one unit per task cluster, marked grouped", () => {
    const s = state({
      actions: [action({ id: "a1", task_id: "T1" }), action({ id: "a2", task_id: "T1" })],
      tasks: { T1: { title: "香港出差", created_at: "2026-08-01T00:00:00Z" } },
    });
    const units = taskUnitsFrom(s);
    expect(units).toHaveLength(1);
    expect(units[0]!.title).toBe("香港出差");
    expect(units[0]!.grouped).toBe(true);
    expect(units[0]!.members).toHaveLength(2);
  });

  // groupByTask returns ALL standalone actions in one `task_id: null` bucket.
  // That bucket is a rendering convenience, not a task, so it gets split.
  it("splits the ungrouped bucket into one unit per action", () => {
    const s = state({ actions: [action({ id: "a1" }), action({ id: "a2" })] });
    const units = taskUnitsFrom(s);
    expect(units).toHaveLength(2);
    expect(units.every((u) => !u.grouped)).toBe(true);
    expect(new Set(units.map((u) => u.unitKey)).size).toBe(2);
  });

  // A human dragging a task to another tier must survive re-ranking.
  it("lets a manual tier override win over the computed tier", () => {
    const s = state({
      actions: [action({ task_id: "T1" })],
      tasks: { T1: { title: "T", created_at: "x" } },
      plans: { T1: { tier: "C", rank: 3, why: "w", at: "x" } },
      planOverrides: { T1: "A" },
    });
    expect(taskUnitsFrom(s)[0]!.plan?.tier).toBe("A");
    expect(taskUnitsFrom(s)[0]!.plan?.why).toBe("w"); // rest of the plan intact
  });
});

describe("syncToTickTick", () => {
  const grouped = (over: Partial<LoopState> = {}) =>
    state({
      actions: [action({ task_id: "T1" })],
      tasks: { T1: { title: "香港出差", created_at: "x" } },
      plans: { T1: { tier: "A", rank: 0, why: "下周就要走", at: "x" } },
      ...over,
    });

  it("creates a task it has never synced and records its id", async () => {
    const w = writer();
    const { map, report } = await syncToTickTick(grouped(), {}, w, "America/Winnipeg");
    expect(w.createTask).toHaveBeenCalledOnce();
    expect(report.created).toBe(1);
    expect(map.T1!.ticktickId).toBe("tt1");
  });

  // THE point of the hash gate: a steady state must be silent, or the account
  // gets rate limited rewriting 40 unchanged tasks every 30 minutes.
  it("makes ZERO calls when nothing changed", async () => {
    const w1 = writer();
    const { map } = await syncToTickTick(grouped(), {}, w1, "America/Winnipeg");

    const w2 = writer();
    const { report } = await syncToTickTick(grouped(), map, w2, "America/Winnipeg");
    expect(w2.createTask).not.toHaveBeenCalled();
    expect(w2.updateTask).not.toHaveBeenCalled();
    expect(w2.completeTasks).not.toHaveBeenCalled();
    expect(report.skipped).toBe(1);
  });

  it("updates in place when the plan changed", async () => {
    const { map } = await syncToTickTick(grouped(), {}, writer(), "America/Winnipeg");
    const w = writer();
    // A→B, not A→C: C is no longer synced at all, so a C re-tier is a DE-LIST
    // (completed) rather than the in-place update this test is about.
    const retiered = grouped({ plans: { T1: { tier: "B", rank: 9, why: "缓了", at: "x" } } });
    const { report } = await syncToTickTick(retiered, map, w, "America/Winnipeg");
    expect(w.updateTask).toHaveBeenCalledOnce();
    expect(report.updated).toBe(1);
    expect(w.createTask).not.toHaveBeenCalled(); // NOT a second copy
  });


  // READ-BACK. The whole point: work finished in TickTick must stop being
  // resurfaced. The owner's OSYX task was done and shipped and its cards stayed
  // open forever, because a card only left `suggested` via a cockpit click.
  it("read-back marks a gone task's live members done and drops it from the map", () => {
    const st = grouped();
    const map = { T1: { ticktickId: "tt1", projectId: "p", hash: "h" } };
    const r = readbackFromTickTick(st, map, []); // tt1 no longer active
    expect(r.doneActionIds).toEqual(st.actions.map((a) => a.id));
    expect(r.map).toEqual({});
    expect(r.unitsClosed).toBe(1);
  });

  it("read-back leaves an active task alone", () => {
    const st = grouped();
    const map = { T1: { ticktickId: "tt1", projectId: "p", hash: "h" } };
    const r = readbackFromTickTick(st, map, [{ id: "tt1", status: 0, items: [] }]);
    expect(r.doneActionIds).toEqual([]);
    expect(r.map).toEqual(map);
  });

  it("completes a task that is no longer open", async () => {
    const { map } = await syncToTickTick(grouped(), {}, writer(), "America/Winnipeg");
    const w = writer();
    const { map: after, report } = await syncToTickTick(state(), map, w, "America/Winnipeg");
    expect(w.completeTasks).toHaveBeenCalledWith([{ id: "tt1", projectId: "p" }]);
    expect(report.completed).toBe(1);
    expect(after.T1).toBeUndefined();
  });

  it("pairs returned checklist item ids to the actions they approve", async () => {
    const s = grouped({
      actions: [
        action({ id: "m1", task_id: "T1", params: { title: "订机票" } }),
        action({
          id: "cal1",
          task_id: "T1",
          action_type: "calendar",
          params: { title: "对齐", start: "2026-08-20T09:00:00-05:00", attendees: ["k@x.com"] },
        }),
      ],
    });
    const w = writer({
      createTask: vi.fn(async () => ({ id: "tt1", projectId: "p", itemIds: ["i0", "i1"] })),
    });
    const { map } = await syncToTickTick(s, {}, w, "America/Winnipeg");
    // slot 1 is the invite line; slot 0 is the plain 订机票 step
    expect(map.T1!.items).toEqual([{ itemId: "i1", actionId: "cal1" }]);
  });

  // REGRESSION: recording a failed create would make the next cycle skip it,
  // losing the to-do forever. Same asymmetry that cost 803 tasks in the
  // Microsoft To Do migration.
  it("does not record a create that threw, so it retries", async () => {
    const w = writer({
      createTask: vi.fn(async () => {
        throw new Error("429");
      }),
    });
    const { map, report } = await syncToTickTick(grouped(), {}, w, "America/Winnipeg");
    expect(map.T1).toBeUndefined();
    expect(report.created).toBe(0);
    expect(report.failed).toBe(1);
  });

  it("keeps going after one task fails", async () => {
    const s = state({
      actions: [action({ id: "a1", task_id: "T1" }), action({ id: "a2", task_id: "T2" })],
      tasks: { T1: { title: "A", created_at: "x" }, T2: { title: "B", created_at: "x" } },
      plans: {
        T1: { tier: "A", rank: 0, why: "", at: "x" },
        T2: { tier: "A", rank: 1, why: "", at: "x" },
      },
    });
    let n = 0;
    const w = writer({
      createTask: vi.fn(async () => {
        if (n++ === 0) throw new Error("boom");
        return { id: "tt2", projectId: "p", itemIds: [] };
      }),
    });
    const { report } = await syncToTickTick(s, {}, w, "America/Winnipeg");
    expect(report.created).toBe(1);
    expect(report.failed).toBe(1);
  });

  // A complete that threw must stay in the map, or the task is orphaned:
  // dropped from our records while still sitting open in TickTick.
  it("keeps a failed complete in the map so it retries", async () => {
    const { map } = await syncToTickTick(grouped(), {}, writer(), "America/Winnipeg");
    const w = writer({
      completeTasks: vi.fn(async () => {
        throw new Error("nope");
      }),
    });
    const { map: after, report } = await syncToTickTick(state(), map, w, "America/Winnipeg");
    expect(after.T1).toBeDefined();
    expect(report.completed).toBe(0);
    expect(report.failed).toBe(1);
  });

  it("does not sync D-tier or ungrouped non-A cards", async () => {
    const s = state({
      actions: [action({ id: "d1", task_id: "T1" }), action({ id: "loose" })],
      tasks: { T1: { title: "D task", created_at: "x" } },
      plans: {
        T1: { tier: "D", rank: 9, why: "", at: "x" },
      },
    });
    const w = writer();
    const { report } = await syncToTickTick(s, {}, w, "America/Winnipeg");
    expect(w.createTask).not.toHaveBeenCalled();
    expect(report.created).toBe(0);
  });
});
