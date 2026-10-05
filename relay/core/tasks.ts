// Phase 2 (T1) — the task layer. PRODUCT UNIT = TASK: one conversation spawns a
// task whose sub-actions span platforms/people. Tasks are LLM judgment assigned
// in the skill at round-commit (mint a new task_id or attach to an existing one);
// this module is the DETERMINISTIC half — it stores nothing, it only GROUPS and
// ORDERS the queue and DERIVES progress. No clustering logic here (that's the
// skill's call), matching the engine split where core stays pure.
//
//   actions[] + registry ──groupByTask──▶ ordered TaskCluster[]
//     each cluster: members ordered ready→needs-info→approved→done,
//     groups ordered oldest-first by earliest member (design 5A),
//     progress + status DERIVED from member action statuses.
//
// NOTE on "progress": this is ACTION progress (how many of a task's actions are
// executed), NOT real-world task completion — a task can have all its surfaced
// actions done and still be "open" in life. The cockpit labels it accordingly.

import { missingInfo, type ActionItem } from "./action-item.js";

// One contact's task registry entry. Kept deliberately tiny (title + birth time);
// everything else (members, progress, "waiting on") is derived, not stored.
export interface TaskMeta {
  title: string;
  created_at: string; // ISO — when the task was first minted
}

export type TaskRegistry = Record<string, TaskMeta>;

// A2 — stable task_id dedup. The skill (LLM) decides whether each new action
// joins an existing task or starts a new one; this function is the
// deterministic guard that catches the mistake of minting a SECOND id for a
// task that already exists. Title is the comparison key (normalized): same
// task, same title, same id — across rounds and across people.
//
// Normalization: lowercase, trim, collapse internal whitespace. Anything
// fancier (fuzzy match, embeddings) would create false positives that silently
// merge unrelated tasks — title equality is the contract the skill is asked
// to honor.
export function normalizeTaskTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

// Result of running dedup against a current registry + a batch of candidate
// mints. The caller persists `additions` to the registry and applies
// `rewrites` to any action whose task_id was a duplicate.
export interface TaskDedupResult {
  additions: TaskRegistry; // genuinely new tasks to add
  rewrites: Record<string, string>; // candidateId -> existingId (drop candidate, retarget actions)
}

// Stable task_id dedup. For each candidate mint:
//  - if its id already exists in the registry, leave it alone (idempotent
//    re-emit — round-commit already preserves existing entries);
//  - else if its normalized title matches an existing task, record a rewrite
//    from candidateId -> existingId and DO NOT add the candidate;
//  - else accept it as a new addition (and seed it into the in-batch index so
//    a second candidate with the same title rewrites to the first one).
//
// Same input always produces the same output — no clock, no randomness.
export function dedupTaskMints(
  registry: TaskRegistry,
  candidateMints: TaskRegistry,
): TaskDedupResult {
  const additions: TaskRegistry = {};
  const rewrites: Record<string, string> = {};

  // Reverse index: normalized title -> existing task_id.
  const titleToId = new Map<string, string>();
  for (const [id, meta] of Object.entries(registry))
    titleToId.set(normalizeTaskTitle(meta.title), id);

  for (const [candidateId, meta] of Object.entries(candidateMints)) {
    if (registry[candidateId]) continue; // idempotent — same id re-emitted
    const norm = normalizeTaskTitle(meta.title);
    const existingId = titleToId.get(norm);
    if (existingId) {
      rewrites[candidateId] = existingId;
    } else {
      additions[candidateId] = meta;
      titleToId.set(norm, candidateId); // dedup within the batch too
    }
  }

  return { additions, rewrites };
}

// Apply task_id rewrites to a batch of items. Returns a new array; items whose
// task_id is a rewrite key get the existing id substituted, others are
// returned unchanged. Empty rewrites short-circuits to the same array ref.
export function applyTaskRewrites<T extends { task_id?: string }>(
  items: T[],
  rewrites: Record<string, string>,
): T[] {
  if (Object.keys(rewrites).length === 0) return items;
  return items.map((it) =>
    it.task_id && rewrites[it.task_id]
      ? { ...it, task_id: rewrites[it.task_id]! }
      : it,
  );
}

export type TaskStatus = "open" | "waiting" | "done";

export interface TaskCluster {
  task_id: string | null; // null = the ungrouped bucket (standalone actions)
  title: string | null;
  created_at: string | null; // task's mint time, or earliest member if ungrouped
  actions: ActionItem[]; // ordered: ready → needs-info → approved → terminal
  done: number; // members with status "executed"
  total: number; // members excluding rejected
  status: TaskStatus; // derived from members
}

// Lower rank sorts first within a group (design 5A: ready-to-approve first,
// needs-info last). approved (queued-to-flush) and terminal trail behind.
function memberRank(a: ActionItem): number {
  if (a.status === "suggested") return missingInfo(a).length === 0 ? 0 : 1;
  if (a.status === "approved") return 2;
  return 3; // executed / rejected
}

function deriveStatus(members: ActionItem[]): TaskStatus {
  const live = members.filter((m) => m.status !== "rejected");
  if (live.length === 0) return "done"; // everything skipped → nothing pending
  if (live.every((m) => m.status === "executed")) return "done";
  if (live.some((m) => m.status === "approved")) return "waiting"; // queued to flush
  return "open";
}

function earliest(members: ActionItem[]): string {
  return members.reduce(
    (min, m) => (m.created_at && m.created_at < min ? m.created_at : min),
    members[0]?.created_at ?? "",
  );
}

// Group actions into task clusters. Ungrouped actions (no task_id) each become
// their own single-action cluster with task_id=null so the Queue can render them
// at the same level as task groups. A task_id with no registry entry is an
// orphan: it still clusters (defensive — never drop an action), titled by id.
export function groupByTask(
  actions: ActionItem[],
  registry: TaskRegistry,
): TaskCluster[] {
  const grouped = new Map<string, ActionItem[]>();
  const ungrouped: ActionItem[] = [];
  for (const a of actions) {
    if (a.task_id) {
      const arr = grouped.get(a.task_id) ?? [];
      arr.push(a);
      grouped.set(a.task_id, arr);
    } else {
      ungrouped.push(a);
    }
  }

  const clusters: TaskCluster[] = [];
  for (const [task_id, members] of grouped) {
    members.sort(
      (x, y) => memberRank(x) - memberRank(y) || x.created_at.localeCompare(y.created_at),
    );
    const meta = registry[task_id];
    clusters.push({
      task_id,
      title: meta?.title ?? `(untitled task ${task_id.slice(0, 8)})`,
      created_at: meta?.created_at ?? earliest(members),
      actions: members,
      done: members.filter((m) => m.status === "executed").length,
      total: members.filter((m) => m.status !== "rejected").length,
      status: deriveStatus(members),
    });
  }
  // Each ungrouped action is its own cluster (task_id null).
  for (const a of ungrouped) {
    clusters.push({
      task_id: null,
      title: null,
      created_at: a.created_at,
      actions: [a],
      done: a.status === "executed" ? 1 : 0,
      total: a.status === "rejected" ? 0 : 1,
      status: deriveStatus([a]),
    });
  }

  // Groups oldest-first by their anchor time (design 5A: between-group order).
  clusters.sort((x, y) => (x.created_at ?? "").localeCompare(y.created_at ?? ""));
  return clusters;
}
