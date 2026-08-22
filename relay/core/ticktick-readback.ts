// TickTick → engine: learn that work is DONE. Pure core, no I/O.
//
// THE GAP THIS CLOSES: a card left `suggested` only when a human clicked
// approve or skip in the cockpit — and the cockpit is being retired. Every one
// of the 73 open cards was `suggested`; the 211 executed / 190 rejected were all
// historical cockpit clicks. So work finished in the real world never closed:
// the owner's OSYX partner-page task was done and shipped, and its cards stayed
// open forever. It only left the list because the ranking pass demoted it, which
// is luck, not closure — a re-rank to A/B would have brought it straight back.
//
// The owner works in TickTick now, so completion comes from TickTick.
//
// TICKING NEVER EXECUTES. A ticked "🎫 创建：jira · …" line is recorded as DONE,
// not run: the line reads as an instruction, so ticking it far more likely means
// "I already created it" than "create it for me", and acting on that guess would
// file a duplicate ticket. Tick-to-execute is a separate decision (see
// specs/ticktick-migration.md §1), not something to slip in behind a checkbox.

import type { SyncMap } from "./ticktick-sync.js";

/** The shape we read back — TickTick's task, narrowed to what matters. */
export interface RemoteTask {
  id: string;
  /** 0 active, 2 completed. */
  status: number;
  items?: ReadonlyArray<{ id: string; status: number }>;
  // For ORPHAN reconciliation (core/ticktick-sync.ts): a live remote task no map
  // record references. The map has lost its memory three separate ways now — a
  // regeneration wiping state, the readback deleting tombstones (a same-day bug
  // that ran for an afternoon), a crash between create and save — so the sync
  // must be able to recognise its own strays by looking at TickTick itself.
  projectId?: string;
  title?: string;
  tags?: readonly string[];
}

export interface ReadbackResult {
  /** Actions the owner ticked off individually. */
  doneActionIds: string[];
  /** Units whose whole task is completed or deleted — every live member is done. */
  doneUnitKeys: string[];
}

/**
 * What the owner finished in TickTick since the last poll.
 *
 * `remote` is the project's ACTIVE tasks. A tracked task missing from it was
 * completed or deleted, and both mean the same thing here: stop resurfacing it.
 *
 * Status is the only signal read. completedTime is NOT: a task in the live
 * project came back carrying completedTime "2026-08-13T17:02:29+0000" with
 * status 0, so the timestamp survives an un-complete and would close a task the
 * owner deliberately reopened.
 *
 * A tracked item id ABSENT from its task is NOT treated as done. Our own sync
 * replaces the checklist on every update, which mints new item ids, so absence
 * is the normal state after a re-sync — only an explicit status 1 counts.
 */
export function diffTickTickReadback(
  map: SyncMap,
  remote: readonly RemoteTask[],
): ReadbackResult {
  const active = new Map<string, RemoteTask>();
  for (const t of remote) if (t.status === 0) active.set(t.id, t);

  const doneActionIds: string[] = [];
  const doneUnitKeys: string[] = [];

  for (const [unitKey, rec] of Object.entries(map)) {
    // A tombstone is a task WE completed and chose to remember (the duplicate-
    // mint fix). It is never in the active list, so without this skip every
    // tombstone would read as "the owner finished it" on every tick — and worse,
    // the caller would drop it from the map, silently defeating the reopen match.
    if (rec.done) continue;
    const task = active.get(rec.ticktickId);
    if (!task) {
      doneUnitKeys.push(unitKey);
      continue;
    }
    const itemStatus = new Map((task.items ?? []).map((i) => [i.id, i.status]));
    for (const tracked of rec.items ?? []) {
      if (itemStatus.get(tracked.itemId) === 1) doneActionIds.push(tracked.actionId);
    }
  }
  return { doneActionIds, doneUnitKeys };
}
