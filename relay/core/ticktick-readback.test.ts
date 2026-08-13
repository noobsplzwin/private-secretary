import { describe, expect, it } from "vitest";
import { diffTickTickReadback, type RemoteTask } from "./ticktick-readback.js";
import type { SyncMap } from "./ticktick-sync.js";

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

const task = (id: string, items: Array<[string, number]> = []): RemoteTask => ({
  id,
  status: 0,
  items: items.map(([i, status]) => ({ id: i, status })),
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

  it("is silent when nothing was ticked", () => {
    const r = diffTickTickReadback(map, [task("tt1", [["i1", 0], ["i2", 0]]), task("tt2")]);
    expect(r).toEqual({ doneActionIds: [], doneUnitKeys: [] });
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
