// A task cluster → the TickTick task the owner actually reads. Pure core.
//
// THE UNIT IS THE TASK, NOT THE MESSAGE (owner, 2026-08-12). What belongs in
// TickTick is "香港出差" with 安排日程 / 订机票 / 订宾馆 under it, or "Rev5
// Release" with its steps — a handful of real things ranked by priority. One
// row per inbound message would bury the list, which is the failure this
// mapping is shaped to avoid.
//
// So a TickTick task is a TaskCluster (task_id + its member actions) and the
// checklist is the concrete steps. shouldSync() is the floor that keeps the
// list short; it cannot manufacture quality, though — if the consolidate pass
// leaves conversations ungrouped, this surfaces fewer of them rather than
// pretending they are tasks.
//
// DUE DATES ARE NEVER INVENTED. A date is set only when the task really has a
// deadline (a "deadline" entity, or the earliest dated calendar member).
// TickTick's Today / Next 7 Days then sort themselves out: a real deadline
// today lands in Today, one later this week lands in Next 7 Days, and a task
// with no deadline carries no date and is ordered by priority alone. Inventing
// "due today" for every A-tier item would make Today meaningless within a week.

import type { ActionItem } from "./action-item.js";
import type { TaskPlan } from "./tasks.js";
import { tierToPriority, ENGINE_TAG, type TickTickTaskPayload } from "./ticktick.js";
import {
  buildInviteLabel,
  buildToolLabel,
  buildUnresolvedLabel,
  type ResolvedAttendee,
} from "./ticktick-approval.js";

export interface TaskUnit {
  unitKey: string;
  title: string;
  /** True when the LLM actually grouped this into a task (vs a lone card). */
  grouped: boolean;
  plan?: TaskPlan;
  members: readonly ActionItem[];
}

/** A checklist line plus, when it is executable, the action it approves. */
export interface ChecklistLine {
  title: string;
  status: 0 | 1;
  sortOrder: number;
  /** Set only for a tickable line — see core/ticktick-approval.ts. */
  actionId?: string;
}

export interface BuiltTask {
  payload: TickTickTaskPayload;
  /** itemId is filled in by the io layer once TickTick returns the ids. */
  executable: Array<{ sortOrder: number; actionId: string }>;
}

/**
 * Whether this unit earns a row in the owner's Work list.
 *
 * D-tier is noise by definition. An UNGROUPED card is one message the
 * consolidate pass could not attach to a task — surfacing every one of those as
 * a top-level to-do is exactly the 20-40 row list the owner does not want, so
 * only a top-tier one gets through on its own.
 */
export function shouldSync(unit: TaskUnit): boolean {
  const tier = unit.plan?.tier;
  if (tier === "D") return false;
  if (!unit.grouped && tier !== "A") return false;
  return unit.members.some((m) => m.status !== "executed" && m.status !== "rejected");
}

// "2026-08-20T09:00:00-05:00" → "8/20 09:00". Reads the LITERAL wall-clock
// fields: the string already carries its own offset, so there is nothing to
// convert and no zone to get wrong.
export function wallClockLabel(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso.trim());
  if (!m) return null;
  return `${Number(m[2])}/${Number(m[3])} ${m[4]}:${m[5]}`;
}

function emails(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.includes("@"));
}

function nonEmails(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && !v.includes("@") && v.trim() !== "");
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** The one-line label for a member action, plus whether ticking it executes. */
function lineFor(a: ActionItem): { title: string; actionId?: string } | null {
  const p = a.params;
  switch (a.action_type) {
    case "calendar": {
      const resolved: ResolvedAttendee[] = emails(p.attendees).map((email) => ({ email }));
      // Names are resolved to addresses at draft time now
      // (core/attendee-resolver.ts), and whatever could NOT be resolved is
      // parked in params.attendees_unresolved. Still read non-emails out of
      // `attendees` as well, for cards drafted before that landed.
      const unresolved = [...nonEmails(p.attendees), ...nonEmails(p.attendees_unresolved)];
      const when = wallClockLabel(str(p.start)) ?? "";
      // ASK-not-GUESS: a name that did not resolve to an address must never sit
      // behind a tickable send, so the whole line degrades to a manual one.
      if (unresolved.length > 0) return { title: buildUnresolvedLabel(unresolved) };
      if (resolved.length === 0) return null; // attendee-less: auto-created, not a step
      return {
        title: buildInviteLabel({ attendees: resolved, whenLabel: when, title: str(p.title) }),
        actionId: a.id,
      };
    }
    case "tool": {
      const assignee = str(p.assignee);
      return {
        title: buildToolLabel({
          tool: str(p.tool) || "tool",
          summary: str(p.summary) || str(p.title) || a.headline || "(no summary)",
          destination: str(p.project) || undefined,
          // Only a resolved address; jira-assignee.ts refuses to guess one.
          assignee: assignee.includes("@") ? assignee : undefined,
        }),
        actionId: a.id,
      };
    }
    case "reply":
    case "relay":
    case "forward": {
      // Inert on purpose: a checklist item cannot show the draft, so ticking it
      // would be a blind approval. These keep their cockpit review.
      const who = a.context?.sender_name ?? a.context?.sender_handle ?? "";
      const what = a.headline || str(p.title) || "回复";
      return { title: `✉️ ${what}${who ? ` · ${who}` : ""}（在 cockpit 审批）` };
    }
    case "task":
      return { title: str(p.title) || a.headline || "(untitled)" };
    default:
      return null; // ignore
  }
}

/** The task's real deadline, if it has one. Never invented — see the header. */
export function deadlineFor(unit: TaskUnit): string | null {
  const entity = unit.plan?.entities?.find((e) => e.kind === "deadline" && e.value);
  if (entity?.value && /^\d{4}-\d{2}-\d{2}/.test(entity.value)) return entity.value;
  const dated = unit.members
    .filter((m) => m.action_type === "calendar" && typeof m.params.start === "string")
    .map((m) => m.params.start as string)
    .sort();
  return dated[0] ?? null;
}

function describe(unit: TaskUnit): string {
  const blocks: string[] = [];
  if (unit.plan?.why) blocks.push(unit.plan.why);
  const entities = (unit.plan?.entities ?? []).filter((e) => e.label && e.kind !== "deadline");
  if (entities.length > 0) {
    blocks.push(entities.map((e) => `• ${e.label}${e.value ? `: ${e.value}` : ""}`).join("\n"));
  }
  return blocks.join("\n\n");
}

export function buildTaskPayload(unit: TaskUnit): BuiltTask {
  const lines: ChecklistLine[] = [];
  for (const member of unit.members) {
    if (member.status === "executed" || member.status === "rejected") continue;
    const line = lineFor(member);
    if (!line) continue;
    const steps = (member.next_actions ?? []).map((s) => s.trim()).filter((s) => s !== "");

    // The member's own line is a SUMMARY of what the card is about, and its
    // next_actions are the same thing spelled out — emitting both produced
    // "跟进 200 套 Switcher 发货与运单号" immediately followed by "向温总确认是否
    // 已寄出", which is one job listed twice.
    //
    // So the summary line is kept only when it earns its place: when it is
    // EXECUTABLE (a tickable invite or tool line — that line IS the action, not
    // a description of it), or when there are no steps to replace it.
    if (line.actionId || steps.length === 0) {
      lines.push({
        title: line.title,
        status: 0,
        sortOrder: lines.length,
        ...(line.actionId ? { actionId: line.actionId } : {}),
      });
    }
    for (const text of steps) {
      lines.push({ title: text, status: 0, sortOrder: lines.length });
    }
  }

  const note = describe(unit);
  const deadline = deadlineFor(unit);
  const payload: TickTickTaskPayload = {
    title: unit.title,
    priority: tierToPriority(unit.plan?.tier),
    tags: [ENGINE_TAG],
    ...(lines.length > 0
      ? { kind: "CHECKLIST" as const, ...(note ? { desc: note } : {}), items: lines.map(({ actionId: _a, ...i }) => i) }
      : { kind: "TEXT" as const, ...(note ? { content: note } : {}) }),
  };
  if (deadline) {
    payload.dueDate = deadline;
    // A bare date is an all-day deadline; one carrying a clock time is not.
    payload.isAllDay = !/T\d{2}:\d{2}/.test(deadline);
  }

  return {
    payload,
    executable: lines
      .filter((l) => l.actionId)
      .map((l) => ({ sortOrder: l.sortOrder, actionId: l.actionId! })),
  };
}
