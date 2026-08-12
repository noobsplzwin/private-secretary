// Action Item: the engine's single output type. A relay is just one action_type,
// executed via RelayExecutor after approval like every other action.
//
// Status flow (no-double-execute is a mandatory regression guarantee):
//
//   suggested ──approve──▶ approved ──markExecuted──▶ executed   (terminal)
//       │                     ▲
//       └──skip──▶ rejected   │ wechat reply/relay/forward wait at "approved"
//                  (terminal) │ for manual paste; auto-send platforms execute
//                             │ immediately after approve, then markExecuted

import { isValidTimeZone, resolveWallTime } from "./when.js";
import { AUTO_SEND_PLATFORMS, type Attachment, type Platform } from "./types.js";
import { DEFAULT_TOOL_SPECS, type ToolSpec } from "./tool-registry.js";

// Scan interval: a single constant. Override with the SCAN_INTERVAL_MINUTES env var
// at the call site if needed. No config system (V1 hard decision).
export const DEFAULT_SCAN_INTERVAL_MINUTES = 30;

export type ActionType =
  | "reply"
  | "relay"
  | "forward"
  | "calendar"
  | "task"
  | "ignore"
  | "tool";
// Every action — reply included — is human-in-the-loop: nothing executes until the
// user approves. After approval it executes (sends/creates). The approval gate is
// the guarantee, not "never send".
export type ActionStatus = "suggested" | "approved" | "executed" | "rejected";

// Proof an executor's platform side-effect already happened. Written before the
// terminal transition; on retry, a present receipt means skip the API call and go
// straight to terminal — so replaying an approved action never double-sends.
export interface ExecutionReceipt {
  kind: "sent" | "calendar_event" | "local" | "tool_result";
  ref: string; // message_link / event_id / tool result key / "local"
  at: string; // ISO timestamp
}

export interface ActionTarget {
  personaKey?: string | null;
  platform?: Platform | null;
  attendees?: string[];
}

// Snapshot of everything the cockpit needs to render an action's detail pane
// WITHOUT MCP access (Phase 2, T2). The scan persists this when it creates the
// row — once written it is the offline source of truth, because the cockpit
// cannot re-fetch the original from Slack/Gmail. evidence_consulted records the
// R5 full-context pull (thread/ticket/page ids + permalinks) so the card can
// show "what I read before drafting".
export interface TranscriptMessage {
  /** Display name if it could be resolved, else the raw handle. */
  speaker: string;
  /** True when the owner of this instance wrote it — drives side/alignment. */
  self: boolean;
  /** ms epoch. 0 when the reader had no timestamp. */
  at: number;
  text: string;
  /** A reply inside a thread rather than a top-level message. */
  threadReply?: boolean;
}

export interface ActionContext {
  original_message?: string;
  // Structured form of the same conversation, when the reader could supply it.
  // original_message stays as the LLM-facing text (and the fallback for cards
  // written before this existed); this is what the cockpit renders, because a
  // flat "U07VD53V7M3: hi" string has no name and no time to show.
  original_transcript?: TranscriptMessage[];
  sender_handle?: string;
  // Slack display name resolved at scan time (relay/io/slack-users.ts). The
  // cockpit's fallback order is persona name → this → raw sender_handle.
  sender_name?: string;
  sent_at?: string; // ISO
  permalink?: string;
  attachments?: Attachment[];
  evidence_consulted?: string[];
  // Thread locator for the Stage-2 refresh re-read. Gmail needs it (the
  // card's source_message_id is the message id, not the threadId, which is
  // otherwise unrecoverable); Slack/WeChat derive their locator from the
  // source id / sender_handle so they don't depend on this. Stored as the raw
  // platform handle (Gmail: threadId).
  thread_ref?: string;
}

export interface ActionItem {
  id: string;
  source_message_id: string;
  action_type: ActionType;
  target: ActionTarget;
  reason: string;
  confidence: number; // 0–1
  params: Record<string, unknown>; // per action_type, see missingInfo()
  draft?: string;
  status: ActionStatus;
  created_at: string; // ISO timestamp of the scan round
  // Phase 2 (T1): groups cross-round, cross-sender actions into one task (e.g.
  // the Chicago trip spans Zack + Kevin). Assigned by the skill at round-commit;
  // the registry of {task_id: {title}} lives in loop-state. Absent = ungrouped.
  task_id?: string;
  context?: ActionContext; // T2: offline detail-pane snapshot
  // Card-presentation fields (LLM-produced, optional, never gate approval):
  // headline = short "what is this about" title; summary = 1–2 sentence digest
  // of the message(s); next_actions = 1–3 concrete next-step bullets generated
  // from the persona + thread context. Absent on legacy rows → the cockpit
  // falls back to reason / original_message.
  headline?: string;
  summary?: string;
  next_actions?: string[];
  // The tracked project (id) this card advances, e.g. "OUS-1", or "MISC" when it
  // belongs to no tracked project. Set by the LLM from the project RAG; the
  // cockpit resolves it to a name + groups the Projects screen by it.
  project_id?: string;
}

const ACTION_TYPES: ReadonlySet<string> = new Set([
  "reply",
  "relay",
  "forward",
  "calendar",
  "task",
  "ignore",
  "tool",
]);
const STATUSES: ReadonlySet<string> = new Set([
  "suggested",
  "approved",
  "executed",
  "rejected",
]);

// Missing required info per action_type. A non-empty result blocks approval —
// the engine is not allowed to guess (spec hard rule).
export function missingInfo(
  a: ActionItem,
  registry: Record<string, ToolSpec> = DEFAULT_TOOL_SPECS,
): string[] {
  const missing: string[] = [];
  const p = a.params ?? {};
  const needRecipient = (): void => {
    if (!a.target?.personaKey) missing.push("target.personaKey");
    if (!a.target?.platform) missing.push("target.platform");
  };
  switch (a.action_type) {
    case "reply": {
      // A reply goes back to the SENDER — the recipient is never ambiguous,
      // so NO persona is required (the executor sends to context.sender_handle
      // / the originating channel, not target.personaKey). Only flag a missing
      // recipient if we have no way to address it at all.
      if (!a.target?.platform) missing.push("target.platform");
      if (typeof a.draft !== "string" || a.draft.trim() === "") missing.push("draft");
      const hasRecipient =
        !!a.context?.sender_handle ||
        (typeof p.to === "string" && p.to !== "") ||
        !!a.target?.personaKey;
      if (!hasRecipient) missing.push("target.personaKey");
      break;
    }
    case "relay":
      needRecipient();
      if (typeof a.draft !== "string" || a.draft.trim() === "") missing.push("draft");
      break;
    case "forward":
      needRecipient();
      break;
    case "calendar":
      for (const k of ["title", "start", "end"] as const) {
        if (typeof p[k] !== "string" || p[k] === "") missing.push(`params.${k}`);
      }
      // attendees are OPTIONAL: an auto-created event is a block on Leo's own
      // calendar (huizhezheng@gmail.com). A meeting agreed over WeChat has no
      // attendee emails — the people/place go in the title/description instead.
      // Requiring attendees would make every such event un-approvable.
      break;
    case "task":
      if (typeof p.title !== "string" || p.title === "") missing.push("params.title");
      break;
    case "ignore":
      if (typeof p.category !== "string" || p.category === "")
        missing.push("params.category");
      break;
    case "tool": {
      // A tool card needs a tool key + the tool's required params (from the
      // registry). Per-tool missing params are flagged so a card the LLM
      // drafted without them is Needs-info, not approvable.
      const tool = typeof p.tool === "string" ? p.tool : "";
      if (!tool) missing.push("params.tool");
      else {
        for (const k of registry[tool]?.requiredParams ?? []) {
          if (typeof p[k] !== "string" || p[k] === "") missing.push(`params.${k}`);
        }
      }
      break;
    }
  }
  return missing;
}

// Supersede exemption (fix/supersede-keep-calendar). Cross-tick supersede kills
// ALL still-suggested same-sender cards when a fresh draft lands — right for
// task/reply (one chatty contact = one evolving card, no floods), but a sender
// switching TOPICS would silently drop a pending meeting ("明天10点见客户"
// killed by a later unrelated message). A suggested CALENDAR card with a
// concrete start time is a commitment, not an evolving draft — exempt it.
// A calendar WITHOUT params.start still supersedes: it's half-baked and
// missing-info anyway. Trade-off: if the meeting time CHANGES in the thread,
// the old-time card now survives alongside the new one — the user picks the
// right one and skips the other. Acceptable: human decides, skip is cheap,
// and it beats silently losing the event.
export function isSupersedeExempt(a: ActionItem): boolean {
  return (
    a.action_type === "calendar" &&
    typeof a.params?.start === "string" &&
    a.params.start !== ""
  );
}

// Already-booked check (draft-commit + refresh-commit in scan-loop). A fresh
// suggested calendar whose task_id OR exact start matches an EXECUTED calendar
// is a duplicate waiting to double-book — the event already exists. Refresh
// used to skip this check entirely (phase 3 had it, phase 5 didn't), which is
// how one meeting ended up approved into N real events.
// True when this calendar card would add nothing: the same commitment is
// already booked, or is already sitting in the queue waiting to be approved.
//
// The pending half matters as much as the booked half. A refresh re-emits a
// calendar card for a live conversation every TTL, and such cards are exempt
// from supersede (a commitment must not be silently dropped) — so with only
// the executed check, one meeting accumulated a new duplicate card every ten
// minutes until the queue was nothing else. Observed: six cards for one
// Thursday meeting.
//
// Matched on the START time, not on wording. A refreshed card whose start
// MOVED is a real change and still lands, so "the meeting shifted an hour"
// is not swallowed; only an identical restatement is.
// Start times are compared as INSTANTS, not strings. The model writes the same
// moment in whatever offset the conversation used, so one meeting produced
// "2026-08-13T22:00:00+08:00" and "2026-08-13T15:00:00+01:00" on consecutive
// refreshes — identical instants that a string compare reads as two bookings.
export function startInstant(a: ActionItem): number | undefined {
  const raw = a.params?.start;
  if (typeof raw !== "string" || !raw) return undefined;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : t;
}

export function isCalendarRedundant(a: ActionItem, existing: ActionItem[]): boolean {
  if (a.action_type !== "calendar") return false;
  const start = startInstant(a);
  return existing.some((e) => {
    if (e.action_type !== "calendar") return false;
    const eStart = startInstant(e);
    if (e.status === "executed") {
      // Already on the calendar: same task or same slot is a re-booking.
      return !!((a.task_id && e.task_id === a.task_id) || (start !== undefined && eStart === start));
    }
    if (e.status !== "suggested") return false;
    // Still pending: only the same instant is redundant. Same task at a
    // different time is the meeting moving, which the user needs to see.
    return start !== undefined && eStart === start;
  });
}

// Ids of pending calendar cards that merely restate one already in the queue.
//
// isCalendarRedundant stops NEW duplicates; this clears the ones already on
// disk. Both are needed: a machine that ran the old code accumulated a card per
// refresh tick, and upgrading must not leave the user to delete six cards by
// hand — on someone else's laptop that means a terminal session.
//
// ONE pending calendar card per task, the newest.
//
// This started out grouped by start time, so a meeting that "moved" kept both
// cards. Real data killed that idea: the model got the timezone wrong three
// different ways for one 3pm meeting, and grouping by time dutifully preserved
// all four as separate "reschedules". Four contradictory times do not help
// anyone see a change — they force a guess, and guessing wrong books the wrong
// hour.
//
// The newest card is the most recent read of the conversation, which is what a
// card is supposed to be. A real reschedule still shows: the newest card
// carries the new time.
//
// Only "suggested" cards are touched. Anything approved, skipped or executed is
// the user's decision, not ours to tidy.
export function redundantPendingCalendarIds(actions: ActionItem[]): string[] {
  const bySlot = new Map<string, ActionItem[]>();
  for (const a of actions) {
    if (a.action_type !== "calendar" || a.status !== "suggested") continue;
    const key = a.task_id ?? clusterOf(a);
    const list = bySlot.get(key);
    if (list) list.push(a);
    else bySlot.set(key, [a]);
  }
  const drop: string[] = [];
  for (const group of bySlot.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((x, y) => x.created_at.localeCompare(y.created_at));
    for (const a of sorted.slice(0, -1)) drop.push(a.id);
  }
  return drop;
}

// Fallback grouping for cards with no task_id: the conversation they came from.
function clusterOf(a: ActionItem): string {
  return `${a.source_message_id.split(":").slice(0, 2).join(":")}::${a.context?.sender_handle ?? ""}`;
}

export type ValidationResult =
  | { ok: true; item: ActionItem }
  | { ok: false; errors: string[] };

// Structural validation of an LLM-produced item. Missing per-type params are NOT
// structural errors (they become missing-info and block approval instead) — but
// malformed shape, unknown enums, or out-of-range confidence are rejected outright
// so junk never enters the queue.
export function validateActionItem(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, errors: ["not an object"] };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.action_type !== "string" || !ACTION_TYPES.has(o.action_type))
    errors.push(`action_type must be one of ${[...ACTION_TYPES].join("|")}`);
  if (typeof o.source_message_id !== "string" || o.source_message_id.trim() === "")
    errors.push("source_message_id is required");
  if (typeof o.reason !== "string" || o.reason.trim() === "")
    errors.push("reason is required");
  if (typeof o.confidence !== "number" || o.confidence < 0 || o.confidence > 1)
    errors.push("confidence must be a number in [0,1]");
  if (o.status !== undefined && (typeof o.status !== "string" || !STATUSES.has(o.status)))
    errors.push(`status must be one of ${[...STATUSES].join("|")}`);
  if (o.target !== undefined && (typeof o.target !== "object" || o.target === null))
    errors.push("target must be an object");
  if (o.params !== undefined && (typeof o.params !== "object" || o.params === null))
    errors.push("params must be an object");
  if (o.draft !== undefined && typeof o.draft !== "string")
    errors.push("draft must be a string");
  if (o.task_id !== undefined && (typeof o.task_id !== "string" || o.task_id.trim() === ""))
    errors.push("task_id must be a non-empty string when present");
  if (o.context !== undefined && (typeof o.context !== "object" || o.context === null))
    errors.push("context must be an object");
  if (o.headline !== undefined && typeof o.headline !== "string")
    errors.push("headline must be a string");
  if (o.summary !== undefined && typeof o.summary !== "string")
    errors.push("summary must be a string");
  if (o.next_actions !== undefined && !Array.isArray(o.next_actions))
    errors.push("next_actions must be an array");
  if (o.project_id !== undefined && typeof o.project_id !== "string")
    errors.push("project_id must be a string");
  if (errors.length) return { ok: false, errors };

  const item: ActionItem = {
    id: typeof o.id === "string" && o.id !== "" ? o.id : "",
    source_message_id: o.source_message_id as string,
    action_type: o.action_type as ActionType,
    target: (o.target ?? {}) as ActionTarget,
    reason: o.reason as string,
    confidence: o.confidence as number,
    params: (o.params ?? {}) as Record<string, unknown>,
    draft: o.draft as string | undefined,
    status: (o.status as ActionStatus | undefined) ?? "suggested",
    created_at: typeof o.created_at === "string" ? o.created_at : "",
  };
  if (typeof o.task_id === "string" && o.task_id.trim() !== "") item.task_id = o.task_id;
  if (typeof o.context === "object" && o.context !== null)
    item.context = o.context as ActionContext;
  if (typeof o.headline === "string" && o.headline.trim() !== "") item.headline = o.headline;
  if (typeof o.summary === "string" && o.summary.trim() !== "") item.summary = o.summary;
  if (Array.isArray(o.next_actions)) {
    const xs = o.next_actions.filter((x): x is string => typeof x === "string" && x.trim() !== "");
    if (xs.length) item.next_actions = xs;
  }
  if (typeof o.project_id === "string" && o.project_id.trim() !== "") item.project_id = o.project_id.trim();
  normalizeCalendarTimes(item);
  return { ok: true, item };
}

// Convert the model's wall time + named zone into a real instant, at the one
// boundary every card passes through.
//
// The model used to do this arithmetic and got it wrong four ways for a single
// meeting — the same "3pm Portugal time" arrived as 13:00, 14:00, 15:00 and
// 07:00 UTC on consecutive refreshes. Approving the wrong one books a real
// event at the wrong hour. So the model now reports what it READ (a wall time
// and the zone that wall time belongs to) and the conversion happens here,
// once, with the zone's actual offset on that date.
//
// A value that already carries an offset is already an instant and passes
// through. A wall time with no zone is left exactly as written: guessing a zone
// is how the wrong hour gets booked, and an unparseable start blocks approval,
// which is the recoverable failure.
export function normalizeCalendarTimes(item: ActionItem): void {
  if (item.action_type !== "calendar") return;
  const zone = typeof item.params.tz === "string" ? item.params.tz.trim() : "";
  if (!zone || !isValidTimeZone(zone)) return;
  for (const field of ["start", "end"] as const) {
    const raw = item.params[field];
    if (typeof raw !== "string" || !raw.trim()) continue;
    const iso = resolveWallTime(raw, zone);
    if (iso) item.params[field] = iso;
  }
}

export class InvalidActionTransition extends Error {
  constructor(action: string, from: string, detail?: string) {
    super(
      `Invalid action transition: ${action} from "${from}"${detail ? ` — ${detail}` : ""}`,
    );
    this.name = "InvalidActionTransition";
  }
}

// True when execution cannot be automated: a send to a platform without an official
// send API (WeChat personal). These stay at "approved" until the user marks them done.
export function requiresManualExecution(a: ActionItem): boolean {
  if (
    a.action_type !== "reply" &&
    a.action_type !== "relay" &&
    a.action_type !== "forward"
  )
    return false;
  const platform = a.target?.platform;
  return platform != null && !AUTO_SEND_PLATFORMS.has(platform);
}

export function approveAction(
  a: ActionItem,
  registry: Record<string, ToolSpec> = DEFAULT_TOOL_SPECS,
): ActionItem {
  if (a.status !== "suggested") throw new InvalidActionTransition("approve", a.status);
  const missing = missingInfo(a, registry);
  if (missing.length > 0)
    throw new InvalidActionTransition(
      "approve",
      a.status,
      `missing info: ${missing.join(", ")}`,
    );
  return { ...a, status: "approved" };
}

// A note the owner leaves ON a card, as feedback, WITHOUT deciding it.
//
// WHY THIS EXISTS: for a while the only free-text field in the cockpit lived in
// the skip panel, so leaving a comment meant rejecting the card. The owner
// annotated 19 cards that way in one sitting — including several he had
// explicitly praised ("这三件事都创建的非常好") — and every one of them landed in
// the ledger as `rejected`, understating precision. Worse, a note could not be
// revised, so improving one meant restore → re-skip; one card went through that
// loop four times.
//
// So a comment: changes NO status, writes NO label (a comment is not a
// decision, and the precision metric must stay decisions-only), and APPENDS —
// re-commenting is the normal way to refine a thought.
export interface ActionComment {
  at: string; // ISO
  text: string;
}

export function readComments(a: ActionItem): ActionComment[] {
  const raw = a.params?.comments;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is ActionComment =>
      !!c && typeof (c as ActionComment).text === "string" && typeof (c as ActionComment).at === "string",
  );
}

/**
 * Append a comment. Allowed in EVERY status on purpose — the owner may well
 * want to say something about a card he already approved, and refusing that
 * would recreate the coupling this feature exists to remove.
 *
 * Stored in `params` rather than as a top-level field so it survives
 * validateActionItem, which rebuilds known fields explicitly and would
 * otherwise drop it.
 */
export function addComment(a: ActionItem, text: string, at: string): ActionItem {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("comment text is empty");
  return {
    ...a,
    params: { ...a.params, comments: [...readComments(a), { at, text: trimmed }] },
  };
}

export function rejectAction(a: ActionItem): ActionItem {
  if (a.status !== "suggested") throw new InvalidActionTransition("skip", a.status);
  return { ...a, status: "rejected" };
}

export function markExecuted(a: ActionItem): ActionItem {
  if (a.status !== "approved")
    throw new InvalidActionTransition("markExecuted", a.status);
  return { ...a, status: "executed" };
}

// Manual "mark done" from the Today resolution plan: the user asserts a
// no-side-effect reminder is handled. Only task/ignore (nothing is sent), and it
// bypasses the missing-info gate on purpose — completing a reminder must not
// require the LLM to have filled params. reply/relay/forward/calendar are NOT
// eligible (those complete by sending/booking or skipping, never a silent tick).
export function markDone(a: ActionItem): ActionItem {
  if (a.status !== "suggested" && a.status !== "approved")
    throw new InvalidActionTransition("markDone", a.status);
  if (a.action_type !== "task" && a.action_type !== "ignore")
    throw new InvalidActionTransition("markDone", a.status, "only task/ignore can be marked done");
  return { ...a, status: "executed" };
}

// Phase 2 (T6): un-approve / un-skip / un-do back to suggested, so the
// cockpit's [Restore] works from both the skipped list and the completed
// list. Only legal when NO real external side effect happened:
//   · receipt.kind "sent" / "calendar_event" → the message went out / the
//     event was created. It can never be un-sent, so restoring would lie and
//     risks a double-send on re-approval — the item stays terminal.
//   · receipt.kind "local" (auto-ticked / manually-done task·ignore) or no
//     receipt at all → nothing left the machine, so undo is safe.
// An executed item is therefore restorable ONLY in the local/no-receipt case;
// an executed item with a real side effect stays terminal forever.
export function restoreAction(a: ActionItem): ActionItem {
  if (a.status !== "rejected" && a.status !== "approved" && a.status !== "executed")
    throw new InvalidActionTransition("restore", a.status);
  const receipt = a.params?.execution_receipt as ExecutionReceipt | undefined;
  if (receipt && receipt.kind !== "local")
    throw new InvalidActionTransition(
      "restore",
      a.status,
      `already has a ${receipt.kind} receipt (real side effect happened) — cannot restore`,
    );
  return { ...a, status: "suggested" };
}

// T4 — crash-safe send. The receipt can only be written AFTER the platform call
// returns (it carries the message link / event id), so a crash between "MCP
// succeeded" and "receipt persisted" would otherwise re-send on retry. markExecuting
// writes a durable `execution_started_at` BEFORE the side effect. On retry the skill
// sees executing-but-no-receipt and MUST verify on the platform (did the message
// actually go out?) before re-sending — never blind-resend. Status stays "approved":
// no new state, just a claim flag.
export function markExecuting(a: ActionItem, at: string): ActionItem {
  if (a.status !== "approved")
    throw new InvalidActionTransition("markExecuting", a.status);
  return { ...a, params: { ...a.params, execution_started_at: at } };
}

export function isExecuting(a: ActionItem): boolean {
  return a.params?.execution_started_at != null && !hasReceipt(a);
}

// Idempotency: record/inspect the platform side-effect receipt in params.
export function hasReceipt(a: ActionItem): boolean {
  return a.params?.execution_receipt != null;
}

export function withReceipt(a: ActionItem, receipt: ExecutionReceipt): ActionItem {
  return { ...a, params: { ...a.params, execution_receipt: receipt } };
}
