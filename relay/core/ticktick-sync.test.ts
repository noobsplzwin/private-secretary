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
  title: p.title,
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
    expect(next.u1).toEqual({
      ticktickId: "tt1",
      projectId: "proj",
      hash: hashPayload(payload()),
      title: payload().title,
    });
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

  // THE CALENDAR-DUPLICATE BUG. This assertion used to demand the opposite —
  // that a completed unit be DELETED from the map. Forgetting is what minted a
  // fresh TickTick task (and a fresh Google Calendar event) every time the same
  // to-do came back via a tier flap or a regeneration: the real account held
  // SEVEN copies of one task. Completed rows are remembered as tombstones now.
  it("keeps a completed unit as a tombstone", () => {
    const map: SyncMap = { gone: rec("tt9", payload()) };
    const next = applySyncOps(map, diffTickTickSync([], map), {}, 1234);
    expect(next.gone).toEqual({ ...rec("tt9", payload()), done: 1234 });
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

// The duplicate-minting bug, end to end. Sequence measured on the real account:
// a task synced, then completed (tier flap / regeneration), then re-listed —
// and each round trip minted a brand-new TickTick task, each with its own
// Google Calendar event. One task existed seven times.
describe("the same to-do coming back", () => {
  const P = payload({ title: "FCC 测试 8/27-28 中国行程" });

  it("reopens the tombstone instead of creating a twin (same key)", () => {
    let map: SyncMap = { u1: rec("tt1", P) };
    map = applySyncOps(map, diffTickTickSync([], map), {}, 1000); // completed
    const ops = diffTickTickSync([{ unitKey: "u1", payload: P }], map); // …and back
    expect(ops).toEqual([
      { kind: "update", unitKey: "u1", ticktickId: "tt1", projectId: "proj", payload: P, reopen: true },
    ]);
  });

  // Regeneration mints NEW unit keys. The title is the only identity that
  // survives, so the tombstone match is by exact normalized title.
  it("reopens the tombstone under a fresh key instead of creating a twin", () => {
    let map: SyncMap = { oldKey: rec("tt1", P) };
    map = applySyncOps(map, diffTickTickSync([], map), {}, 1000);
    const ops = diffTickTickSync([{ unitKey: "regenKey", payload: P }], map);
    expect(ops).toEqual([
      {
        kind: "update",
        unitKey: "regenKey",
        ticktickId: "tt1",
        projectId: "proj",
        payload: P,
        reopen: true,
        adoptedFrom: "oldKey",
      },
    ]);
    // and the map entry MIGRATES — tracked once, under the new key only
    const next = applySyncOps(map, ops, { regenKey: { ticktickId: "tt1", projectId: "proj" } }, 2000);
    expect(next.oldKey).toBeUndefined();
    expect(next.regenKey!.ticktickId).toBe("tt1");
    expect(next.regenKey!.done).toBeUndefined();
  });

  // Key churn while the task is still OPEN (crash between create and map-save,
  // or a reworded key): adopt the live orphan, and do NOT complete it.
  it("adopts a live orphan by title instead of create+complete", () => {
    const map: SyncMap = { oldKey: rec("tt1", P) };
    const ops = diffTickTickSync([{ unitKey: "newKey", payload: P }], map);
    expect(ops).toEqual([
      {
        kind: "update",
        unitKey: "newKey",
        ticktickId: "tt1",
        projectId: "proj",
        payload: P,
        adoptedFrom: "oldKey",
      },
    ]);
  });

  it("normalizes whitespace and case, nothing more", () => {
    let map: SyncMap = { oldKey: rec("tt1", P) };
    map = applySyncOps(map, diffTickTickSync([], map), {}, 1000);
    const spaced = payload({ title: "  fcc 测试 8/27-28   中国行程 " });
    expect(diffTickTickSync([{ unitKey: "k2", payload: spaced }], map)[0]!.kind).toBe("update");
    const different = payload({ title: "FCC 测试 9/27-28 中国行程" });
    expect(diffTickTickSync([{ unitKey: "k3", payload: different }], map)[0]!.kind).toBe("create");
  });

  it("never completes a tombstone twice", () => {
    let map: SyncMap = { u1: rec("tt1", P) };
    map = applySyncOps(map, diffTickTickSync([], map), {}, 1000);
    expect(diffTickTickSync([], map)).toEqual([]);
  });

  // Records from before the title field existed cannot be matched — they
  // behave exactly as the old code did (create), never crash.
  it("tolerates title-less records from older maps", () => {
    const legacy: SyncMap = { old: { ticktickId: "tt1", projectId: "proj", hash: "x" } };
    const ops = diffTickTickSync([{ unitKey: "k", payload: P }], legacy);
    expect(ops.map((o) => o.kind).sort()).toEqual(["complete", "create"]);
  });

  it("caps the graveyard at the oldest end", () => {
    let map: SyncMap = {};
    for (let i = 0; i < 205; i++) {
      const key = `k${i}`;
      map[key] = { ...rec(`tt${i}`, payload({ title: `task ${i}` })), done: i + 1 };
    }
    const next = applySyncOps(map, [], {}, 9999);
    const tombs = Object.values(next).filter((r) => r.done);
    expect(tombs).toHaveLength(200);
    expect(next.k0).toBeUndefined(); // oldest dropped
    expect(next.k204).toBeDefined(); // newest kept
  });
});

// ORPHAN reconciliation: the sync recognises its own strays by looking at
// TickTick itself, because the map has lost its memory three separate ways and
// each time the strays either duplicated the list or squatted on it forever.
describe("orphan reconciliation", () => {
  const P = payload({ title: "制造协议签署版补齐" });
  const stray = (over: Record<string, unknown> = {}) => ({
    id: "tt9",
    status: 0,
    projectId: "proj",
    title: "制造协议签署版补齐",
    tags: ["secretary"],
    ...over,
  });

  it("adopts a live engine-minted stray whose title a desired row carries", () => {
    const ops = diffTickTickSync([{ unitKey: "k1", payload: P }], {}, [stray()]);
    expect(ops).toEqual([
      { kind: "update", unitKey: "k1", ticktickId: "tt9", projectId: "proj", payload: P },
    ]);
  });

  it("completes an engine-minted stray nothing desires, leaving a reopenable tombstone", () => {
    const ops = diffTickTickSync([], {}, [stray()]);
    expect(ops).toEqual([
      { kind: "complete", unitKey: "orphan_tt9", ticktickId: "tt9", projectId: "proj", title: "制造协议签署版补齐" },
    ]);
    const next = applySyncOps({}, ops, {}, 777);
    expect(next.orphan_tt9).toEqual({
      ticktickId: "tt9",
      projectId: "proj",
      hash: "",
      title: "制造协议签署版补齐",
      done: 777,
    });
    // …and the tombstone reopens if the same work is re-listed later
    const later = diffTickTickSync([{ unitKey: "k2", payload: P }], next);
    expect(later[0]).toMatchObject({ kind: "update", ticktickId: "tt9", reopen: true });
  });

  // THE line that keeps this safe: the owner's own tasks carry no engine tag
  // and must never be touched, adopted, or completed.
  it("never touches the owner's own untagged tasks", () => {
    const ops = diffTickTickSync([], {}, [stray({ tags: [] }), stray({ id: "tt10", tags: undefined })]);
    expect(ops).toEqual([]);
  });

  it("ignores tasks the map already tracks", () => {
    const map: SyncMap = { k1: rec("tt9", P) };
    const ops = diffTickTickSync([{ unitKey: "k1", payload: P }], map, [stray()]);
    expect(ops).toEqual([{ kind: "skip", unitKey: "k1" }]);
  });
});
