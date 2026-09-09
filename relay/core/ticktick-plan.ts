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
import { zoneOffsetAt } from "./when.js";
import { ENGINE_TAG, type TickTickTaskPayload } from "./ticktick.js";
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
 * ONLY A and B (owner, 2026-08-13). At "drop D, keep the rest" the list reached
 * 23 rows, which is the 20-40 row list he asked not to have; C is "matters, no
 * immediate clock" and belongs in the queue, not in the list he works from. An
 * UNRANKED unit is also out: the ranking pass runs every tick, so a task the
 * plan has not judged yet simply waits a round rather than arriving unsorted.
 *
 * An UNGROUPED card is one message the consolidate pass could not attach to a
 * task — surfacing every one as a top-level to-do is the same failure, so a lone
 * card still needs top tier.
 */
// The LEDGER is the list's source now (specs/person-first-consolidation.md §7
// phase 4), so card units render only for the two jobs the ledger cannot do:
//
//   EXECUTABLE — a tickable invite or tool line (calendar with every attendee
//   resolved, or a tool card). The line IS the action; ticking it executes.
//
//   PERSONA-LESS — work from a sender no persona claims (a bank alert, a
//   vendor notice; spec §6 risk 3). No persona means no ledger entry, so the
//   card is this work's only path onto the list.
//
// The A/B tier gate died with the ranking pass: needs_leo gates ledger rows,
// and these two card classes are self-selecting.
export function shouldRenderCardUnit(
  unit: TaskUnit,
  isPersonaLess: (unit: TaskUnit) => boolean,
  nowMs: number,
): boolean {
  const live = unit.members.filter((m) => m.status !== "executed" && m.status !== "rejected");
  if (live.length === 0) return false;
  // An EVENT that already happened is over. Only when every live member is such
  // an event — a unit that also carries a task or a reply still has work in it.
  if (live.every((m) => isPastEvent(m, nowMs))) return false;
  return live.some(isExecutableAction) || isPersonaLess(unit);
}

// Mirrors lineFor's actionId branches: those are the lines whose tick executes.
export function isExecutableAction(a: ActionItem): boolean {
  if (a.action_type === "tool") return true;
  if (a.action_type !== "calendar") return false;
  const p = a.params;
  const unresolved = [...nonEmails(p.attendees), ...nonEmails(p.attendees_unresolved)];
  return unresolved.length === 0 && emails(p.attendees).length > 0;
}

// A DEADLINE in the past is the opposite of finished: unpaid, unsigned, unsent
// work is MORE urgent once its date slips, and hiding it would be the worst
// possible reading of "drop what has passed". Only a calendar EVENT is judged
// here — the visit happened, the call was taken.
//
// The grace window is a day. params.start is a wall clock whose zone lives in
// params.tz, so parsing it here is accurate only to within a day's offsets; a
// day of slack also keeps something happening later today on the list.
const PAST_EVENT_GRACE_MS = 24 * 60 * 60 * 1000;

function isPastEvent(m: ActionItem, nowMs: number): boolean {
  if (m.action_type !== "calendar") return false;
  const start = typeof m.params.start === "string" ? m.params.start : "";
  const t = Date.parse(start);
  if (Number.isNaN(t)) return false;
  return t + PAST_EVENT_GRACE_MS < nowMs;
}

// Action types this mapping renders. An `ignore` card is not work.
const RENDERED_TYPES = new Set(["calendar", "tool", "task"]);
// An opaque platform id: a Slack user/channel id or a WeChat wxid.

const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/**
 * "2026-08-20T09:00:00-05:00" → "8/20 09:00", in the OWNER's zone.
 *
 * Reading the literal wall-clock fields was wrong whenever the drafter chose a
 * different offset than the owner's. A real card: a 15:00 Lisbon call came back
 * as "2026-08-13T22:00:00+08:00" — the right INSTANT (UTC 14:00), written with a
 * China offset — and the literal read put "8/13 22:00" on the owner's checklist
 * for a call he takes at 09:00. So a string carrying an offset is converted to
 * `zone`; one without an offset has no instant to convert and is read literally.
 */
export function wallClockLabel(iso: string, zone?: string): string | null {
  const s = iso.trim();
  if (zone && ZONED.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      const p: Record<string, string> = {};
      for (const { type, value } of new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        hour12: false,
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).formatToParts(d)) {
        p[type] = value;
      }
      const hour = p.hour === "24" ? "00" : p.hour;
      // Number() strips the leading zero Intl keeps even at month:"numeric", so
      // this reads identically to the literal branch below.
      if (p.month && p.day && hour && p.minute)
        return `${Number(p.month)}/${Number(p.day)} ${hour}:${p.minute}`;
    }
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  return `${Number(m[2])}/${Number(m[3])} ${m[4]}:${m[5]}`;
}

/**
 * A deadline as TickTick's `dueDate` / `isAllDay`, or null if it is not a date.
 *
 * create_task declares dueDate as `format: date-time`, so a BARE date is a
 * validation error, not an all-day task — it is expanded to local midnight and
 * flagged all-day. A datetime keeps its own offset; one without an offset gets
 * the owner's offset FOR THAT DATE, so a summer deadline set in winter is still
 * right.
 */
export function dueFields(
  deadline: string,
  zone: string,
): { dueDate: string; isAllDay: boolean } | null {
  const s = deadline.trim();
  if (DATE_ONLY.test(s)) {
    const wall = `${s}T00:00:00`;
    return { dueDate: `${wall}${zoneOffsetAt(wall, zone) ?? "Z"}`, isAllDay: true };
  }
  if (!DATE_TIME.test(s)) return null;
  const iso = s.replace(" ", "T");
  const full = /T\d{2}:\d{2}$/.test(iso) ? `${iso}:00` : iso;
  if (ZONED.test(full)) return { dueDate: full, isAllDay: false };
  return { dueDate: `${full}${zoneOffsetAt(full, zone) ?? "Z"}`, isAllDay: false };
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
function lineFor(a: ActionItem, zone: string): { title: string; actionId?: string } | null {
  const p = a.params;
  switch (a.action_type) {
    case "calendar": {
      const resolved: ResolvedAttendee[] = emails(p.attendees).map((email) => ({ email }));
      // Names are resolved to addresses at draft time now
      // (core/attendee-resolver.ts), and whatever could NOT be resolved is
      // parked in params.attendees_unresolved. Still read non-emails out of
      // `attendees` as well, for cards drafted before that landed.
      const unresolved = [...nonEmails(p.attendees), ...nonEmails(p.attendees_unresolved)];
      const when = wallClockLabel(str(p.start), zone) ?? "";
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
    case "forward":
      // Retired from production (owner, 2026-08-14: "AI暂时不帮我回复") — the
      // passes no longer emit these, and a legacy card still in state must not
      // render: an owed answer surfaces as a `task` line instead. One-click
      // reply drafting is shelved (specs/person-first-consolidation.md §3.5).
      return null;
    case "task":
      return { title: str(p.title) || a.headline || "(untitled)" };
    default:
      return null; // ignore
  }
}

/** The task's real deadline, if it has one. Never invented — see the header. */
export function deadlineFor(unit: TaskUnit): string | null {
  // The whole value must be a date or a datetime. A `deadline` entity is FREE
  // TEXT the ranking model writes, and "2026-08-13 15:00 Portugal time" is one
  // it really produced: the old PREFIX test matched it and sent that string as
  // dueDate, TickTick rejected the create, and an A-tier task silently never
  // reached the list. Salvaging the "15:00" would be worse than dropping it —
  // that clock is Lisbon's, and stamping the owner's offset on it moves the call
  // six hours. The dated calendar member below is the trustworthy source.
  const dated = unit.members
    .filter((m) => m.action_type === "calendar" && typeof m.params.start === "string")
    .map((m) => m.params.start as string)
    .sort();
  return dated[0] ?? null;
}

/**
 * The DRAFTED TICKET, laid out for review.
 *
 * Ticking is the approval, so whatever the row does not show, the owner
 * approves blind. The checklist line names the destination and assignee but has
 * no room for the body, and the body is where both of 2026-09-09's real tickets
 * went wrong: one needed its description halved, the other went out assigned to
 * the wrong engineer. 「让我review一下你准备创建的ticket」.
 *
 * So the line stays one line and the ticket itself goes in the note.
 */
function ticketBlock(unit: TaskUnit): string {
  const out: string[] = [];
  for (const m of unit.members) {
    if (m.action_type !== "tool" || m.status === "executed" || m.status === "rejected") continue;
    const p = (m.params ?? {}) as Record<string, unknown>;
    const str = (k: string): string => (typeof p[k] === "string" ? (p[k] as string).trim() : "");
    const summary = str("summary");
    const description = str("description");
    if (!summary && !description) continue;
    out.push(
      [
        `🎫 ${str("tool") || "ticket"}${str("project") ? ` · ${str("project")}` : ""}`,
        summary ? `标题: ${summary}` : "",
        // Absent is stated, never left blank: a silent gap reads as "assigned".
        `指派: ${str("assignee") || "未指派 (unassigned)"}`,
        description ? `\n${description}` : "",
      ]
        .filter((l) => l !== "")
        .join("\n"),
    );
  }
  return out.join("\n\n");
}

function describe(unit: TaskUnit): string {
  // The ranking pass that wrote a "why now" + entities is retired; a card row's
  // note is otherwise whatever its members carry (summaries ride the checklist
  // lines) — except a drafted ticket, which must be readable before it is
  // ticked.
  return ticketBlock(unit);
}

export function buildTaskPayload(unit: TaskUnit, zone: string): BuiltTask {
  const lines: ChecklistLine[] = [];
  for (const member of unit.members) {
    if (member.status === "executed" || member.status === "rejected") continue;
    // An `ignore` card (or an action type this mapping does not render) is not
    // work; anything else contributes its steps even when it has no summary line.
    if (!RENDERED_TYPES.has(member.action_type)) continue;
    const line = lineFor(member, zone);
    const steps = (member.next_actions ?? []).map((s) => s.trim()).filter((s) => s !== "");

    // The member's own line is a SUMMARY of what the card is about, and its
    // next_actions are the same thing spelled out — emitting both produced
    // "跟进 200 套 Switcher 发货与运单号" immediately followed by "向温总确认是否
    // 已寄出", which is one job listed twice.
    //
    // So the summary line is kept only when it earns its place: when it is
    // EXECUTABLE (a tickable invite or tool line — that line IS the action, not
    // a description of it), or when there are no steps to replace it.
    // A null line means "no summary line for this member" — an attendee-less
    // calendar card is auto-created, so it is not a step Leo performs. It used to
    // `continue`, which threw away that card's next_actions too: a calendar card
    // with 3 real steps contributed NOTHING, and the task went from 5 checklist
    // items to none while TickTick kept showing the old five.
    if (line && (line.actionId || steps.length === 0)) {
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

  // A name the drafter used in an addressing position that is in neither the
  // thread nor the roster (core/name-check.ts). Surfaced at the TOP of the
  // notes, because the steps below may tell the owner to contact that person —
  // "回 Fabian" on a card whose sender was Cody is the case this exists for.
  const unverified = [
    ...new Set(
      unit.members.flatMap((m) => {
        const raw = m.params?.unverified_names;
        return Array.isArray(raw) ? raw.filter((n): n is string => typeof n === "string") : [];
      }),
    ),
  ];
  const note = [
    unverified.length > 0 ? `⚠️ 姓名未核实（会话和人物档案里都没有）：${unverified.join("、")}` : "",
    describe(unit),
  ]
    .filter((b) => b !== "")
    .join("\n\n");
  const deadline = deadlineFor(unit);
  const payload: TickTickTaskPayload = {
    title: unit.title,
    // The tier that used to set this died with the ranking pass. Card rows are
    // executable/persona-less only; medium keeps them visible without faking
    // urgency (dates, not flags, drive TickTick's Today view).
    priority: 3,
    tags: [ENGINE_TAG],
    // BOTH note fields and `items` are ALWAYS sent, even empty.
    //
    // update_task is a PARTIAL patch: a field we omit keeps whatever TickTick
    // already has. Omitting the inactive one left a task carrying a TEXT-round
    // `content` AND a CHECKLIST-round `desc` at the same time, and omitting
    // `items` left a stale five-item checklist on a task our payload said had
    // none — while the hash gate reported "in sync", because the hash only
    // describes what we MEANT to send. The list Leo reads was showing content
    // the engine no longer believed.
    ...(lines.length > 0
      ? {
          kind: "CHECKLIST" as const,
          desc: note,
          content: "",
          items: lines.map(({ actionId: _a, ...i }) => i),
        }
      : { kind: "TEXT" as const, content: note, desc: "", items: [] }),
  };
  const due = deadline ? dueFields(deadline, zone) : null;
  if (due) {
    payload.dueDate = due.dueDate;
    payload.isAllDay = due.isAllDay;
    payload.timeZone = zone;
  }

  return {
    payload,
    executable: lines
      .filter((l) => l.actionId)
      .map((l) => ({ sortOrder: l.sortOrder, actionId: l.actionId! })),
  };
}
