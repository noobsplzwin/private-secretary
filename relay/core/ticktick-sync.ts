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
  // The task's title, so a later cycle can recognise "this to-do again" by
  // CONTENT when the key has moved on. Absent on records written before this
  // field existed — those simply cannot be matched, same behaviour as before.
  title?: string;
  // Tombstone: set (epoch ms) when the row was completed in TickTick. The map
  // used to DELETE completed entries, which is the bug that filled the owner's
  // Google Calendar with copies: complete → forget → the same to-do re-listed
  // (a tier flap, a regeneration) → create → a brand-new TickTick task, every
  // time. Measured on the real account: one task existed SEVEN times. The
  // tombstone lets the diff REOPEN the original instead.
  done?: number;
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
      /** The task is completed in TickTick — send status:0 with the update to bring it back. */
      reopen?: boolean;
      /** Map key this row was recognised under (adopt/reopen by title). applySyncOps migrates the entry. */
      adoptedFrom?: string;
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
  const desiredKeys = new Set(desired.map((d) => d.unitKey));

  // Content indexes, for rows whose KEY moved on. Exact normalized title only —
  // fuzzy matching would silently glue different work together, the same reason
  // shadow-list keeps its matcher deliberately dumb.
  //   live: a task that is open in TickTick under a key nothing desires any
  //         more (crash between create and map-save, or a key rewording) —
  //         adopt it instead of minting a twin.
  //   tomb: a task completed earlier that the list wants back (tier flap,
  //         regeneration) — REOPEN it instead of minting a twin.
  const liveByTitle = new Map<string, string>();
  const tombByTitle = new Map<string, string>();
  for (const [key, rec] of Object.entries(map)) {
    if (!rec.title) continue;
    const t = normTitle(rec.title);
    if (rec.done) {
      // Newest tombstone wins: reopening a years-old copy would resurrect its
      // stale checklist alongside the fresh payload's.
      const prev = tombByTitle.get(t);
      if (!prev || (map[prev]!.done ?? 0) < rec.done) tombByTitle.set(t, key);
    } else if (!desiredKeys.has(key)) {
      liveByTitle.set(t, key);
    }
  }

  for (const { unitKey, payload } of desired) {
    // A duplicate unitKey in one cycle is an upstream bug; syncing it twice
    // would create two TickTick tasks for one to-do, so drop the repeat.
    if (seen.has(unitKey)) continue;
    seen.add(unitKey);

    const record = map[unitKey];
    const hash = hashPayload(payload);
    if (record && !record.done) {
      if (record.hash !== hash) {
        ops.push({ kind: "update", unitKey, ticktickId: record.ticktickId, projectId: record.projectId, payload });
      } else {
        ops.push({ kind: "skip", unitKey });
      }
      continue;
    }
    if (record?.done) {
      // The same key came back after its own completion — reopen in place.
      ops.push({ kind: "update", unitKey, ticktickId: record.ticktickId, projectId: record.projectId, payload, reopen: true });
      continue;
    }

    const t = normTitle(payload.title);
    const liveKey = liveByTitle.get(t);
    if (liveKey) {
      const rec = map[liveKey]!;
      liveByTitle.delete(t); // one orphan adopts at most once per cycle
      ops.push({ kind: "update", unitKey, ticktickId: rec.ticktickId, projectId: rec.projectId, payload, adoptedFrom: liveKey });
      continue;
    }
    const tombKey = tombByTitle.get(t);
    if (tombKey) {
      const rec = map[tombKey]!;
      tombByTitle.delete(t);
      ops.push({ kind: "update", unitKey, ticktickId: rec.ticktickId, projectId: rec.projectId, payload, reopen: true, adoptedFrom: tombKey });
      continue;
    }
    ops.push({ kind: "create", unitKey, payload });
  }

  for (const [unitKey, record] of Object.entries(map)) {
    if (seen.has(unitKey)) continue;
    if (record.done) continue; // already completed — never complete a tombstone twice
    // Adopted this cycle under a new key → the entry migrates, nothing to complete.
    if (ops.some((o) => o.kind === "update" && o.adoptedFrom === unitKey)) continue;
    ops.push({
      kind: "complete",
      unitKey,
      ticktickId: record.ticktickId,
      projectId: record.projectId,
    });
  }

  return ops;
}

function normTitle(t: string): string {
  return t.trim().replace(/\s+/g, " ").toLowerCase();
}

/** What TickTick returned for a task this cycle wrote. */
export interface SyncResult {
  ticktickId: string;
  projectId: string;
  items?: TrackedApproval[];
}

/** The map after `ops` have been applied. Completed units leave the map. */
// How many completed rows the map remembers. Enough to cover weeks of flapping
// and regeneration; bounded so the map file cannot grow forever.
const MAX_TOMBSTONES = 200;

export function applySyncOps(
  map: SyncMap,
  ops: readonly SyncOp[],
  results: Readonly<Record<string, SyncResult>>,
  nowMs: number = Date.now(),
): SyncMap {
  const next: SyncMap = { ...map };
  for (const op of ops) {
    if (op.kind === "create") {
      const created = results[op.unitKey];
      // No id back means the create failed. Leaving the unitKey OUT of the map
      // makes the next cycle retry it; recording it would lose the to-do.
      if (!created) continue;
      next[op.unitKey] = { ...created, hash: hashPayload(op.payload), title: op.payload.title };
    } else if (op.kind === "update") {
      const written = results[op.unitKey];
      // An update rewrites the checklist, so TickTick may hand back NEW item
      // ids. Keeping the stale ones would leave a ticked item pointing at
      // nothing. No result → the update failed; keep the old hash so the next
      // cycle retries rather than believing it succeeded.
      if (!written) continue;
      // Adopt/reopen migrates the entry: the old key's record must go, or the
      // same TickTick task ends up tracked twice and the stale twin's absence
      // from `desired` completes the task the fresh key just claimed.
      if (op.adoptedFrom) delete next[op.adoptedFrom];
      next[op.unitKey] = { ...written, hash: hashPayload(op.payload), title: op.payload.title };
    } else if (op.kind === "complete") {
      // Remember, don't forget: deleting here is what minted a fresh TickTick
      // task (and a fresh Google Calendar event) every time a completed row
      // came back. The tombstone is what reopen matches against.
      const rec = next[op.unitKey];
      if (rec) next[op.unitKey] = { ...rec, done: nowMs };
    }
  }

  // Cap the graveyard: drop the OLDEST tombstones over the limit.
  const tombs = Object.entries(next).filter(([, r]) => r.done);
  if (tombs.length > MAX_TOMBSTONES) {
    tombs
      .sort(([, a], [, b]) => (a.done ?? 0) - (b.done ?? 0))
      .slice(0, tombs.length - MAX_TOMBSTONES)
      .forEach(([k]) => delete next[k]);
  }
  return next;
}

export function summarize(ops: readonly SyncOp[]): Record<SyncOp["kind"], number> {
  const counts = { create: 0, update: 0, complete: 0, skip: 0 };
  for (const op of ops) counts[op.kind]++;
  return counts;
}
