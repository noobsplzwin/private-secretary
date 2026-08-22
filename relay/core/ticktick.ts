// TickTick field mapping. Pure core: no I/O, no MCP.
//
// A `task` action item IS Leo's to-do, so on approval it becomes a real
// TickTick task instead of the old local-only receipt (relay/proc/execute.ts).
// Two mappings are not obvious and are therefore fixed here, tested:
//
//   · PRIORITY. TickTick's scale is 0/1/3/5 (none/low/medium/high) — four
//     values, but no slot below "low". The daily plan's A/B/C/D tier maps
//     A→5 B→3 C→1 D→0, so D collapses onto "none". An UNPLANNED task (no
//     tier yet — the ranking pass runs after the card is drafted) is 0, never
//     a guessed middle: an invented priority reorders a real to-do list.
//
//   · PROJECT. Resolution is ASK-not-GUESS, the same rule as recipients
//     (core/recipient-resolver.ts) and Jira assignees (core/jira-assignee.ts):
//     an exact unambiguous name match or nothing. A near-miss would file the
//     task in the wrong list, where the user never looks at it again.
//
// next_actions become CHECKLIST items — they are the concrete steps, and a
// checklist is the only TickTick shape that lets the user tick them off
// individually. They are always created unchecked; the engine has no evidence
// any step is done.

import type { ActionItem } from "./action-item.js";
import type { TaskPlan } from "./tasks.js";

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

export const TIER_PRIORITY: Record<TaskPlan["tier"], TickTickPriority> = {
  A: 5,
  B: 3,
  C: 1,
  D: 0,
};

export function tierToPriority(tier?: TaskPlan["tier"]): TickTickPriority {
  return tier ? TIER_PRIORITY[tier] : 0;
}

// The tag every engine-created task carries, so the user can tell what the
// secretary filed from what they typed themselves.
export const ENGINE_TAG = "secretary";

export interface BuildOptions {
  plan?: TaskPlan; // the ranking pass's tier + "why now"
  project?: string; // destination list NAME (from the tool config)
}

// Provenance line: where this to-do came from, so a task in TickTick is
// traceable back to the conversation that produced it without the cockpit.
function provenance(action: ActionItem): string {
  const platform = action.source_message_id.split(":")[0] ?? "";
  const who = action.context?.sender_name ?? action.context?.sender_handle;
  const when = (action.context?.sent_at ?? action.created_at).slice(0, 10);
  const parts = ["— Private Secretary", platform, who, when].filter(
    (p): p is string => typeof p === "string" && p !== "",
  );
  return parts.join(" · ");
}

function notes(action: ActionItem, plan?: TaskPlan): string {
  const blocks: string[] = [];
  if (action.summary) blocks.push(action.summary);
  if (plan?.why) blocks.push(`Why now: ${plan.why}`);
  // Entities are pointers the user needs to finish the task (a price, a file,
  // a confirmation number) — worth carrying, since TickTick is where they'll
  // read the task.
  const entities = (plan?.entities ?? []).filter((e) => e.label);
  if (entities.length > 0) {
    blocks.push(
      entities
        .map((e) => `• ${e.label}${e.value ? `: ${e.value}` : ""}${e.source ? ` (${e.source})` : ""}`)
        .join("\n"),
    );
  }
  blocks.push(provenance(action));
  return blocks.join("\n\n");
}

// Build the TickTick payload for a `task` action item. Throws on an empty
// title — missingInfo() already blocks approval without one, so reaching here
// titleless is a bug, not a user error to paper over with a placeholder.
export function buildTickTickTask(action: ActionItem, opts: BuildOptions = {}): TickTickTaskPayload {
  const title = typeof action.params.title === "string" ? action.params.title.trim() : "";
  if (!title) throw new Error("ticktick: task action has no params.title");

  const steps = (action.next_actions ?? []).map((s) => s.trim()).filter((s) => s !== "");
  const note = notes(action, opts.plan);
  const base = {
    title,
    priority: tierToPriority(opts.plan?.tier),
    tags: [ENGINE_TAG],
    ...(opts.project ? { project: opts.project } : {}),
  };

  if (steps.length === 0) return { ...base, kind: "TEXT", content: note };
  return {
    ...base,
    kind: "CHECKLIST",
    desc: note,
    items: steps.map((s, i) => ({ title: s, status: 0 as const, sortOrder: i })),
  };
}

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
