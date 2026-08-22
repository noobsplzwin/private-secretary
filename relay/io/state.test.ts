import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadState,
  saveState,
  acquireLock,
  releaseLock,
  StateRevisionConflict,
  type LoopState,
} from "./state.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "relay-state-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("loop state v2", () => {
  it("returns empty v2 state when the file does not exist", () => {
    const s = loadState(join(tempDir(), "loop-state.json"));
    expect(s).toEqual({
      version: 2,
      marks: {},
      actions: [],
      outcomes: [],
      sourceErrors: {},
      tasks: {},
      revision: 0,
      personTraffic: {},
      personAssessed: {},
    });
  });

  it("round-trips state through disk", () => {
    const path = join(tempDir(), "loop-state.json");
    const state: LoopState = {
      version: 2,
      marks: { "slack:C1": { lastTimestampMs: 1000, seenIds: ["m1"] } },
      actions: [
        {
          id: "a1",
          source_message_id: "m1",
          action_type: "relay",
          target: { personaKey: "wang-acme", platform: "gmail" },
          reason: "needs sign-off",
          confidence: 0.8,
          params: {},
          draft: "hi",
          status: "suggested",
          created_at: "2026-06-10T00:00:00Z",
        },
      ],
      outcomes: [
        {
          relayId: "a1",
          contactKey: "wang-acme",
          direction: "en->zh",
          decision: "approve-clean",
          wrongRecipient: false,
        },
      ],
      sourceErrors: {
        "gmail:inbox": { message: "timeout", at: "2026-06-10T00:00:00Z" },
      },
      tasks: {
        "task-chicago": { title: "Chicago trip", created_at: "2026-06-10T00:00:00Z" },
      },
      // The person-first cursors must survive a restart — that is the whole
      // reason they live in state instead of the module-level TTL they replaced.
      personTraffic: { "wang-acme": 1_700_000_000_000 },
      personAssessed: { "wang-acme": 1_699_000_000_000 },
    };
    saveState(path, state);
    expect(loadState(path)).toEqual(state);
  });

  it("caps outcomes + terminal actions on save, never pruning live or approved", () => {
    const path = join(tempDir(), "loop-state.json");
    const action = (i: number, status: "executed" | "suggested" | "approved") => ({
      id: `a${i}`,
      source_message_id: `m${i}`,
      action_type: "task" as const,
      target: { personaKey: "k", platform: "slack" as const },
      reason: "r",
      confidence: 0.9,
      params: {},
      status,
      created_at: "2026-06-10T00:00:00Z",
    });
    const outcome = (i: number) => ({
      relayId: `o${i}`,
      contactKey: "k",
      direction: "en->zh" as const,
      decision: "approve-clean" as const,
      wrongRecipient: false,
    });
    const state: LoopState = {
      version: 2,
      marks: {},
      actions: [
        ...Array.from({ length: 600 }, (_, i) => action(i, "executed")),
        action(9001, "suggested"),
        action(9002, "approved"),
      ],
      outcomes: Array.from({ length: 600 }, (_, i) => outcome(i)),
      sourceErrors: {},
      tasks: {},
    };
    saveState(path, state);
    const loaded = loadState(path);

    // outcomes: capped to the most recent 500 (oldest 100 dropped)
    expect(loaded.outcomes).toHaveLength(500);
    expect(loaded.outcomes[0]!.relayId).toBe("o100");

    // executed: capped to most recent 500 (oldest 100 dropped)
    const executed = loaded.actions.filter((a) => a.status === "executed");
    expect(executed).toHaveLength(500);
    expect(executed[0]!.id).toBe("a100");

    // live (suggested) + approved (WeChat-manual-send) are NEVER pruned
    expect(loaded.actions.some((a) => a.id === "a9001")).toBe(true);
    expect(loaded.actions.some((a) => a.id === "a9002")).toBe(true);
  });

  it("silently upgrades a pre-v2 file (missing fields)", () => {
    const path = join(tempDir(), "loop-state.json");
    writeFileSync(
      path,
      JSON.stringify({ marks: { s: { lastTimestampMs: 5, seenIds: [] } } }),
      "utf8",
    );
    const s = loadState(path);
    expect(s.version).toBe(2);
    expect(s.marks.s?.lastTimestampMs).toBe(5);
    expect(s.actions).toEqual([]);
    expect(s.sourceErrors).toEqual({});
  });
});

describe("optimistic revision check", () => {
  it("rejects a stale overwrite after another writer advanced the revision", () => {
    const path = join(tempDir(), "loop-state.json");
    const a = loadState(path); // revision 0 (file absent)
    saveState(path, a); // disk -> 1

    // A second writer (e.g. one that reclaimed a stale lock) loads + saves.
    const b = loadState(path); // revision 1
    saveState(path, b); // disk -> 2

    // `a` is now stale (still revision 1). It must refuse to clobber rev 2.
    expect(() => saveState(path, a)).toThrow(StateRevisionConflict);
  });

  it("allows repeated saves of the same in-memory object (no false conflict)", () => {
    const path = join(tempDir(), "loop-state.json");
    const s = loadState(path);
    expect(() => {
      saveState(path, s);
      saveState(path, s);
      saveState(path, s);
    }).not.toThrow();
    expect(loadState(path).revision).toBe(3);
  });
});

describe("single-writer lock", () => {
  it("grants the lock once and refuses a second holder", () => {
    const dir = tempDir();
    expect(acquireLock(dir)).toBe(true);
    expect(acquireLock(dir)).toBe(false);
    releaseLock(dir);
    expect(acquireLock(dir)).toBe(true);
    releaseLock(dir);
  });

  it("reclaims a fresh lock whose holder PID is dead (crashed/killed daemon)", () => {
    const dir = tempDir();
    // A crashed holder leaves a recent lockfile naming a pid that isn't
    // running. Without PID-liveness reclaim this would block for 15 min.
    writeFileSync(join(dir, ".lock"), "2000000000"); // not a live process
    expect(acquireLock(dir)).toBe(true);
    releaseLock(dir);
  });

  it("does NOT reclaim a fresh lock whose holder PID is alive", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".lock"), "1"); // pid 1 (init/launchd) is always alive
    expect(acquireLock(dir)).toBe(false);
    rmSync(join(dir, ".lock"));
  });
});
