// The durable inbox between FETCHING and ANALYSING messages. Pure core.
//
// WHY THIS EXISTS: one tick used to do everything — poll a source, draft cards
// with the LLM, sync TickTick, assess people — and every source shared one
// serial queue. A slow `claude -p` call (420s ceiling, three retries on a
// person pass) held every OTHER source's polling behind it: on 2026-10-01 one
// Gmail tick took 1069s, and Gmail sat unread for most of an hour while WeChat
// drafted. 「收信和分析分开排队」 (owner, 2026-10-01).
//
// The split needs somewhere for a fetched message to WAIT, and that place has
// to be durable, because the old design lost messages three separate ways:
//
//   - Slack/Gmail marks were committed BEFORE drafting, so a draft failure
//     marked the messages seen and nothing ever looked at them again;
//   - messages over maxDraftCandidates were counted as `draftSkipped` and
//     dropped the same way;
//   - a draft commit that lost the lock logged 「will re-draft next tick」, but
//     the cursor had moved, so it never did.
//
// With the inbox, a fetch persists the message FIRST and only then advances its
// cursor, and the analyser removes a message only in the same locked commit
// that writes its cards. A failure leaves it here to be retried.

import type { InboundMessage } from "./types.js";

export interface InboxEntry {
  msg: InboundMessage;
  /** When the fetch lane enqueued it (ISO). */
  at: string;
  /** Draft attempts that FAILED. A success removes the entry instead. */
  attempts: number;
}

/**
 * How many entries the inbox may hold. Normally it drains every cycle; this
 * bounds the damage if the drafter is down for days. Overflow drops the OLDEST
 * and says so — never silently.
 */
export const MAX_INBOX = 300;

/**
 * Failed attempts after which a message is given up on. A message that breaks
 * the drafter every time must not occupy the head of the queue forever — the
 * same reason the person pass gives up after three (proc/persona-update.ts).
 */
export const MAX_DRAFT_ATTEMPTS = 3;

/** Add freshly fetched messages. A message already waiting is not added twice. */
export function enqueue(
  inbox: readonly InboxEntry[],
  msgs: readonly InboundMessage[],
  nowIso: string,
  cap: number = MAX_INBOX,
): { inbox: InboxEntry[]; overflow: InboxEntry[] } {
  const have = new Set(inbox.map((e) => e.msg.id));
  const next = [...inbox];
  for (const m of msgs) {
    if (have.has(m.id)) continue;
    have.add(m.id);
    next.push({ msg: m, at: nowIso, attempts: 0 });
  }
  const overflow = next.length > cap ? next.splice(0, next.length - cap) : [];
  return { inbox: next, overflow };
}

/**
 * What the analyser takes this cycle: the newest `max` messages, the same
 * preference the old cap had. The rest stay queued for the next cycle — that is
 * the difference from before, when they were dropped.
 */
export function takeForDraft(inbox: readonly InboxEntry[], max?: number): InboundMessage[] {
  const all = inbox.map((e) => e.msg);
  if (max === undefined || all.length <= max) return all;
  return [...all].sort((a, b) => b.timestampMs - a.timestampMs).slice(0, max);
}

/**
 * Is this the LLM being UNAVAILABLE — logged out, refused, out of credit —
 * rather than this one call going wrong? Such a failure says nothing about the
 * message or the contact, so it must not count toward giving up on either.
 * 2026-10-02 → 10-04 the CLI's OAuth session expired; every call failed with
 * 「Failed to authenticate: OAuth session expired」, each failure was counted,
 * and dozens of messages and contacts were given up on as unreadable.
 */
export function isLlmUnavailable(error: string | undefined): boolean {
  return !!error && LLM_UNAVAILABLE.test(error);
}
const LLM_UNAVAILABLE =
  /failed to authenticate|oauth session expired|could not be refreshed|invalid (?:x-)?api.?key|api error: 40[13]\b|credit balance is too low|not logged in|please run \/login/i;

/**
 * Settle the messages a draft call was given.
 *
 *   drafted OK                 → removed
 *   its sender's call failed   → stays, attempts + 1
 *   the WHOLE call failed      → every attempted message stays, attempts + 1
 *   attempts reach the limit   → removed and returned in `gaveUp`, to be logged
 *
 * Entries the call was not given (over the cap, or enqueued while it ran) are
 * untouched. Matching is by message id against the FRESH inbox read under the
 * lock, so a concurrent enqueue is never lost.
 */
export function settle(
  inbox: readonly InboxEntry[],
  attempted: readonly InboundMessage[],
  failedSenders: ReadonlySet<string>,
  wholeCallFailed: boolean,
  maxAttempts: number = MAX_DRAFT_ATTEMPTS,
): { inbox: InboxEntry[]; gaveUp: InboxEntry[] } {
  const tried = new Set(attempted.map((m) => m.id));
  const next: InboxEntry[] = [];
  const gaveUp: InboxEntry[] = [];
  for (const e of inbox) {
    if (!tried.has(e.msg.id)) {
      next.push(e);
      continue;
    }
    const failed = wholeCallFailed || failedSenders.has(e.msg.senderHandle);
    if (!failed) continue; // drafted — its cards are committed in the same write
    const bumped = { ...e, attempts: e.attempts + 1 };
    if (bumped.attempts >= maxAttempts) gaveUp.push(bumped);
    else next.push(bumped);
  }
  return { inbox: next, gaveUp };
}
