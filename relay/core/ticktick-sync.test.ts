import { describe, expect, it } from "vitest";
import {
  applySyncOps,
  diffTickTickSync,
  hashPayload,
  summarize,
  type SyncMap,
} from "./ticktick-sync.js";
import type { TickTickTaskPayload } from "./ticktick.js";

const payload = (over: Partial<TickTickTaskPayload> = {}): TickTickTaskPayload => ({
  title: "Send the SoW",
  kind: "TEXT",
  priority: 3,
  content: "notes",
  ...over,
});

const rec = (id: string, p: TickTickTaskPayload) => ({
  ticktickId: id,
  projectId: "proj",
  hash: hashPayload(p),
});

describe("diffTickTickSync", () => {
  it("creates a to-do TickTick has never seen", () => {
    const ops = diffTickTickSync([{ unitKey: "u1", payload: payload() }], {});
    expect(ops).toEqual([{ kind: "create", unitKey: "u1", payload: payload() }]);
  });

  // THE point of the whole map: the engine regenerates its to-do list every
  // refresh, so without this an unchanged to-do is re-created every 30 minutes.
  it("skips an unchanged to-do instead of re-creating it", () => {
    const p = payload();
    const map: SyncMap = { u1: rec("tt1", p) };
    expect(diffTickTickSync([{ unitKey: "u1", payload: p }], map)).toEqual([
      { kind: "skip", unitKey: "u1" },
    ]);
  });

  it("updates in place when the content changed", () => {
    const map: SyncMap = { u1: rec("tt1", payload()) };
    const ops = diffTickTickSync([{ unitKey: "u1", payload: payload({ priority: 5 }) }], map);
    expect(ops).toEqual([
      {
        kind: "update",
        unitKey: "u1",
        ticktickId: "tt1",
        projectId: "proj",
        payload: payload({ priority: 5 }),
      },
    ]);
  });

  // Completed, not deleted — the owner may have annotated the task, and this
  // engine does not destroy their data.
  it("completes a to-do that is no longer open", () => {
    const map: SyncMap = { gone: rec("tt9", payload()) };
    expect(diffTickTickSync([], map)).toEqual([
      { kind: "complete", unitKey: "gone", ticktickId: "tt9", projectId: "proj" },
    ]);
  });

  it("handles create, skip, update and complete in one cycle", () => {
    const same = payload({ title: "same" });
    const map: SyncMap = { u1: rec("tt1", same), u2: rec("tt2", payload({ title: "old" })), u3: rec("tt3", same) };
    const ops = diffTickTickSync(
      [
        { unitKey: "u1", payload: same },
        { unitKey: "u2", payload: payload({ title: "new" }) },
        { unitKey: "u4", payload: payload({ title: "fresh" }) },
      ],
      map,
    );
    expect(summarize(ops)).toEqual({ create: 1, update: 1, complete: 1, skip: 1 });
  });

  // A repeated unitKey in one cycle is an upstream bug; syncing it twice would
  // put two TickTick tasks behind one to-do.
  it("drops a duplicate unitKey within a cycle", () => {
    const ops = diffTickTickSync(
      [
        { unitKey: "u1", payload: payload() },
        { unitKey: "u1", payload: payload({ title: "other" }) },
      ],
      {},
    );
    expect(ops).toHaveLength(1);
  });
});

describe("hashPayload", () => {
  it("ignores key order so a reassembled payload is not a false change", () => {
    const a = { title: "t", kind: "TEXT", priority: 3 } as TickTickTaskPayload;
    const b = { priority: 3, kind: "TEXT", title: "t" } as TickTickTaskPayload;
    expect(hashPayload(a)).toBe(hashPayload(b));
  });

  it("ignores undefined fields, which the optional branches leave behind", () => {
    const a = payload();
    const b = { ...payload(), tags: undefined } as TickTickTaskPayload;
    expect(hashPayload(a)).toBe(hashPayload(b));
  });

  it("changes when anything real changes, nested included", () => {
    expect(hashPayload(payload())).not.toBe(hashPayload(payload({ priority: 5 })));
    expect(hashPayload(payload({ items: [{ title: "a", status: 0, sortOrder: 0 }] }))).not.toBe(
      hashPayload(payload({ items: [{ title: "b", status: 0, sortOrder: 0 }] })),
    );
  });
});

describe("applySyncOps", () => {
  it("records a created id so the next cycle updates instead of duplicating", () => {
    const ops = diffTickTickSync([{ unitKey: "u1", payload: payload() }], {});
    const next = applySyncOps({}, ops, { u1: { ticktickId: "tt1", projectId: "proj" } });
    expect(next.u1).toEqual({ ticktickId: "tt1", projectId: "proj", hash: hashPayload(payload()) });
    // and the following cycle is a no-op
    expect(diffTickTickSync([{ unitKey: "u1", payload: payload() }], next)).toEqual([
      { kind: "skip", unitKey: "u1" },
    ]);
  });

  // REGRESSION: recording a unitKey whose create FAILED would lose that to-do
  // forever — the next cycle would see it as known and skip it.
  it("leaves a failed create out of the map so it retries", () => {
    const ops = diffTickTickSync([{ unitKey: "u1", payload: payload() }], {});
    expect(applySyncOps({}, ops, {})).toEqual({});
  });

  it("drops a completed unit from the map", () => {
    const map: SyncMap = { gone: rec("tt9", payload()) };
    expect(applySyncOps(map, diffTickTickSync([], map), {})).toEqual({});
  });

  it("re-hashes after an update so the next cycle skips", () => {
    const map: SyncMap = { u1: rec("tt1", payload()) };
    const changed = payload({ priority: 5 });
    const next = applySyncOps(map, diffTickTickSync([{ unitKey: "u1", payload: changed }], map), {
      u1: { ticktickId: "tt1", projectId: "proj" },
    });
    expect(diffTickTickSync([{ unitKey: "u1", payload: changed }], next)).toEqual([
      { kind: "skip", unitKey: "u1" },
    ]);
  });

  // An update that failed must NOT be recorded as done, or the changed content
  // never reaches TickTick and the task silently goes stale forever.
  it("leaves a failed update un-hashed so it retries", () => {
    const map: SyncMap = { u1: rec("tt1", payload()) };
    const changed = payload({ priority: 5 });
    const next = applySyncOps(map, diffTickTickSync([{ unitKey: "u1", payload: changed }], map), {});
    expect(diffTickTickSync([{ unitKey: "u1", payload: changed }], next)[0]!.kind).toBe("update");
  });

  // An update rewrites the checklist, so TickTick can hand back NEW item ids.
  // Keeping the stale ones would leave a ticked item pointing at nothing.
  it("stores the item→action map returned by a write", () => {
    const ops = diffTickTickSync([{ unitKey: "u1", payload: payload() }], {});
    const next = applySyncOps({}, ops, {
      u1: { ticktickId: "tt1", projectId: "proj", items: [{ itemId: "i1", actionId: "cal1" }] },
    });
    expect(next.u1!.items).toEqual([{ itemId: "i1", actionId: "cal1" }]);
  });
});
