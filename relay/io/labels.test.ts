import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendLabel,
  appendLabels,
  buildLabel,
  labelsPathFor,
  readLabels,
  EXISTENCE_VERDICTS,
  NON_PRECISION_VERDICTS,
} from "./labels.js";
import { actionsToPrune, loadState, saveState } from "./state.js";
import type { ActionItem } from "../core/action-item.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "labels-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function action(id: string, over: Partial<ActionItem> = {}): ActionItem {
  return {
    id,
    source_message_id: `wechat:${id}`,
    action_type: "task",
    target: {},
    reason: "r",
    confidence: 0.5,
    params: {},
    status: "executed",
    created_at: "2026-07-01T00:00:00Z",
    ...over,
  };
}

describe("label ledger", () => {
  // MANDATORY REGRESSION — labels-append-only. The ledger is the only ground
  // truth that can prove accuracy improved; no code path may rewrite it.
  it("labels-append-only: appending never rewrites or drops existing lines", () => {
    const p = join(dir, "labels.jsonl");
    appendLabel(p, buildLabel({ action: action("a"), decision: "executed" }));
    const afterFirst = readFileSync(p, "utf8");
    appendLabel(p, buildLabel({ action: action("b"), decision: "rejected" }));
    const afterSecond = readFileSync(p, "utf8");

    // The first write's bytes are still a prefix of the file — nothing rewritten.
    expect(afterSecond.startsWith(afterFirst)).toBe(true);
    const recs = readLabels(afterSecond);
    expect(recs.map((r) => r.action_id)).toEqual(["a", "b"]);
    // Every line is a complete JSON object.
    expect(afterSecond.endsWith("\n")).toBe(true);
  });

  it("carries a self-contained snapshot so a label outlives the live state", () => {
    const a = action("x", { headline: "ship the thing", action_type: "calendar" });
    const rec = buildLabel({ action: a, decision: "executed", decided_at: "2026-07-28T10:00:00Z" });
    expect(rec.source_snapshot.headline).toBe("ship the thing");
    expect(rec.action_type).toBe("calendar");
    expect(rec.decided_at).toBe("2026-07-28T10:00:00Z");
  });

  it("backfilled history has null existence + null decided_at", () => {
    const rec = buildLabel({ action: action("h"), decision: "pruned" });
    expect(rec.existence).toBeNull();
    expect(rec.decided_at).toBeNull();
  });

  it("omits optional fields when empty rather than writing empty arrays", () => {
    const rec = buildLabel({ action: action("o"), decision: "rejected", field_errors: [], edit_diff: [] });
    expect(rec.field_errors).toBeUndefined();
    expect(rec.edit_diff).toBeUndefined();
  });

  it("deferred is a verdict but is excluded from the precision denominator", () => {
    expect(EXISTENCE_VERDICTS.has("deferred")).toBe(true);
    expect(NON_PRECISION_VERDICTS.has("deferred")).toBe(true);
    // A rejection that IS a real defect must stay in the denominator.
    expect(NON_PRECISION_VERDICTS.has("not_a_thing")).toBe(false);
    expect(NON_PRECISION_VERDICTS.has("not_mine")).toBe(false);
  });

  it("readLabels tolerates a truncated final line", () => {
    const p = join(dir, "labels.jsonl");
    appendLabel(p, buildLabel({ action: action("ok"), decision: "executed" }));
    writeFileSync(p, readFileSync(p, "utf8") + '{"label_id":"partial', "utf8");
    const recs = readLabels(readFileSync(p, "utf8"));
    expect(recs).toHaveLength(1);
    expect(recs[0]!.action_id).toBe("ok");
  });

  it("appendLabels with an empty batch is a no-op (no file created)", () => {
    const p = join(dir, "labels.jsonl");
    appendLabels(p, []);
    expect(() => readFileSync(p, "utf8")).toThrow();
  });

  it("labelsPathFor puts the ledger beside the state file", () => {
    expect(labelsPathFor("/tmp/x/loop-state.json")).toBe("/tmp/x/labels.jsonl");
  });
});

describe("prune-exports-first (MANDATORY REGRESSION)", () => {
  // A pruned terminal action is ground truth we can never recover. saveState
  // must write its label BEFORE evicting it, and must NOT prune if that fails.
  // loadState on a non-existent path yields a fresh empty v2 state.
  function stateWithTerminals(n: number) {
    const s = loadState(join(dir, "does-not-exist.json"));
    for (let i = 0; i < n; i++) s.actions.push(action(`t${i}`, { status: i % 2 ? "executed" : "rejected" }));
    return s;
  }

  it("actionsToPrune returns nothing under the cap", () => {
    expect(actionsToPrune(stateWithTerminals(500))).toEqual([]);
  });

  it("actionsToPrune names the OLDEST over-cap terminal actions", () => {
    const doomed = actionsToPrune(stateWithTerminals(503));
    expect(doomed.map((a) => a.id)).toEqual(["t0", "t1", "t2"]);
  });

  it("saveState writes a label for every pruned action before evicting it", () => {
    const p = join(dir, "loop-state.json");
    const s = stateWithTerminals(503);
    saveState(p, s);

    const recs = readLabels(readFileSync(labelsPathFor(p), "utf8"));
    expect(recs.map((r) => r.action_id)).toEqual(["t0", "t1", "t2"]);
    expect(recs.every((r) => r.decision === "pruned")).toBe(true);
    // …and the snapshot is intact, so the label is still readable on its own.
    expect(recs[0]!.source_snapshot.id).toBe("t0");

    // The state really was pruned down to the cap.
    const onDisk = JSON.parse(readFileSync(p, "utf8"));
    expect(onDisk.actions).toHaveLength(500);
    expect(onDisk.actions.some((a: ActionItem) => a.id === "t0")).toBe(false);
  });

  it("keeps the over-cap actions when the label append fails (label > cap)", () => {
    const p = join(dir, "loop-state.json");
    // Make labels.jsonl un-writable by putting a DIRECTORY at its path.
    mkdirSync(labelsPathFor(p), { recursive: true });

    const s = stateWithTerminals(503);
    saveState(p, s);

    const onDisk = JSON.parse(readFileSync(p, "utf8"));
    // Nothing pruned — we chose over-cap over a lost label.
    expect(onDisk.actions).toHaveLength(503);
    expect(onDisk.actions.some((a: ActionItem) => a.id === "t0")).toBe(true);
  });

  it("live (suggested/approved) actions are never pruned", () => {
    const s = stateWithTerminals(503);
    s.actions.push(action("live", { status: "suggested" }), action("await", { status: "approved" }));
    const doomed = actionsToPrune(s).map((a) => a.id);
    expect(doomed).not.toContain("live");
    expect(doomed).not.toContain("await");
  });
});
