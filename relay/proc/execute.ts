// Deterministic executor dispatch. The Phase-3 design point (per
// specs/phase3-local-mac.md §1): the cockpit's approve click drives
// these executors; the MODEL never holds send authority. Approve →
// transition → executor, all deterministic and crash-safe.
//
// Per action_type + platform:
//   reply / relay / forward
//     · slack    → chat.postMessage           → receipt {kind:"sent"}
//     · gmail    → drafts.create (DRAFT-ONLY)  → awaitingManual, NO receipt
//                  (CLAUDE.md hard rule: Gmail stays draft-only in v1;
//                   the user presses Send in Gmail; the draft id is recorded)
//     · wechat   → clipboard-manual            → awaitingManual, NO receipt
//   calendar     → conflict-check then events.insert → receipt {kind:"calendar_event"}
//                  (BLOCKS on a conflict — returns conflicts, no event created)
//   task         → TickTick create_task when connected → {kind:"tool_result"}
//                  not connected → local, no external call → {kind:"local"}
//   ignore       → local, no external call    → receipt {kind:"local"}
//
// CRASH-SAFE SEQUENCE (T4):
//   1. if the action already has an execution_receipt → it already happened;
//      return it untouched (idempotent — never double-send).
//   2. if it's "executing" (execution_started_at present, no receipt) → a
//      prior attempt began the side effect and may have completed before a
//      crash. We DO NOT blind-resend; we raise NeedsVerificationError so the
//      caller surfaces "this may have been sent — verify on the platform".
//   3. otherwise: markExecuting (caller persists the durable claim via
//      persistClaim BEFORE the API call) → perform side effect → withReceipt
//      + markExecuted.
//
// I/O is injected (Slack/Gmail/Calendar senders) so this is unit-testable
// with stub clients and no network.

import { loadIdentity } from "../io/identity.js";
import {
  hasReceipt,
  isExecuting,
  markExecuted,
  markExecuting,
  requiresManualExecution,
  withReceipt,
  type ActionItem,
  type ExecutionReceipt,
} from "../core/action-item.js";
import {
  findConflictsForProposed,
  type Conflict,
} from "../core/calendar-conflict.js";
import { buildTickTickTask } from "../core/ticktick.js";
import { zoneOffsetAt } from "../core/when.js";
import { machineTimeZone } from "../io/settings.js";
import type { TaskPlan } from "../core/tasks.js";
import type { CalendarEvent } from "../io/calendar-api.js";
import { randomUUID } from "node:crypto";

// ─── injected platform senders (narrow interfaces, not the full clients) ─

export interface SlackSender {
  postMessage(opts: {
    channel: string;
    text: string;
    threadTs?: string;
  }): Promise<{ ts: string; channel: string }>;
  getPermalink(channel: string, ts: string): Promise<string>;
}

export interface GmailDrafter {
  createDraft(opts: { raw: string; threadId?: string }): Promise<{ id: string }>;
}

export interface CalendarInserter {
  listAllEvents(opts: {
    timeMin: string;
    timeMax: string;
  }): Promise<CalendarEvent[]>;
  insertEvent(opts: {
    event: CalendarEvent;
    sendUpdates?: "all" | "externalOnly" | "none";
    conferenceDataVersion?: number;
  }): Promise<CalendarEvent>;
}

// A connected task-processing MCP tool. Jira is one example; the registry is
// extensible (core/tool-registry.ts). Real MCP clients are NOT wired yet —
// production injects STUB runners that return a synthetic ref, and the
// receipt (kind "tool_result") makes the card terminal + non-restorable.
export interface ToolRunner {
  run(params: Record<string, unknown>): Promise<{ ref: string }>;
}

export interface ExecuteDeps {
  // Slack send target. One workspace in v1.
  slack?: SlackSender;
  // Gmail drafters keyed by mailbox email. The action's target picks one.
  gmail?: Record<string, GmailDrafter>;
  // Calendar inserters keyed by mailbox email.
  calendar?: Record<string, CalendarInserter>;
  // Task-processing MCP tools, keyed by core/tool-registry key (stubbed until
  // each real MCP client lands).
  tools?: Record<string, ToolRunner>;
  // TickTick, the to-do destination for `task` cards. SEPARATE from `tools`
  // on purpose: every registry key gets a STUB runner in production, and a
  // task card routed through a stub would take a tool_result receipt (making
  // it non-restorable) while creating nothing. Present here ONLY when TickTick
  // is really connected; absent → task stays local, exactly as before.
  ticktick?: ToolRunner;
  // The daily plan for a task card's unit, supplying the A/B/C/D tier that
  // becomes the TickTick priority. Injected because plans live in loop-state
  // and this module does no I/O.
  planFor?: (action: ActionItem) => TaskPlan | undefined;
  // Clock. Receipts + execution_started_at use this.
  now: () => string;
  // Called with the markExecuting'd action BEFORE the side effect fires, so
  // the caller can persist the durable "executing" claim. If a crash happens
  // between this and the receipt, retry sees executing-without-receipt and
  // raises NeedsVerificationError rather than re-sending.
  persistClaim?: (claimed: ActionItem) => Promise<void>;
}

// ─── result + errors ─────────────────────────────────────────────────

export interface ExecuteResult {
  // The action after execution: executed (with receipt) for auto-send
  // paths, or still approved (awaitingManual) for draft-only / manual.
  action: ActionItem;
  receipt?: ExecutionReceipt;
  awaitingManual: boolean;
  // For a calendar action blocked by a conflict: the conflicts found.
  // When present, NO event was created and the action stays approved.
  conflicts?: Conflict[];
}

export class NeedsVerificationError extends Error {
  constructor(public action: ActionItem) {
    super(
      `Action ${action.id} is mid-execution (execution_started_at set, no receipt) — ` +
        "verify on the platform before re-executing; do NOT blind-resend.",
    );
    this.name = "NeedsVerificationError";
  }
}

export class ExecutorMisconfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutorMisconfiguredError";
  }
}

// ─── the dispatch ──────────────────────────────────────────────────────

export async function executeAction(
  action: ActionItem,
  deps: ExecuteDeps,
): Promise<ExecuteResult> {
  // 1. Idempotency: already executed.
  if (hasReceipt(action)) {
    return { action, receipt: action.params.execution_receipt as ExecutionReceipt, awaitingManual: false };
  }
  // 2. Mid-execution claim from a prior crashed attempt.
  if (isExecuting(action)) {
    throw new NeedsVerificationError(action);
  }

  // task — the to-do's home is TickTick when it's connected; otherwise it
  // stays local (the pre-TickTick behaviour), so an unconnected install is
  // unchanged.
  if (action.action_type === "task" && deps.ticktick) {
    return executeTickTickTask(action, deps.ticktick, deps);
  }

  // task / ignore — local, no external side effect, no manual leg.
  if (action.action_type === "task" || action.action_type === "ignore") {
    const receipt: ExecutionReceipt = { kind: "local", ref: "local", at: deps.now() };
    return { action: markExecuted(withReceipt(action, receipt)), receipt, awaitingManual: false };
  }

  // calendar — conflict-check, then insert (blocks on conflict).
  if (action.action_type === "calendar") {
    return executeCalendar(action, deps);
  }

  // tool — process the card via a connected MCP tool (jira/notion/…, stubbed).
  if (action.action_type === "tool") {
    return executeTool(action, deps);
  }

  // reply / relay / forward.
  const platform = action.target?.platform;
  if (platform === "slack") {
    return executeSlackSend(action, deps);
  }
  if (platform === "gmail") {
    return executeGmailDraft(action, deps);
  }
  // wechat (or any non-auto-send platform) — manual clipboard leg.
  if (requiresManualExecution(action)) {
    // No external call: the user copies + pastes. Stay approved, awaiting
    // the manual "mark sent". No receipt yet.
    return { action, awaitingManual: true };
  }

  throw new ExecutorMisconfiguredError(
    `Cannot execute ${action.action_type} for platform ${platform ?? "(none)"}`,
  );
}

// ─── per-type implementations ──────────────────────────────────────────

async function executeSlackSend(action: ActionItem, deps: ExecuteDeps): Promise<ExecuteResult> {
  if (!deps.slack) throw new ExecutorMisconfiguredError("no Slack sender configured");
  const draft = action.draft;
  if (typeof draft !== "string" || draft.trim() === "")
    throw new ExecutorMisconfiguredError(`Slack ${action.action_type} has no draft text`);
  // The channel is the source bucket: "slack:<channelId>". The reply
  // recipient for reply = the originating channel/DM. We read it from the
  // action's context permalink-channel or params.channel; fall back to the
  // source-message id prefix.
  const channel = resolveSlackChannel(action);
  if (!channel)
    throw new ExecutorMisconfiguredError(`Slack ${action.action_type} has no resolvable channel`);
  const threadTs = typeof action.params.thread_ts === "string" ? action.params.thread_ts : undefined;

  // Claim before side effect.
  const claimed = markExecuting(action, deps.now());
  await deps.persistClaim?.(claimed);

  const sent = await deps.slack.postMessage({ channel, text: draft, threadTs });
  const permalink = await deps.slack.getPermalink(sent.channel, sent.ts);
  const receipt: ExecutionReceipt = { kind: "sent", ref: permalink, at: deps.now() };
  return { action: markExecuted(withReceipt(claimed, receipt)), receipt, awaitingManual: false };
}

async function executeGmailDraft(action: ActionItem, deps: ExecuteDeps): Promise<ExecuteResult> {
  const mailbox = resolveGmailMailbox(action);
  const drafter = mailbox ? deps.gmail?.[mailbox] : undefined;
  if (!drafter)
    throw new ExecutorMisconfiguredError(
      `no Gmail drafter for mailbox ${mailbox ?? "(unresolved)"}`,
    );
  const raw = typeof action.params.raw_mime === "string" ? action.params.raw_mime : undefined;
  if (!raw)
    throw new ExecutorMisconfiguredError(
      `Gmail ${action.action_type} has no params.raw_mime (build it with buildRawMimeMessage)`,
    );
  const threadId = typeof action.params.thread_id === "string" ? action.params.thread_id : undefined;

  // Gmail is DRAFT-ONLY in v1: create the draft, record its id, but DO NOT
  // mark executed — the user presses Send in Gmail. Stays approved +
  // awaitingManual. We record the draft id in params so the cockpit can
  // deep-link and so a retry doesn't create a second draft.
  const claimed = markExecuting(action, deps.now());
  await deps.persistClaim?.(claimed);

  const draftResult = await drafter.createDraft({ raw, threadId });
  // Record the draft id (not an execution_receipt — the message hasn't been
  // SENT, only drafted). awaitingManual=true; the user marks it sent later,
  // which writes the receipt.
  const withDraftId: ActionItem = {
    ...claimed,
    params: { ...claimed.params, gmail_draft_id: draftResult.id },
  };
  return { action: withDraftId, awaitingManual: true };
}

async function executeCalendar(action: ActionItem, deps: ExecuteDeps): Promise<ExecuteResult> {
  const mailbox = resolveCalendarMailbox(action, Object.keys(deps.calendar ?? {}));
  const inserter = mailbox ? deps.calendar?.[mailbox] : undefined;
  if (!inserter)
    throw new ExecutorMisconfiguredError(
      `no Calendar inserter for mailbox ${mailbox ?? "(unresolved)"}`,
    );
  const event = buildCalendarEvent(action);

  // Conflict check is MANDATORY before create (spec hard rule).
  const window = eventWindowForList(event);
  const existing = await inserter.listAllEvents(window);
  const conflicts = findConflictsForProposed(event, existing);
  if (conflicts.length > 0) {
    // Do NOT create. Surface conflicts; action stays approved so the user
    // can pick another time (the cockpit shows the conflict + suggest-time).
    return { action, awaitingManual: false, conflicts };
  }

  const claimed = markExecuting(action, deps.now());
  await deps.persistClaim?.(claimed);

  const created = await inserter.insertEvent({
    event,
    // conferenceDataVersion:1 is REQUIRED for a Meet createRequest to take effect.
    ...(event.conferenceData ? { conferenceDataVersion: 1 } : {}),
    // Actually email the attendees the invite when there are any (else it just
    // books on Leo's own calendar).
    ...((event.attendees?.length ?? 0) > 0 ? { sendUpdates: "all" as const } : {}),
  });
  const receipt: ExecutionReceipt = {
    kind: "calendar_event",
    ref: created.id ?? created.htmlLink ?? "(created)",
    at: deps.now(),
  };
  return { action: markExecuted(withReceipt(claimed, receipt)), receipt, awaitingManual: false };
}

// A `task` card becomes a real TickTick to-do. Same crash-safe sequence as
// every other external side effect: claim, persist, call, receipt. The receipt
// is `tool_result` (not `local`) because something now exists outside this
// machine — which is also what stops restoreAction from resurrecting the card.
async function executeTickTickTask(
  action: ActionItem,
  runner: ToolRunner,
  deps: ExecuteDeps,
): Promise<ExecuteResult> {
  const payload = buildTickTickTask(action, { plan: deps.planFor?.(action) });

  const claimed = markExecuting(action, deps.now());
  await deps.persistClaim?.(claimed);

  const result = await runner.run(payload as unknown as Record<string, unknown>);
  const receipt: ExecutionReceipt = { kind: "tool_result", ref: result.ref, at: deps.now() };
  return { action: markExecuted(withReceipt(claimed, receipt)), receipt, awaitingManual: false };
}

async function executeTool(action: ActionItem, deps: ExecuteDeps): Promise<ExecuteResult> {
  const toolKey = typeof action.params.tool === "string" ? action.params.tool : "";
  const runner = toolKey ? deps.tools?.[toolKey] : undefined;
  if (!runner) {
    throw new ExecutorMisconfiguredError(`no runner configured for tool "${toolKey || "(none)"}"`);
  }

  // Claim before the external side effect (crash-safe, same as the other executors).
  const claimed = markExecuting(action, deps.now());
  await deps.persistClaim?.(claimed);

  const result = await runner.run(action.params);
  const receipt: ExecutionReceipt = {
    kind: "tool_result",
    ref: result.ref,
    at: deps.now(),
  };
  return { action: markExecuted(withReceipt(claimed, receipt)), receipt, awaitingManual: false };
}

// ─── read-only conflict pre-check (the card's "有无冲突" line) ──────────

// Runs the SAME conflict logic the approve path uses, but never inserts —
// lets the cockpit show a conflict BEFORE the user approves. Deterministic
// given the events list. Errors (list failure, no mailbox) surface to the
// caller as a normal rejection, not a conflict.
export async function checkCalendarConflicts(
  action: ActionItem,
  listEvents: (opts: { timeMin: string; timeMax: string }) => Promise<CalendarEvent[]>,
): Promise<Conflict[]> {
  const event = buildCalendarEvent(action);
  const { timeMin, timeMax } = eventWindowForList(event);
  const existing = await listEvents({ timeMin, timeMax });
  return findConflictsForProposed(event, existing);
}

// ─── target resolution helpers ─────────────────────────────────────────

// The Slack channel to post into. Priority:
//   params.channel (explicit) → source "slack:<channel>" → null.
function resolveSlackChannel(action: ActionItem): string | null {
  if (typeof action.params.channel === "string") return action.params.channel;
  const src = action.source_message_id;
  // ids look like "slack:C0XXXX:1781..." — the channel is the middle slot.
  const m = src.match(/^slack:([^:]+):/);
  if (m) return m[1]!;
  return null;
}

function resolveGmailMailbox(action: ActionItem): string | null {
  if (typeof action.params.mailbox === "string") return action.params.mailbox;
  // The scan loop stores the originating mailbox as the InboundMessage
  // source ("gmail:<email>"); the round-commit copies it onto params.mailbox.
  // No fallback — a draft to the wrong mailbox is a wrong-recipient failure,
  // so we'd rather error than guess.
  return null;
}

// All auto-created calendar events land on ONE account's primary calendar,
// regardless of which source the originating message came from (one calendar for
// everything). An action can still override via params.mailbox.
//
// Read at call time, not module load: the owner's calendar comes from
// config/identity.json, and resolving it lazily means a fresh clone with no
// config doesn't bake in an empty default — and it stays testable without
// importing the module in a particular order.
//
// Fallback when nothing is configured: the only inserter that was wired up. That
// keeps single-account setups (the common case) working before the user has
// written a config, without ever GUESSING between several accounts.
export function resolveCalendarMailbox(action: ActionItem, available?: readonly string[]): string | null {
  if (typeof action.params.mailbox === "string") return action.params.mailbox;
  const configured = loadIdentity().calendarMailbox;
  if (configured) return configured;
  return available && available.length === 1 ? available[0]! : null;
}

// Default reminders for an auto-created event: a popup 1 day before and 30 min
// before. Overridable per-action via params.reminderMinutes (array of minutes).
const DEFAULT_REMINDER_MINUTES = [1440, 30];

function buildCalendarEvent(action: ActionItem): CalendarEvent {
  const p = action.params;
  const reminderMinutes = Array.isArray(p.reminderMinutes)
    ? (p.reminderMinutes as unknown[]).filter((m): m is number => typeof m === "number")
    : DEFAULT_REMINDER_MINUTES;
  const location = typeof p.location === "string" ? p.location : undefined;
  // Attach a Google Meet link for an online meeting — explicit params.online, or
  // (default) any event with no physical location. createRequest → Calendar mints
  // the Meet link on insert (needs conferenceDataVersion:1). online:false opts out.
  const wantsMeet = p.online === true || (p.online !== false && !location);
  return {
    summary: typeof p.title === "string" ? p.title : "(untitled)",
    description: typeof p.description === "string" ? p.description : undefined,
    location,
    ...(wantsMeet
      ? {
          conferenceData: {
            createRequest: {
              requestId: randomUUID(),
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          },
        }
      : {}),
    // Normalized so a bare local datetime can't 400 the insert / conflict-check.
    start: { dateTime: toRfc3339(String(p.start)) },
    end: { dateTime: toRfc3339(String(p.end)) },
    // ONLY real email addresses are valid attendees — Google Calendar rejects the
    // whole insert with HTTP 400 if any attendee isn't an email. The drafter
    // sometimes puts a name-only (WeChat) contact here (e.g. "Gouwa Wang"); drop
    // non-emails (they live in the title/description instead). Empty → omit.
    attendees: Array.isArray(p.attendees)
      ? ((): { email: string }[] | undefined => {
          const emails = (p.attendees as unknown[])
            .filter((e): e is string => typeof e === "string" && /.+@.+\..+/.test(e))
            .map((email) => ({ email }));
          return emails.length > 0 ? emails : undefined;
        })()
      : undefined,
    reminders: {
      useDefault: false,
      overrides: reminderMinutes.map((minutes) => ({ method: "popup" as const, minutes })),
    },
  };
}

// The list window for the conflict check: from the event start to its end,
// padded by nothing (findConflicts uses half-open overlap). Calendar's
// list needs RFC-3339 timeMin/timeMax.
function eventWindowForList(event: CalendarEvent): { timeMin: string; timeMax: string } {
  const timeMin = event.start.dateTime ?? `${event.start.date}T00:00:00Z`;
  const timeMax = event.end.dateTime ?? `${event.end.date}T00:00:00Z`;
  return { timeMin, timeMax };
}

// The zone a bare local datetime is read as, when the drafter emits one without
// an offset. Read from the MACHINE, resolved per call.
//
// This was a hardcoded "+08:00" (the owner was in China when it was written).
// Once he wasn't, every bare datetime was stamped 13 hours off — and an
// approved calendar event at the wrong hour, with the invites already emailed
// to attendees, is the worst failure this product has. A fixed offset is also
// wrong twice a year even in the right country, because it cannot know DST.
//
// machineTimeZone() is what settings.timezone already defaults to, so the two
// agree unless the owner has explicitly declared a different zone; pass `zone`
// to honour that setting from a caller that has it.
function ownerTimeZone(): string {
  return machineTimeZone();
}

// Coerce a loose datetime into RFC-3339 WITH an offset. Google Calendar rejects the
// whole request (HTTP 400) when timeMin/timeMax or start/end lack a zone — the model
// sometimes emits "2026-08-05T09:00:00" or "...T09:00". Adds missing seconds and the
// default offset; passes through anything already carrying Z or ±HH:MM. Non-datetime
// input is returned untouched (the caller's own validation still applies).
export function toRfc3339(value: string, zone: string = ownerTimeZone()): string {
  const s = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?/.test(s)) return s;
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) return s; // already zoned
  const withSeconds = /T\d{2}:\d{2}$/.test(s) ? `${s}:00` : s;
  // Offset for THAT date, so a summer booking made in winter is still right.
  // An unresolvable zone falls back to UTC explicitly rather than to a guessed
  // offset; machineTimeZone() already returns "UTC" when it cannot read one, so
  // this only fires for a bogus zone passed in by a caller.
  const offset = zoneOffsetAt(withSeconds, zone) ?? "Z";
  return `${withSeconds}${offset}`;
}
