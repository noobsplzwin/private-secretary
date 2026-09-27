import { describe, expect, it } from "vitest";
import { diffTickTickReadback, type RemoteTask } from "./ticktick-readback.js";
import type { SyncMap } from "./ticktick-sync.js";
import { DISMISS_LINE } from "./ticktick-plan.js";

const map: SyncMap = {
  u1: {
    ticktickId: "tt1",
    projectId: "p",
    hash: "h",
    items: [
      { itemId: "i1", actionId: "a1" },
      { itemId: "i2", actionId: "a2" },
    ],
  },
  u2: { ticktickId: "tt2", projectId: "p", hash: "h" },
};

const task = (id: string, items: Array<[string, number, string?]> = []): RemoteTask => ({
  id,
  status: 0,
  items: items.map(([i, status, title]) => ({ id: i, status, ...(title ? { title } : {}) })),
});

describe("diffTickTickReadback", () => {
  it("reports an item the owner ticked", () => {
    const r = diffTickTickReadback(map, [task("tt1", [["i1", 1], ["i2", 0]]), task("tt2")]);
    expect(r.doneActionIds).toEqual(["a1"]);
    expect(r.doneUnitKeys).toEqual([]);
  });

  // A tracked task missing from the ACTIVE list was completed or deleted, and
  // both mean the same thing: stop resurfacing it.
  it("closes a whole unit whose task is gone", () => {
    const r = diffTickTickReadback(map, [task("tt1")]);
    expect(r.doneUnitKeys).toEqual(["u2"]);
  });

  // The owner's only free verdict. It must never be read as an approval: a
  // dismissed task's other ticks are whatever he clicked on the way out, and
  // executing one would send something he has just called a mistake.
  it("reports a dismissal and suppresses that task's other ticks", () => {
    const r = diffTickTickReadback(map, [
      task("tt1", [["i1", 1], ["i2", 0], ["ix", 1, DISMISS_LINE]]),
      task("tt2"),
    ]);
    expect(r.dismissedUnitKeys).toEqual(["u1"]);
    expect(r.doneActionIds).toEqual([]);
    expect(r.doneUnitKeys).toEqual([]);
  });

  // Untouched, it is inert — the row behaves exactly as it did before the line
  // existed, so adding it to every task changes nothing until it is ticked.
  it("is inert while the dismissal line is unticked", () => {
    const r = diffTickTickReadback(map, [
      task("tt1", [["i1", 1], ["ix", 0, DISMISS_LINE]]),
      task("tt2"),
    ]);
    expect(r.dismissedUnitKeys).toEqual([]);
    expect(r.doneActionIds).toEqual(["a1"]);
  });

  it("is silent when nothing was ticked", () => {
    const r = diffTickTickReadback(map, [task("tt1", [["i1", 0], ["i2", 0]]), task("tt2")]);
    expect(r).toEqual({ doneActionIds: [], doneUnitKeys: [], dismissedUnitKeys: [] });
  });

  // Our own sync replaces the checklist on every update, minting new item ids,
  // so a tracked id missing from the task is the NORMAL state after a re-sync.
  // Treating absence as "done" would close every action on the next push.
  it("does not treat a missing item id as done", () => {
    const r = diffTickTickReadback(map, [task("tt1", [["fresh-id", 0]]), task("tt2")]);
    expect(r.doneActionIds).toEqual([]);
  });

  // A task in the live project came back carrying completedTime with status 0.
  // Reading the timestamp would close a task the owner deliberately reopened.
  it("reads status, never completedTime", () => {
    const reopened = { ...task("tt1"), completedTime: "2026-08-13T17:02:29+0000" } as RemoteTask;
    const r = diffTickTickReadback(map, [reopened, task("tt2")]);
    expect(r.doneUnitKeys).toEqual([]);
  });

  // Defensive: the reader asks for undone tasks, but a completed one arriving
  // in that list must not count as active.
  it("ignores a completed task that arrives in the active list", () => {
    const r = diffTickTickReadback(map, [{ ...task("tt1"), status: 2 }, task("tt2")]);
    expect(r.doneUnitKeys).toEqual(["u1"]);
  });
});

// REGRESSION 2026-09-27 — the false-close that emptied the ledger.
//
// The readback listed only the Work project while SUNK rows are created in
// 待办池. A row that sank went missing from `remote` on the very next tick and
// was read as "the owner finished it": 95 of 95 pool rows tombstoned, all 95
// still open in TickTick, 94 commitments closed behind his back.
describe("absence only means done when we looked everywhere", () => {
  const map = {
    work_row: { ticktickId: "tt-work", projectId: "P-work", hash: "h" },
    pool_row: { ticktickId: "tt-pool", projectId: "P-pool", hash: "h" },
  };

  it("closes nothing from absence when a project could not be read", () => {
    // Only the Work project came back, and the caller says so.
    const r = diffTickTickReadback(map, [{ id: "tt-work", status: 0 }], false);
    expect(r.doneUnitKeys).toEqual([]);
  });

  it("still closes what is genuinely absent once both projects are read", () => {
    // Both listed; the pool row is gone from it, so the owner really did finish it.
    const r = diffTickTickReadback(map, [{ id: "tt-work", status: 0 }], true);
    expect(r.doneUnitKeys).toEqual(["pool_row"]);
  });

  it("a partial read still lands ticks and dismissals — those are positive", () => {
    const withDismiss = {
      pool_row: {
        ticktickId: "tt-pool",
        projectId: "P-pool",
        hash: "h",
        items: [{ itemId: "i1", actionId: "a1" }],
      },
    };
    const r = diffTickTickReadback(
      withDismiss,
      [{ id: "tt-pool", status: 0, items: [{ id: "i1", status: 1 }] }],
      false,
    );
    expect(r.doneActionIds).toEqual(["a1"]);
  });
});
