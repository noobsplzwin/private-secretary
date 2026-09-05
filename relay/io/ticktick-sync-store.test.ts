import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSyncMap, saveSyncMap, syncPathFor } from "./ticktick-sync-store.js";

let dir: string;
let statePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sync-store-"));
  statePath = join(dir, "loop-state.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadSyncMap", () => {
  // 2026-09-06: the loader rebuilt each record field by field and copied
  // neither `done` nor `title`. Tombstones were written on every sync and
  // dropped on every read, so the same 97 tasks were re-completed forever and
  // — far worse — the reopen-instead-of-create path could never fire. That
  // path is the whole reason tombstones exist: without it a re-listed to-do
  // mints a NEW task, which is how one task came to exist seven times.
  it("carries the tombstone back", () => {
    writeFileSync(
      syncPathFor(statePath),
      JSON.stringify({
        row1: { ticktickId: "tt1", projectId: "p", hash: "h", done: 1788600000000 },
      }),
    );
    expect(loadSyncMap(statePath).row1!.done).toBe(1788600000000);
  });

  it("carries the title back — reopen-by-content needs it", () => {
    writeFileSync(
      syncPathFor(statePath),
      JSON.stringify({ row1: { ticktickId: "tt1", projectId: "p", hash: "h", title: "签署高通 NDA" } }),
    );
    expect(loadSyncMap(statePath).row1!.title).toBe("签署高通 NDA");
  });

  it("survives a save/load round trip unchanged", () => {
    const map = {
      row1: { ticktickId: "tt1", projectId: "p", hash: "h", title: "t", done: 123 },
      row2: { ticktickId: "tt2", projectId: "p", hash: "h2", items: [{ itemId: "i", actionId: "a" }] },
    };
    saveSyncMap(statePath, map);
    expect(loadSyncMap(statePath)).toEqual(map);
  });

  it("still drops a record with no id or hash", () => {
    writeFileSync(
      syncPathFor(statePath),
      JSON.stringify({ bad: { projectId: "p" }, good: { ticktickId: "t", hash: "h" } }),
    );
    expect(Object.keys(loadSyncMap(statePath))).toEqual(["good"]);
  });
});
