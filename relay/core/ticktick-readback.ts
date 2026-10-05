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
import { DISMISS_LINE } from "./ticktick-plan.js";

/** The shape we read back — TickTick's task, narrowed to what matters. */
export interface RemoteTask {
  id: string;
  /** 0 active, 2 completed. */
  status: number;
  items?: ReadonlyArray<{ id: string; status: number; title?: string }>;
  // For ORPHAN reconciliation (core/ticktick-sync.ts): a live remote task no map
  // record references. The map has lost its memory three separate ways now — a
  // regeneration wiping state, the readback deleting tombstones (a same-day bug
  // that ran for an afternoon), a crash between create and save — so the sync
  // must be able to recognise its own strays by looking at TickTick itself.
  projectId?: string;
  title?: string;
  tags?: readonly string[];
  /** The description, so 🚫 can see which links the row showed (ledger-list ownLinesShown). */
  desc?: string;
  /** The date shown on the task — the day he plans it once he has moved it. */
  dueDate?: string;
}

export interface ReadbackResult {
  /** Actions the owner ticked off individually. */
  doneActionIds: string[];
  /** Units whose whole task is completed or deleted — every live member is done. */
  doneUnitKeys: string[];
  /**
   * Units the owner DISMISSED by ticking DISMISS_LINE. Kept apart from
   * doneUnitKeys because the two mean opposite things about the row's quality:
   * done says nothing (完成 is also how a list gets cleared), dismissed says the
   * row should never have been minted. Only this one is a label.
   */
  dismissedUnitKeys: string[];
  /**
   * What the owner WROTE after 「🚫 这条不该出现」, ticked or not. On 2026-10-03
   * he went through every ticket and annotated that line — the reason a row
   * should or should not exist, in his words. That is the richest verdict this
   * engine ever gets, and an exact-title match made it invisible: a line with
   * anything appended no longer equalled DISMISS_LINE, so it was neither a
   * dismissal nor read at all.
   */
  ownerNotes: Array<{ unitKey: string; note: string; dismissed: boolean }>;
}

/** The text the owner added after DISMISS_LINE, or null if this is not that line. */
export function dismissNote(title: string | undefined): string | null {
  if (!title || !title.startsWith(DISMISS_LINE)) return null;
  return title.slice(DISMISS_LINE.length).replace(/^[\s:：,，\-—]+/, "").trim();
}

/**
 * What the owner finished in TickTick since the last poll.
 *
 * `remote` is the ACTIVE tasks of every project the caller could read. A
 * tracked task missing from it was completed or deleted, and both mean the same
 * thing here: stop resurfacing it — but ONLY when the caller confirms it read
 * everywhere (see coversEveryProject; a partial read concludes nothing).
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
  /**
   * Did `remote` cover EVERY project this map writes to?
   *
   * Absence is the only evidence this function has for "the owner finished
   * it", so absence must mean absence — not "we did not look there". It meant
   * the second thing for weeks: the readback listed only the Work project
   * while sunk rows are created in 待办池, so a row that sank was invisible on
   * the very next tick and read as completed. Measured 2026-09-27: 95 of 95
   * pool rows had been tombstoned here and marked `done` on their commitments,
   * and all 95 were still sitting OPEN in TickTick — the owner had never
   * touched one of them. 94 commitments were closed behind his back, 77 of
   * them his own, including 「设立三个持股平台…目前尚未启动」.
   *
   * So the caller says whether it managed to read everywhere. When it did not,
   * nothing is concluded from absence. Ticks and dismissals still land: those
   * are positive observations on tasks we DID see.
   */
  coversEveryProject = true,
): ReadbackResult {
  const active = new Map<string, RemoteTask>();
  const finished = new Map<string, RemoteTask>();
  for (const t of remote) (t.status === 0 ? active : finished).set(t.id, t);

  const doneActionIds: string[] = [];
  const doneUnitKeys: string[] = [];
  const dismissedUnitKeys: string[] = [];
  const ownerNotes: ReadbackResult["ownerNotes"] = [];
  // The task's 🚫 line: records his note if he wrote one, and says whether he ticked it.
  const readDismiss = (unitKey: string, task: RemoteTask | undefined): boolean => {
    const line = (task?.items ?? []).find((i) => dismissNote(i.title) !== null);
    const note = dismissNote(line?.title);
    if (note) ownerNotes.push({ unitKey, note, dismissed: line!.status === 1 });
    return line?.status === 1;
  };

  for (const [unitKey, rec] of Object.entries(map)) {
    // A tombstone is a task WE completed and chose to remember (the duplicate-
    // mint fix). It is never in the active list, so without this skip every
    // tombstone would read as "the owner finished it" on every tick — and worse,
    // the caller would drop it from the map, silently defeating the reopen match.
    if (rec.done) continue;
    const task = active.get(rec.ticktickId);
    if (!task) {
      if (!coversEveryProject) continue;
      doneUnitKeys.push(unitKey);
      // COMPLETING THE TASK IS NOT A VERDICT ON IT. 2026-10-03 the owner ticked
      // 🚫 on 15 rows, wrote why on 7 (「Graham is working on this」「古龙已经
      // 签署」…), then completed each whole task to clear it. Only active tasks
      // were read, so all 15 read as finished work: commitments marked done, no
      // not_a_thing label, every note lost. The caller fetches a vanished task
      // when it can (scan-loop readAllActive), and its 🚫 line is honoured here.
      if (readDismiss(unitKey, finished.get(rec.ticktickId))) dismissedUnitKeys.push(unitKey);
      continue;
    }
    const itemStatus = new Map((task.items ?? []).map((i) => [i.id, i.status]));
    // Matched by TITLE, not by a remembered id. Our own sync replaces the
    // checklist on every update, which MINTS NEW ITEM IDS (the same reason a
    // tracked id going missing is not treated as done, below), so an id
    // recorded at write time goes stale on the next push — and TickTick's
    // create/update response does not reliably echo the items at all, so there
    // was often no id to record. DISMISS_LINE is a constant we control, so the
    // title is the stable handle, and it works on tasks already carrying the
    // line without waiting for a re-sync.
    if (readDismiss(unitKey, task)) {
      dismissedUnitKeys.push(unitKey);
      continue;
    }
    for (const tracked of rec.items ?? []) {
      if (itemStatus.get(tracked.itemId) === 1) doneActionIds.push(tracked.actionId);
    }
  }
  return { doneActionIds, doneUnitKeys, dismissedUnitKeys, ownerNotes };
}
