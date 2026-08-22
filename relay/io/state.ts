// Loop state v2: cursors (high-water marks), the Action Item pending queue,
// per-source errors, and draft outcomes for the validation gate. One JSON file.
// Plus a lockfile so a scheduled pass and an attended pass never write
// concurrently (prevents lost cursors / duplicate analysis).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { HighWaterMarks } from "../core/dedup.js";
import type { ActionItem } from "../core/action-item.js";
import type { TaskRegistry } from "../core/tasks.js";
import type { DraftOutcome } from "../core/metrics.js";
import { appendLabels, buildLabel, labelsPathFor } from "./labels.js";

export interface SourceError {
  message: string;
  at: string; // ISO timestamp
}

export interface LoopState {
  version: 2;
  marks: HighWaterMarks; // per-source cursors
  actions: ActionItem[]; // the queue: suggested/approved/executed/rejected
  outcomes: DraftOutcome[]; // validation-gate data
  sourceErrors: Record<string, SourceError>; // failed sources, cursor not advanced
  tasks: TaskRegistry; // Phase 2 (T1): {task_id: {title, created_at}}
  // Optimistic-concurrency counter. saveState bumps it and refuses to write
  // if the on-disk revision moved since this state was loaded — so a pass that
  // ran long enough for its lock to go stale (and get reclaimed) can't clobber
  // the reclaiming writer's update. Optional on input; loadState always fills it.
  revision?: number;
  // PERSON-FIRST TRIGGER (specs/person-first-consolidation.md §3.1). Two
  // per-person cursors, epoch ms, keyed by persona key:
  //   personTraffic  — last time a message from this person was SEEN
  //   personAssessed — last time the person pass ran for them
  // A person needs assessing when traffic > assessed. That is self-limiting
  // (once assessed they do not come back until they talk again), so it REPLACES
  // the module-level TTL the pass used to carry — which also forgot everything
  // on restart. Optional on input; loadState always fills them.
  personTraffic?: Record<string, number>;
  personAssessed?: Record<string, number>;
}

// Thrown when saveState detects the on-disk state advanced since the caller
// loaded it (a concurrent writer reclaimed a stale lock). The caller should
// reload and retry rather than overwrite — failing loud beats a lost update.
export class StateRevisionConflict extends Error {
  constructor(
    readonly expected: number,
    readonly found: number,
  ) {
    super(`state revision conflict: loaded ${expected} but disk is now ${found}`);
    this.name = "StateRevisionConflict";
  }
}

function empty(): LoopState {
  return {
    version: 2,
    marks: {},
    actions: [],
    outcomes: [],
    sourceErrors: {},
    tasks: {},
    revision: 0,
    personTraffic: {},
    personAssessed: {},
  };
}

// Tolerant load: missing fields (or a pre-v2 file — none ever held real data)
// upgrade silently to the v2 shape. `tasks` is the newest field; pre-T1 state
// files simply load with tasks={}, same pattern as marks/outcomes/sourceErrors.
export function loadState(path: string): LoopState {
  if (!existsSync(path)) return empty();
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LoopState>;
  return {
    version: 2,
    marks: parsed.marks ?? {},
    actions: parsed.actions ?? [],
    outcomes: parsed.outcomes ?? [],
    sourceErrors: parsed.sourceErrors ?? {},
    tasks: parsed.tasks ?? {},
    revision: parsed.revision ?? 0,
    personTraffic: parsed.personTraffic ?? {},
    personAssessed: parsed.personAssessed ?? {},
  };
}

// Read just the revision from the on-disk state. Returns null when the file is
// absent or unparseable — in which case saveState skips the conflict check
// rather than block a legitimate write on a missing/corrupt file.
function readRevision(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LoopState>;
    return parsed.revision ?? 0;
  } catch {
    return null;
  }
}

// Retention caps so loop-state.json doesn't grow without bound (every
// mutation rewrites the whole file). Outcomes feed only the gate's last-20
// window; terminal actions (executed/rejected) are history. Both caps keep a
// generous tail — `approved` items are NEVER terminal (WeChat sends wait there
// indefinitely), so they're never pruned. Live (suggested/approved) actions
// and all marks/tasks are always kept in full.
const MAX_OUTCOMES = 500;
const MAX_TERMINAL_ACTIONS = 500;
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["executed", "rejected"]);

// Which terminal actions capState would evict, in eviction order. Pure — the
// caller (saveState) uses it to write labels BEFORE the records disappear.
// Kept as a separate pure fn so capState stays side-effect free and testable.
export function actionsToPrune(state: LoopState): ActionItem[] {
  const terminalCount = state.actions.reduce(
    (n, a) => (TERMINAL_STATUSES.has(a.status) ? n + 1 : n),
    0,
  );
  if (terminalCount <= MAX_TERMINAL_ACTIONS) return [];
  let toDrop = terminalCount - MAX_TERMINAL_ACTIONS;
  const doomed: ActionItem[] = [];
  for (const a of state.actions) {
    if (toDrop > 0 && TERMINAL_STATUSES.has(a.status)) {
      doomed.push(a);
      toDrop--;
    }
  }
  return doomed;
}

// Returns a capped copy (input untouched) when over a limit; otherwise the
// same reference. Idempotent: re-capping an already-capped state is a no-op.
function capState(state: LoopState): LoopState {
  const outcomes =
    state.outcomes.length > MAX_OUTCOMES ? state.outcomes.slice(-MAX_OUTCOMES) : state.outcomes;

  let actions = state.actions;
  const terminalCount = state.actions.reduce(
    (n, a) => (TERMINAL_STATUSES.has(a.status) ? n + 1 : n),
    0,
  );
  if (terminalCount > MAX_TERMINAL_ACTIONS) {
    // Drop the OLDEST terminal actions (array order = creation order); keep
    // every live action and the most recent MAX_TERMINAL_ACTIONS terminal ones.
    let toDrop = terminalCount - MAX_TERMINAL_ACTIONS;
    actions = state.actions.filter((a) => {
      if (toDrop > 0 && TERMINAL_STATUSES.has(a.status)) {
        toDrop--;
        return false;
      }
      return true;
    });
  }

  if (outcomes === state.outcomes && actions === state.actions) return state;
  return { ...state, outcomes, actions };
}

// Atomic write (T5): write a sibling .tmp then rename over the target. rename is
// atomic on the same filesystem, so a concurrent unlocked reader (the cockpit
// polling) never observes a half-written file — it sees either the old bytes or
// the new bytes, never a truncated middle.
export function saveState(path: string, state: LoopState): void {
  const loaded = state.revision ?? 0;
  const onDisk = readRevision(path);
  if (onDisk !== null && onDisk !== loaded) {
    // Someone wrote since we loaded — refuse to clobber.
    throw new StateRevisionConflict(loaded, onDisk);
  }
  const nextRevision = loaded + 1;
  // P0 label rescue: a pruned terminal action is ground truth we can never get
  // back, so write its label FIRST. If the append fails we keep the records
  // (over-cap beats a lost label) — the only intentional behaviour change here.
  let capped = state;
  const doomed = actionsToPrune(state);
  if (doomed.length === 0) {
    capped = capState(state);
  } else {
    try {
      appendLabels(
        labelsPathFor(path),
        doomed.map((a) => buildLabel({ action: a, decision: "pruned" })),
      );
      capped = capState(state);
    } catch {
      // Label append failed → abandon the prune, keep every action this round.
      capped = { ...state, outcomes: capState({ ...state, actions: [] }).outcomes };
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...capped, revision: nextRevision }, null, 2), "utf8");
  renameSync(tmp, path);
  // Keep the caller's in-memory object in step so a follow-up save of the
  // SAME object (without an intervening reload) isn't seen as a conflict.
  state.revision = nextRevision;
}

// A held lock older than this is treated as abandoned (a crashed pass that never
// ran its finally). Generous: a real pass — even a heavy /relay scan — finishes
// well under this; the window only matters after a hard crash.
const STALE_LOCK_MS = 15 * 60 * 1000;

// True when the PID recorded in the lockfile is no longer a running process —
// i.e. the holder crashed or was killed without running its finally. The
// lockfile stores the holder's pid; signal 0 is a liveness probe (ESRCH = no
// such process). Lets a killed daemon's lock be reclaimed at once instead of
// blocking every writer for STALE_LOCK_MS. Conservative: any uncertainty
// (unreadable pid, EPERM, our own pid) → treat as alive, fall back to age.
function lockHolderIsDead(lock: string): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(lock, "utf8").trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false; // alive
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

// Single-writer lock (T5-hardened). acquireLock returns false if another LIVE
// pass holds it (caller no-ops). A stale lockfile (holder PID dead, or older
// than STALE_LOCK_MS) is reclaimed rather than blocking writes forever.
export function acquireLock(stateDir: string): boolean {
  mkdirSync(stateDir, { recursive: true });
  const lock = join(stateDir, ".lock");
  try {
    writeFileSync(lock, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    // Lock exists. Reclaim if the holder is dead (crash/kill residue) or the
    // lock is older than the stale window (a holder that vanished without a
    // readable pid, or one wedged far past any real pass).
    let ageMs = 0;
    try {
      ageMs = Date.now() - statSync(lock).mtimeMs;
    } catch {
      return false; // vanished between calls — let the caller retry next pass
    }
    if (ageMs <= STALE_LOCK_MS && !lockHolderIsDead(lock)) return false; // a live pass holds it
    try {
      rmSync(lock);
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      return false; // someone else reclaimed it first
    }
  }
}

export function releaseLock(stateDir: string): void {
  const lock = join(stateDir, ".lock");
  if (existsSync(lock)) rmSync(lock);
}

// acquireLock, but wait out a brief hold by the other writer instead of
// failing instantly. The daemon holds the lock only for short scan/commit
// windows (the slow LLM/vision step runs unlocked), so a few short retries
// reliably win it back — used by the cockpit so an approve/skip/flush that
// lands during a daemon commit doesn't bounce with "state is locked". Returns
// false only if still held after every retry.
export async function acquireLockWithRetry(
  stateDir: string,
  tries = 15,
  delayMs = 200,
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (acquireLock(stateDir)) return true;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}
