// Trigger filter: decides whether an inbound message deserves a relay draft.
// Deterministic — operates only on metadata facts in InboundMessage.
//
//   inbound ──▶ addressed to user? ──no──▶ ignore (not-addressed)
//                   │ yes
//                   ▼
//              from bot/no-reply? ──yes──▶ ignore (bot-or-noreply)
//                   │ no
//                   ▼
//          already handled by user? ──yes──▶ ignore (already-answered)
//                   │ no
//                   ▼
//                 RELAY
//
// A3 — "already handled" = isAlreadyHandled() = EITHER signal is true:
//   threadAnsweredByUserAfter   (user replied in this message's thread after it)
//   userIsLastSenderInChannel   (user is the most recent voice in the conversation)
// Either is sufficient. The second covers DMs (no thread structure) and the
// "user already replied via another client between scan and now" case.

import type { InboundMessage } from "./types.js";

export type FilterDecision =
  | { relay: true }
  | { relay: false; reason: "not-addressed" | "bot-or-noreply" | "already-answered" };

// Default skip patterns for automated senders. Extend per deployment.
const DEFAULT_SKIP_PATTERNS: RegExp[] = [
  /no-?reply@/i,
  /do-?not-?reply@/i,
  /@.*\.bot$/i,
  /-bot$/i,
  /^bot[._-]/i,
  /notifications?@/i,
  /mailer-daemon@/i,
];

export function isAddressedToUser(m: InboundMessage): boolean {
  return (
    m.isDirectMessage ||
    m.mentionsUser ||
    m.isReplyInUserThread ||
    m.recipientsIncludeUser
  );
}

export function isAutomatedSender(
  senderHandle: string,
  skipPatterns: RegExp[] = DEFAULT_SKIP_PATTERNS,
): boolean {
  return skipPatterns.some((re) => re.test(senderHandle));
}

// A3 — true if the user has already engaged with this conversation since this
// inbound: replied in-thread after it (threadAnsweredByUserAfter), OR is the
// most recent sender in the channel/DM (userIsLastSenderInChannel). Either is
// enough to skip. Older payloads omit the second field — treat undefined as
// false.
/**
 * Whether a conversation may still produce a card of this type.
 *
 * evaluateTrigger answers "does this deserve a REPLY draft" — its own first
 * line says so. scan-loop used it as the total gate, which threw away 1,550
 * messages that were never looked at again, purely because the owner had spoken
 * last. That is the richest vein of real to-dos there is: the owner replying is
 * usually the moment they COMMIT to something ("好", "我明天发你", "我去订"),
 * and a confirmed appointment is by definition a thread they answered last. The
 * engine was structurally blind to its owner's own promises, and a missed task
 * leaves no trace — you cannot reject a card that never appeared.
 *
 * So an already-answered thread is now analysed, for everything EXCEPT another
 * reply. This is the deterministic half of that rule; the prompt is told too,
 * but a prompt is not enforcement — re-drafting a reply to a conversation the
 * owner already finished is the most irritating false positive there is, so it
 * is blocked here where it can be tested.
 */
export function mayProduceActionType(m: InboundMessage, actionType: string): boolean {
  if (!isAlreadyHandled(m)) return true;
  return actionType !== "reply" && actionType !== "relay" && actionType !== "forward";
}

export function isAlreadyHandled(m: InboundMessage): boolean {
  return m.threadAnsweredByUserAfter || m.userIsLastSenderInChannel === true;
}

export function evaluateTrigger(
  m: InboundMessage,
  skipPatterns: RegExp[] = DEFAULT_SKIP_PATTERNS,
): FilterDecision {
  if (!isAddressedToUser(m)) return { relay: false, reason: "not-addressed" };
  if (isAutomatedSender(m.senderHandle, skipPatterns))
    return { relay: false, reason: "bot-or-noreply" };
  if (isAlreadyHandled(m)) return { relay: false, reason: "already-answered" };
  return { relay: true };
}

// Maps a filter rejection to an `ignore` action category. In PR 1 filtered
// messages are only debug-logged; PR 2's ignore auto-archive uses this mapping.
export function filterReasonToIgnoreCategory(
  reason: "not-addressed" | "bot-or-noreply" | "already-answered",
): string {
  switch (reason) {
    case "bot-or-noreply":
      return "automated-notification";
    case "not-addressed":
      return "not-addressed";
    case "already-answered":
      return "already-answered";
  }
}
