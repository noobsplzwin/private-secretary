// Ticking a checklist item in TickTick as an approval. Pure core: no I/O.
//
// TickTick has TWO executable exits (specs/ticktick-migration.md §1): sending
// the invites for a calendar event that has attendees, and creating a tool
// item such as a Jira ticket. Everything else there is inert.
//
// The line is drawn by two tests, and a tickable action must pass BOTH:
//
//   1. Does the material content fit in ONE LINE? A checklist item has no
//      description field, so whatever the line does not say, the owner cannot
//      see before ticking.
//   2. Is a mistake CORRECTABLE afterwards?
//
// A Jira ticket passes mainly on (2) — its body does not fit in a line, but a
// wrong ticket can be edited or deleted. A calendar invite passes mainly on
// (1) — who and when fit, and a wrong one can at least be updated or cancelled.
// A reply fails both: its wording does not fit in a line, and a sent message
// cannot be unsent. That is why reply / relay / forward keep their cockpit
// approval — not because they matter more.
//
// Whatever the action, the line must name WHO it reaches, by resolved address
// rather than display name. Wrong-recipient is this product's worst failure and
// "invite Kevin" is not reviewable while "kevin.chen@acme.com" is.

/** A recipient that resolved to a real address. Unresolved names never reach
 *  here — see the label builders' contract. */
export interface ResolvedAttendee {
  email: string;
  displayName?: string;
}

// Prefixes mark a line as one that reaches outside this machine, so a human
// scanning the list can tell it from a note to self.
export const INVITE_PREFIX = "📧 发送邀请：";
export const TOOL_PREFIX = "🎫 创建：";

/**
 * The checklist line for "send the invites".
 *
 * Contract: `attendees` are RESOLVED addresses only. A caller holding an
 * unresolved name must not call this — it emits buildUnresolvedLabel instead
 * (ASK-not-GUESS), because an unresolved name behind a tickable send is exactly
 * the wrong-recipient failure.
 *
 * `whenLabel` is the event's own local wall time, already formatted, so the
 * owner reads the time they agreed rather than a UTC instant.
 */
export function buildInviteLabel(opts: {
  attendees: readonly ResolvedAttendee[];
  whenLabel: string;
  title?: string;
}): string {
  if (opts.attendees.length === 0) {
    throw new Error("ticktick: invite label needs at least one resolved attendee");
  }
  const who = opts.attendees.map((a) => a.email).join(", ");
  const what = opts.title?.trim() ? ` · ${opts.title.trim()}` : "";
  return `${INVITE_PREFIX}${who} · ${opts.whenLabel}${what}`;
}

/**
 * The checklist line for a tool action (Jira and anything else in the tool
 * registry).
 *
 * The ticket BODY deliberately does not appear — it does not fit, and it is the
 * part a mistake in is cheapest to fix. What must appear is the destination and
 * the assignee, because those are the parts that reach a person and the parts
 * that are awkward to correct after the fact.
 *
 * `assignee` follows the same rule as attendees: a resolved address, or omitted.
 * core/jira-assignee.ts already refuses to guess one.
 */
export function buildToolLabel(opts: {
  tool: string;
  summary: string;
  destination?: string; // e.g. the Jira project key
  assignee?: string; // resolved address; omitted when unassigned
}): string {
  const parts = [opts.tool, opts.destination, opts.summary.trim()].filter(
    (p): p is string => typeof p === "string" && p.trim() !== "",
  );
  const who = opts.assignee ? ` · 指派 ${opts.assignee}` : "";
  return `${TOOL_PREFIX}${parts.join(" · ")}${who}`;
}

/** The "me" item used when a name could not be resolved to an address. */
export function buildUnresolvedLabel(names: readonly string[]): string {
  return `⚠️ 无法解析收件人，需手动确认：${names.join("、")}`;
}

/** True when this checklist line is one of the executable kinds. */
export function isExecutableItem(title: string): boolean {
  return title.startsWith(INVITE_PREFIX) || title.startsWith(TOOL_PREFIX);
}

// ─── deciding what fires ─────────────────────────────────────────────

/** A checklist item as TickTick reports it. */
export interface RemoteChecklistItem {
  id: string;
  status: number; // 0 open, 1 ticked
}

/** The item→action link recorded when the task was written. */
export interface TrackedApproval {
  itemId: string;
  actionId: string;
}

/**
 * Which action ids the owner has just approved by ticking.
 *
 * Idempotency is the whole job. The daemon re-polls every cycle, so a ticked
 * item reads as ticked forever; without `alreadyExecuted` the invites would go
 * out again on every poll. Un-ticking is deliberately NOT a signal: unchecking
 * a box cannot un-email anyone, so treating it as a cancel would be a lie, and
 * treating it as a re-arm would let one item fire twice.
 */
export function approvedActionIds(
  remote: readonly RemoteChecklistItem[],
  tracked: readonly TrackedApproval[],
  alreadyExecuted: ReadonlySet<string>,
): string[] {
  const ticked = new Set(remote.filter((i) => i.status === 1).map((i) => i.id));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tracked) {
    if (!ticked.has(t.itemId)) continue;
    if (alreadyExecuted.has(t.actionId)) continue;
    if (seen.has(t.actionId)) continue; // two items pointing at one action
    seen.add(t.actionId);
    out.push(t.actionId);
  }
  return out;
}
