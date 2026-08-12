// What to send to TickTick this cycle. Pure core: no I/O, no MCP.
//
// The engine regenerates its to-do list every refresh (README, "Known gaps": a
// to-do has no durable identity across ticks). Pushing that straight to
// TickTick would create a fresh copy of the same to-do every 30 minutes, so the
// sync is create-or-UPDATE, keyed by unitKey — which core/unit-key.ts already
// keeps stable across a supersede — through a persisted id map.
//
// The hash gate is not an optimisation, it is the difference between a working
// integration and a rate-limited account: without it every cycle rewrites every
// task even when nothing changed. A steady state emits zero calls.
//
// Anything in the map that is no longer open gets COMPLETED rather than
// deleted. Deleting would destroy a record the owner may have annotated, and
// this engine does not delete the owner's data.

import { stableHash } from "./unit-key.js";
import type { TickTickTaskPayload } from "./ticktick.js";
import type { TrackedApproval } from "./ticktick-approval.js";

export interface SyncRecord {
  ticktickId: string;
  projectId: string;
  hash: string;
  // Which checklist item approves which action. Without this the poll in
  // specs/ticktick-migration.md §1 knows an item was ticked but not what it
  // was supposed to execute, so a tick would silently do nothing.
  items?: TrackedApproval[];
}

export type SyncMap = Record<string, SyncRecord>;

export interface DesiredTask {
  unitKey: string;
  payload: TickTickTaskPayload;
}

export type SyncOp =
  | { kind: "create"; unitKey: string; payload: TickTickTaskPayload }
  | {
      kind: "update";
      unitKey: string;
      ticktickId: string;
      projectId: string;
      payload: TickTickTaskPayload;
    }
  | { kind: "complete"; unitKey: string; ticktickId: string; projectId: string }
  | { kind: "skip"; unitKey: string };

// Content hash of a payload. Keys are sorted so a reordered-but-identical
// payload does not read as a change — JSON.stringify is key-order sensitive and
// the payload is assembled from several optional branches.
export function hashPayload(payload: TickTickTaskPayload): string {
  return stableHash(canonical(payload));
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/**
 * The operations that bring TickTick in line with the engine's open to-dos.
 *
 * `desired` is every OPEN to-do this cycle. A unitKey present in `map` but
 * absent from `desired` is a to-do that closed, so it is completed in TickTick.
 *
 * Ops are returned for every unitKey, `skip` included, so a caller can report
 * "40 unchanged, 2 updated" instead of silently doing nothing.
 */
export function diffTickTickSync(desired: readonly DesiredTask[], map: SyncMap): SyncOp[] {
  const ops: SyncOp[] = [];
  const seen = new Set<string>();

  for (const { unitKey, payload } of desired) {
    // A duplicate unitKey in one cycle is an upstream bug; syncing it twice
    // would create two TickTick tasks for one to-do, so drop the repeat.
    if (seen.has(unitKey)) continue;
    seen.add(unitKey);

    const record = map[unitKey];
    const hash = hashPayload(payload);
    if (!record) {
      ops.push({ kind: "create", unitKey, payload });
    } else if (record.hash !== hash) {
      ops.push({
        kind: "update",
        unitKey,
        ticktickId: record.ticktickId,
        projectId: record.projectId,
        payload,
      });
    } else {
      ops.push({ kind: "skip", unitKey });
    }
  }

  for (const [unitKey, record] of Object.entries(map)) {
    if (seen.has(unitKey)) continue;
    ops.push({
      kind: "complete",
      unitKey,
      ticktickId: record.ticktickId,
      projectId: record.projectId,
    });
  }

  return ops;
}

/** What TickTick returned for a task this cycle wrote. */
export interface SyncResult {
  ticktickId: string;
  projectId: string;
  items?: TrackedApproval[];
}

/** The map after `ops` have been applied. Completed units leave the map. */
export function applySyncOps(
  map: SyncMap,
  ops: readonly SyncOp[],
  results: Readonly<Record<string, SyncResult>>,
): SyncMap {
  const next: SyncMap = { ...map };
  for (const op of ops) {
    if (op.kind === "create") {
      const created = results[op.unitKey];
      // No id back means the create failed. Leaving the unitKey OUT of the map
      // makes the next cycle retry it; recording it would lose the to-do.
      if (!created) continue;
      next[op.unitKey] = { ...created, hash: hashPayload(op.payload) };
    } else if (op.kind === "update") {
      const written = results[op.unitKey];
      // An update rewrites the checklist, so TickTick may hand back NEW item
      // ids. Keeping the stale ones would leave a ticked item pointing at
      // nothing. No result → the update failed; keep the old hash so the next
      // cycle retries rather than believing it succeeded.
      if (!written) continue;
      next[op.unitKey] = { ...written, hash: hashPayload(op.payload) };
    } else if (op.kind === "complete") {
      delete next[op.unitKey];
    }
  }
  return next;
}

export function summarize(ops: readonly SyncOp[]): Record<SyncOp["kind"], number> {
  const counts = { create: 0, update: 0, complete: 0, skip: 0 };
  for (const op of ops) counts[op.kind]++;
  return counts;
}
