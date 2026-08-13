// The pass that writes the owner's to-do list into TickTick.
//
// Reads loop-state, builds one TickTick task per TASK CLUSTER (not per
// message — relay/core/ticktick-plan.ts explains why), diffs against the id
// map, and writes only what changed. A cycle where nothing moved makes ZERO
// API calls.
//
// I/O is injected so this is unit-testable with a stub client and no network,
// the same shape as relay/proc/execute.ts.
//
// WHY CREATES ARE NOT BATCHED: batch_add_tasks returns `id2etag` keyed by the
// NEW TickTick ids with no echo of the input order, so there is no sound way to
// tell which id belongs to which to-do — the Microsoft To Do migration lost 803
// tasks learning that. create_task returns the whole task instead, including
// every checklist item's id, which is exactly what the tick-to-approve poll
// needs. It costs one call per NEW task, and the hash gate means new tasks are
// rare after the first cycle. Completions ARE batched: they only need ids we
// already hold, so there is nothing to pair.

import {
  applySyncOps,
  diffTickTickSync,
  summarize,
  type DesiredTask,
  type SyncMap,
  type SyncOp,
  type SyncResult,
} from "../core/ticktick-sync.js";
import { buildTaskPayload, shouldSync, type TaskUnit } from "../core/ticktick-plan.js";
import { diffTickTickReadback, type RemoteTask } from "../core/ticktick-readback.js";
import { groupByTask } from "../core/tasks.js";
import { unitKey, stableHash } from "../core/unit-key.js";
import { TICKTICK_BATCH_MAX } from "../core/mstodo.js";
import type { TickTickTaskPayload } from "../core/ticktick.js";
import type { TrackedApproval } from "../core/ticktick-approval.js";
import type { LoopState } from "../io/state.js";

/** The TickTick calls this pass needs. Narrow on purpose. */
/** Read side: what the owner has already ticked off in TickTick. */
export interface TickTickReader {
  /** The project's ACTIVE tasks, with their checklist items' status. */
  listActive(project?: string): Promise<RemoteTask[]>;
}

export interface TickTickWriter {
  /** Create one task; must return its id and its checklist items' ids. */
  createTask(payload: TickTickTaskPayload): Promise<{
    id: string;
    projectId: string;
    itemIds: string[];
  }>;
  /** Update one task in place; returns the (possibly new) checklist item ids. */
  updateTask(
    taskId: string,
    projectId: string,
    payload: TickTickTaskPayload,
  ): Promise<{ itemIds: string[] }>;
  /** Mark tasks complete, batched by the caller to TICKTICK_BATCH_MAX. */
  completeTasks(tasks: ReadonlyArray<{ id: string; projectId: string }>): Promise<void>;
}

export interface SyncReport {
  created: number;
  updated: number;
  completed: number;
  skipped: number;
  failed: number;
}

/**
 * Every task unit worth syncing this cycle.
 *
 * groupByTask returns one cluster per standalone action, so the loose cards are
 * re-keyed here: one row per distinct piece of work, merging only cards that
 * carry the same headline in the same conversation.
 */
export function taskUnitsFrom(state: LoopState): TaskUnit[] {
  const plans = state.plans ?? {};
  const overrides = state.planOverrides ?? {};
  const units: TaskUnit[] = [];
  // Hoisted OUT of the cluster loop: groupByTask returns one cluster PER
  // standalone action (its bucket-of-all comment was wrong), so a per-cluster
  // map could never merge two of them.
  const loose = new Map<string, TaskUnit>();

  const withTier = (key: string): TaskUnit["plan"] => {
    const plan = plans[key];
    const override = overrides[key];
    if (!plan) return override ? { tier: override, rank: 0, why: "", at: "" } : undefined;
    // A manual re-tier wins: the ranking pass must not undo a human's move.
    return override ? { ...plan, tier: override } : plan;
  };

  for (const cluster of groupByTask(state.actions, state.tasks)) {
    if (cluster.task_id) {
      units.push({
        unitKey: cluster.task_id,
        title: cluster.title ?? "(untitled task)",
        grouped: true,
        plan: withTier(cluster.task_id),
        members: cluster.actions,
      });
      continue;
    }
    for (const action of cluster.actions) {
      // TWO DIFFERENT KEYS, on purpose.
      //
      // planKey is the CONVERSATION (unit-key.ts): a card that gets superseded
      // is reissued with a fresh id, so a plan or a manual re-tier keyed to the
      // card itself would detach on every refresh.
      //
      // The TickTick row cannot use that key, because several ungrouped cards
      // from one contact then collide on it — and diffTickTickSync drops the
      // repeats. That is not theoretical: one sender's three cards became one
      // row and "File ticket for detailed UART FIFO report" plus two others
      // vanished from the list with no error anywhere.
      //
      // So the row is keyed by conversation AND headline: two subjects from one
      // contact are two rows, and a refresh that keeps the headline updates the
      // row in place. A REWORDED headline does mint a new row and complete the
      // old one, which is the honest reading — the row says something different
      // now.
      const planKey = unitKey(action);
      const title =
        action.headline ||
        (typeof action.params.title === "string" ? action.params.title : "") ||
        "(untitled)";
      const rowKey = `__ungrouped_${stableHash(`${planKey}::${title.trim()}`)}`;
      // Two cards that really do say the same thing MERGE into that row rather
      // than pushing a second unit under the same key — diffTickTickSync drops a
      // repeated key, and dropping is how the to-dos went missing in the first
      // place.
      const existing = loose.get(rowKey);
      if (existing) {
        existing.members = [...existing.members, action];
        continue;
      }
      loose.set(rowKey, {
        unitKey: rowKey,
        title,
        grouped: false,
        plan: withTier(planKey),
        members: [action],
      });
    }
  }
  units.push(...loose.values());
  return units;
}

export async function syncToTickTick(
  state: LoopState,
  map: SyncMap,
  writer: TickTickWriter,
  // The owner's zone, for due dates and the wall-clock labels on calendar
  // lines. Explicit rather than read here: core cannot reach io/settings, and a
  // defaulted offset is how a 15:00 call ends up labelled 22:00.
  zone: string,
): Promise<{ map: SyncMap; report: SyncReport }> {
  const desired: DesiredTask[] = [];
  // itemIds come back positionally, so remember which slots are executable.
  const executableByUnit = new Map<string, Array<{ sortOrder: number; actionId: string }>>();

  const nowMs = Date.now();
  for (const unit of taskUnitsFrom(state)) {
    if (!shouldSync(unit, nowMs)) continue;
    const built = buildTaskPayload(unit, zone);
    desired.push({ unitKey: unit.unitKey, payload: built.payload });
    executableByUnit.set(unit.unitKey, built.executable);
  }

  const ops = diffTickTickSync(desired, map);
  const results: Record<string, SyncResult> = {};
  let failed = 0;

  // Pair the returned checklist item ids back to the actions they approve.
  // Positional: TickTick preserves the order the items were sent in, which is
  // the same order buildTaskPayload assigned sortOrder in.
  const trackedFrom = (unitKey: string, itemIds: readonly string[]): TrackedApproval[] =>
    (executableByUnit.get(unitKey) ?? [])
      .filter((e) => e.sortOrder < itemIds.length)
      .map((e) => ({ itemId: itemIds[e.sortOrder]!, actionId: e.actionId }));

  for (const op of ops) {
    if (op.kind === "skip") continue;
    try {
      if (op.kind === "create") {
        const created = await writer.createTask(op.payload);
        results[op.unitKey] = {
          ticktickId: created.id,
          projectId: created.projectId,
          items: trackedFrom(op.unitKey, created.itemIds),
        };
      } else if (op.kind === "update") {
        const written = await writer.updateTask(op.ticktickId, op.projectId, op.payload);
        results[op.unitKey] = {
          ticktickId: op.ticktickId,
          projectId: op.projectId,
          items: trackedFrom(op.unitKey, written.itemIds),
        };
      }
    } catch (e) {
      // One bad task must not abandon the rest of the list. Leaving it out of
      // `results` is what makes the next cycle retry it.
      failed++;
      console.error(`[ticktick] ${op.kind} failed for ${op.unitKey}: ${(e as Error).message}`);
    }
  }

  const completes = ops.filter((o): o is Extract<SyncOp, { kind: "complete" }> => o.kind === "complete");
  for (let i = 0; i < completes.length; i += TICKTICK_BATCH_MAX) {
    const chunk = completes.slice(i, i + TICKTICK_BATCH_MAX);
    try {
      await writer.completeTasks(chunk.map((c) => ({ id: c.ticktickId, projectId: c.projectId })));
      for (const c of chunk) results[c.unitKey] = { ticktickId: c.ticktickId, projectId: c.projectId };
    } catch (e) {
      failed += chunk.length;
      console.error(`[ticktick] complete batch failed: ${(e as Error).message}`);
    }
  }

  // A complete that threw must stay in the map so it is retried; applySyncOps
  // drops every complete op unconditionally, so filter the failed ones out.
  const applied = ops.filter((o) => o.kind !== "complete" || results[o.unitKey]);
  // Counted from what actually LANDED, not from what was attempted — a report
  // that says "created 3" after three failures is worse than no report.
  const landed = (kind: SyncOp["kind"]) =>
    ops.filter((o) => o.kind === kind && results[o.unitKey]).length;
  return {
    map: applySyncOps(map, applied, results),
    report: {
      created: landed("create"),
      updated: landed("update"),
      completed: landed("complete"),
      skipped: summarize(ops).skip,
      failed,
    },
  };
}


/**
 * Pull completions back from TickTick: whatever the owner finished there is
 * marked `executed` here, so it stops being resurfaced.
 *
 * `executed` is the right status even though no executor ran: it is already what
 * a hand-completed action carries (an approved WeChat send waits at `approved`
 * until the owner marks it executed). There is no "done elsewhere" status, and
 * `rejected` would be a lie that also poisons the label corpus.
 *
 * Returns the ids to mark and the map with finished units dropped — a unit whose
 * task is gone must leave the map, or the next sync would try to complete a task
 * that no longer exists.
 */
export function readbackFromTickTick(
  state: LoopState,
  map: SyncMap,
  remote: readonly RemoteTask[],
): { doneActionIds: string[]; map: SyncMap; unitsClosed: number } {
  const { doneActionIds, doneUnitKeys } = diffTickTickReadback(map, remote);
  const done = new Set(doneActionIds);

  const gone = new Set(doneUnitKeys);
  for (const unit of taskUnitsFrom(state)) {
    if (!gone.has(unit.unitKey)) continue;
    for (const m of unit.members) {
      if (m.status === "suggested" || m.status === "approved") done.add(m.id);
    }
  }

  const next: SyncMap = {};
  for (const [k, v] of Object.entries(map)) if (!gone.has(k)) next[k] = v;
  return { doneActionIds: [...done], map: next, unitsClosed: gone.size };
}
