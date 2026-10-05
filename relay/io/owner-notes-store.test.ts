import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordOwnerNotes } from "./owner-notes-store.js";

describe("recordOwnerNotes", () => {
  it("keeps each (row, note) once, however often the readback sees it", () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "notes-")), "loop-state.json");
    const note = { unitKey: "u1", note: "Graham is working on this", dismissed: true };
    expect(recordOwnerNotes(statePath, [note])).toBe(1);
    expect(recordOwnerNotes(statePath, [note, { ...note, note: "古龙已经签署" }])).toBe(1);
    const lines = readFileSync(join(statePath, "..", "owner-notes.jsonl"), "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).note)).toEqual(["Graham is working on this", "古龙已经签署"]);
  });
});
