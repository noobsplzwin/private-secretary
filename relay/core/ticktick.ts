// TickTick types and project resolution. Pure core: no I/O, no MCP.
//
// What a row looks like is core/ticktick-plan.ts; how it is written is
// proc/ticktick-sync.ts. This file holds the payload shape they share, the
// tag that marks the engine's tasks, and the project lookup:
//
//   · PROJECT. Resolution is ASK-not-GUESS, the same rule as recipients
//     (core/recipient-resolver.ts) and Jira assignees (core/jira-assignee.ts):
//     an exact unambiguous name match or nothing. A near-miss would file the
//     task in the wrong list, where the user never looks at it again.


export type TickTickPriority = 0 | 1 | 3 | 5;

export interface TickTickChecklistItem {
  title: string;
  status: 0 | 1;
  sortOrder: number;
}

// The subset of TickTick's OpenTask we send. Field names are TickTick's, not
// ours, so the io layer passes this through without re-mapping.
export interface TickTickTaskPayload {
  title: string;
  kind: "TEXT" | "CHECKLIST";
  priority: TickTickPriority;
  content?: string; // notes, when kind is TEXT
  desc?: string; // notes, when kind is CHECKLIST
  items?: TickTickChecklistItem[];
  tags?: string[];
  project?: string; // NAME; the io layer resolves it to a projectId
  // Set ONLY when the task really has a deadline — never invented. TickTick's
  // Today / Next 7 Days are date-driven, so a fabricated "due today" on every
  // urgent item makes Today meaningless within a week.
  dueDate?: string;
  // Always written WITH dueDate, equal to it. update_task is a partial patch,
  // so a startDate written once outlives every later dueDate: on 2026-10-01 the
  // 4.5 core-board task read start 10/5, due 9/30 — the start left over from a
  // review date, the due a real deadline written after it.
  startDate?: string;
  isAllDay?: boolean;
  // The zone TickTick renders the date in. Sent with every dueDate because the
  // ACCOUNT default is whatever the app was first set up with — this one reads
  // "America/New_York" while the owner's engine zone is America/Winnipeg, so
  // every timed item displayed an hour late until this was passed explicitly.
  timeZone?: string;
  // 0 ONLY, and only on an update that REOPENS a completed task (sync's
  // tombstone match). create_task ignores status entirely (io/ticktick-mcp.ts
  // header), so this is never set on a create.
  status?: 0;
}

// The tag every engine-created task carries, so the user can tell what the
// secretary filed from what they typed themselves.
export const ENGINE_TAG = "secretary";

// ─── project resolution (ASK-not-GUESS) ──────────────────────────────

export interface TickTickProject {
  id: string;
  name: string;
}

export type ProjectResolution =
  | { status: "resolved"; id: string }
  | { status: "ambiguous"; matches: string[] }
  | { status: "not_found" };

// Exact name match, case- and whitespace-insensitive. Anything fuzzier files
// the to-do in a list the user isn't watching.
export function resolveTickTickProject(
  name: string,
  projects: readonly TickTickProject[],
): ProjectResolution {
  const want = name.trim().toLowerCase();
  if (!want) return { status: "not_found" };
  const hits = projects.filter((p) => (p.name ?? "").trim().toLowerCase() === want);
  if (hits.length === 1) return { status: "resolved", id: hits[0]!.id };
  if (hits.length > 1) return { status: "ambiguous", matches: hits.map((p) => p.id) };
  return { status: "not_found" };
}

// TickTick's real per-call ceiling for batch_add_tasks / batch_update_tasks.
// Exceeding it TRUNCATES SILENTLY — 100 tasks in, 50 created, id2error empty —
// which is how the first bulk run lost 803 tasks without an error. A hard
// constant, never a tunable.
export const TICKTICK_BATCH_MAX = 50;
