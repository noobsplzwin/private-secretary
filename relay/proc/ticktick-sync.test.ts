import { describe, expect, it, vi } from "vitest";
import { readbackFromTickTick, syncToTickTick, cardRows, taskUnitsFrom, type TickTickWriter } from "./ticktick-sync.js";
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
  // A real card always has one; unitKey falls back to the action id without it,
  // which hides the conversation-keying these tests are about.
  context: { sender_handle: "U_SAM" },
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


// Test adapter for the new signature: the old tests exercised the sync straight
// from a state fixture. Rows are assembled the way PHASE 6b now does, with every
// unit treated as persona-less so the card fixtures keep rendering.
const rowsFrom = (st: Parameters<typeof cardRows>[0]) => cardRows(st, "America/Winnipeg", Date.now(), () => true);

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
    const s = state({
      actions: [action({ id: "a1", headline: "订机票" }), action({ id: "a2", headline: "订酒店" })],
    });
    const units = taskUnitsFrom(s);
    expect(units).toHaveLength(2);
    expect(units.every((u) => !u.grouped)).toBe(true);
    expect(new Set(units.map((u) => u.unitKey)).size).toBe(2);
  });

  // Two cards that really do say the same thing share one row, with BOTH as
  // members — a repeated key is dropped by diffTickTickSync, and dropping is
  // how three real to-dos went missing.
  it("merges two ungrouped cards that carry the same headline", () => {
    const s = state({
      actions: [action({ id: "a1", headline: "订机票" }), action({ id: "a2", headline: "订机票" })],
    });
    const units = taskUnitsFrom(s);
    expect(units).toHaveLength(1);
    expect(units[0]!.members).toHaveLength(2);
  });

});

describe("syncToTickTick", () => {
  const grouped = (over: Partial<LoopState> = {}) =>
    state({
      actions: [action({ task_id: "T1" })],
      tasks: { T1: { title: "香港出差", created_at: "x" } },
      ...over,
    });

  it("creates a task it has never synced and records its id", async () => {
    const w = writer();
    const { map, report } = await syncToTickTick(rowsFrom(grouped()), {}, w);
    expect(w.createTask).toHaveBeenCalledOnce();
    expect(report.created).toBe(1);
    expect(map.T1!.ticktickId).toBe("tt1");
  });

  // THE point of the hash gate: a steady state must be silent, or the account
  // gets rate limited rewriting 40 unchanged tasks every 30 minutes.
  it("makes ZERO calls when nothing changed", async () => {
    const w1 = writer();
    const { map } = await syncToTickTick(rowsFrom(grouped()), {}, w1);

    const w2 = writer();
    const { report } = await syncToTickTick(rowsFrom(grouped()), map, w2);
    expect(w2.createTask).not.toHaveBeenCalled();
    expect(w2.updateTask).not.toHaveBeenCalled();
    expect(w2.completeTasks).not.toHaveBeenCalled();
    expect(report.skipped).toBe(1);
  });

  it("updates in place when the payload changed", async () => {
    const { map } = await syncToTickTick(rowsFrom(grouped()), {}, writer());
    const w = writer();
    const changed = grouped({
      actions: [action({ task_id: "T1", next_actions: ["订 8/30 的机票"] })],
    });
    const { report } = await syncToTickTick(rowsFrom(changed), map, w);
    expect(w.updateTask).toHaveBeenCalledOnce();
    expect(report.updated).toBe(1);
    expect(w.createTask).not.toHaveBeenCalled(); // NOT a second copy
  });


  // READ-BACK. The whole point: work finished in TickTick must stop being
  // resurfaced. The owner's OSYX task was done and shipped and its cards stayed
  // open forever, because a card only left `suggested` via a cockpit click.
  it("read-back marks a gone task's live members done and TOMBSTONES it", () => {
    const st = grouped();
    const map = { T1: { ticktickId: "tt1", projectId: "p", hash: "h" } };
    const r = readbackFromTickTick(st, map, []); // tt1 no longer active
    expect(r.closed).toEqual(st.actions.map((a) => a.id));
    expect(r.ticked).toEqual([]); // a task close is never an execution request
    // Remembered, not dropped: forgetting an owner-finished task is the same
    // forget that minted calendar twins when the ENGINE finished one.
    expect(r.map.T1!.done).toBeGreaterThan(0);
    expect(r.unitsClosed).toBe(1);
  });

  // The other half of the same fix: a tombstone must not read as "the owner
  // finished it" again on every subsequent tick.
  it("read-back ignores tombstones instead of re-closing them forever", () => {
    const st = grouped();
    const map = { T1: { ticktickId: "tt1", projectId: "p", hash: "h", done: 123 } };
    const r = readbackFromTickTick(st, map, []);
    expect(r.ticked).toEqual([]);
    expect(r.closed).toEqual([]);
    expect(r.unitsClosed).toBe(0);
    expect(r.map).toEqual(map);
  });

  it("read-back leaves an active task alone", () => {
    const st = grouped();
    const map = { T1: { ticktickId: "tt1", projectId: "p", hash: "h" } };
    const r = readbackFromTickTick(st, map, [{ id: "tt1", status: 0, items: [] }]);
    expect(r.ticked).toEqual([]);
    expect(r.closed).toEqual([]);
    expect(r.map).toEqual(map);
  });

  // REGRESSION: ungrouped units keyed by CONVERSATION collided, and
  // diffTickTickSync silently drops a repeated key — one contact's three cards
  // became one row and two real to-dos vanished with no error anywhere.
  it("gives each ungrouped card from one contact its own row", () => {
    const st = state({
      actions: [
        action({ id: "a1", headline: "Hand 3 house keys to Sam" }),
        action({ id: "a2", headline: "Book house cleaner before Sept 1" }),
      ],
    });
    const keys = taskUnitsFrom(st).map((u) => u.unitKey);
    expect(new Set(keys).size).toBe(2);
  });

  // ...but the row must survive a refresh, which reissues the card with a fresh
  // id. Same conversation + same headline = same row, updated in place.
  it("keeps the same row when a card is reissued with the same headline", () => {
    const one = taskUnitsFrom(state({ actions: [action({ id: "a1", headline: "Same work" })] }));
    const two = taskUnitsFrom(state({ actions: [action({ id: "FRESH", headline: "Same work" })] }));
    expect(two[0]!.unitKey).toBe(one[0]!.unitKey);
  });

  it("completes a task that is no longer open", async () => {
    const { map } = await syncToTickTick(rowsFrom(grouped()), {}, writer());
    const w = writer();
    const { map: after, report } = await syncToTickTick(rowsFrom(state()), map, w);
    expect(w.completeTasks).toHaveBeenCalledWith([{ id: "tt1", projectId: "p" }]);
    expect(report.completed).toBe(1);
    // A tombstone, not a deletion: forgetting completed rows is what filled the
    // owner's calendar with copies of the same task.
    expect(after.T1!.done).toBeGreaterThan(0);
  });

  it("reopens a completed task with status:0 instead of creating a twin", async () => {
    const { map } = await syncToTickTick(rowsFrom(grouped()), {}, writer());
    const w1 = writer();
    const { map: tombed } = await syncToTickTick(rowsFrom(state()), map, w1); // completes tt1
    const w2 = writer();
    await syncToTickTick(rowsFrom(grouped()), tombed, w2); // …and it comes back
    expect(w2.createTask).not.toHaveBeenCalled();
    expect(w2.updateTask).toHaveBeenCalledWith(
      "tt1",
      "p",
      expect.objectContaining({ status: 0 }),
    );
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
    const { map } = await syncToTickTick(rowsFrom(s), {}, w);
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
    const { map, report } = await syncToTickTick(rowsFrom(grouped()), {}, w);
    expect(map.T1).toBeUndefined();
    expect(report.created).toBe(0);
    expect(report.failed).toBe(1);
  });

  it("keeps going after one task fails", async () => {
    const s = state({
      actions: [action({ id: "a1", task_id: "T1" }), action({ id: "a2", task_id: "T2" })],
      tasks: { T1: { title: "A", created_at: "x" }, T2: { title: "B", created_at: "x" } },
    });
    let n = 0;
    const w = writer({
      createTask: vi.fn(async () => {
        if (n++ === 0) throw new Error("boom");
        return { id: "tt2", projectId: "p", itemIds: [] };
      }),
    });
    const { report } = await syncToTickTick(rowsFrom(s), {}, w);
    expect(report.created).toBe(1);
    expect(report.failed).toBe(1);
  });

  // A complete that threw must stay in the map, or the task is orphaned:
  // dropped from our records while still sitting open in TickTick.
  it("keeps a failed complete in the map so it retries", async () => {
    const { map } = await syncToTickTick(rowsFrom(grouped()), {}, writer());
    const w = writer({
      completeTasks: vi.fn(async () => {
        throw new Error("nope");
      }),
    });
    const { map: after, report } = await syncToTickTick(rowsFrom(state()), map, w);
    expect(after.T1).toBeDefined();
    expect(report.completed).toBe(0);
    expect(report.failed).toBe(1);
  });

  // The LEDGER owns a persona sender's plain work now. A card from a known
  // contact renders only when it carries an executable line — anything else on
  // the list would be the same to-do twice, from two sources.
  it("does not sync a persona sender's plain cards — the ledger owns them", async () => {
    const s = state({
      actions: [action({ id: "d1", task_id: "T1" }), action({ id: "loose" })],
      tasks: { T1: { title: "some task", created_at: "x" } },
    });
    const w = writer();
    const knownPersona = () => false; // every unit resolves to a persona
    const rows = cardRows(s, "America/Winnipeg", Date.now(), knownPersona);
    const { report } = await syncToTickTick(rows, {}, w);
    expect(w.createTask).not.toHaveBeenCalled();
    expect(report.created).toBe(0);
  });
});
