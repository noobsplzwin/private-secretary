import { describe, it, expect } from "vitest";
import {
  evaluateTrigger,
  filterReasonToIgnoreCategory,
  isAlreadyHandled,
  mayProduceActionType,
} from "./trigger-filter.js";
import type { InboundMessage } from "./types.js";

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: "m1",
    platform: "slack",
    senderHandle: "alice",
    timestampMs: 1000,
    text: "hello",
    source: "slack:C1",
    isDirectMessage: false,
    mentionsUser: false,
    isReplyInUserThread: false,
    recipientsIncludeUser: false,
    threadAnsweredByUserAfter: false,
    ...overrides,
  };
}

describe("evaluateTrigger", () => {
  it("relays a DM addressed to the user", () => {
    expect(evaluateTrigger(msg({ isDirectMessage: true }))).toEqual({ relay: true });
  });

  it("relays an @mention", () => {
    expect(evaluateTrigger(msg({ mentionsUser: true }))).toEqual({ relay: true });
  });

  it("relays a reply in the user's thread", () => {
    expect(evaluateTrigger(msg({ isReplyInUserThread: true }))).toEqual({ relay: true });
  });

  it("relays an email where the user is a recipient", () => {
    expect(
      evaluateTrigger(msg({ platform: "gmail", recipientsIncludeUser: true })),
    ).toEqual({ relay: true });
  });

  it("ignores a channel firehose message not addressed to the user", () => {
    expect(evaluateTrigger(msg())).toEqual({ relay: false, reason: "not-addressed" });
  });

  it("ignores no-reply / bot senders even when addressed", () => {
    expect(
      evaluateTrigger(msg({ recipientsIncludeUser: true, senderHandle: "no-reply@acme.com" })),
    ).toEqual({ relay: false, reason: "bot-or-noreply" });
    expect(
      evaluateTrigger(msg({ isDirectMessage: true, senderHandle: "deploy-bot" })),
    ).toEqual({ relay: false, reason: "bot-or-noreply" });
  });

  it("ignores a message the user already answered in-thread", () => {
    expect(
      evaluateTrigger(msg({ isDirectMessage: true, threadAnsweredByUserAfter: true })),
    ).toEqual({ relay: false, reason: "already-answered" });
  });

  // A3 — skip-already-handled also covers the broader "user is last voice in
  // the channel" case (DMs and the user-replied-via-another-client case).
  it("A3: skips when user is the last sender in the channel (no thread structure)", () => {
    expect(
      evaluateTrigger(msg({ isDirectMessage: true, userIsLastSenderInChannel: true })),
    ).toEqual({ relay: false, reason: "already-answered" });
  });

  it("A3: skips when EITHER thread-answered OR last-sender-in-channel is true", () => {
    expect(
      evaluateTrigger(
        msg({
          isDirectMessage: true,
          threadAnsweredByUserAfter: true,
          userIsLastSenderInChannel: true,
        }),
      ),
    ).toEqual({ relay: false, reason: "already-answered" });
  });

  it("A3: addressed DM with neither signal still relays — back-compat for older payloads (undefined → false)", () => {
    expect(evaluateTrigger(msg({ isDirectMessage: true }))).toEqual({ relay: true });
  });
});

describe("isAlreadyHandled (A3)", () => {
  it("true when in-thread reply after this message", () => {
    expect(isAlreadyHandled(msg({ threadAnsweredByUserAfter: true }))).toBe(true);
  });

  it("true when user is the last sender in the channel", () => {
    expect(isAlreadyHandled(msg({ userIsLastSenderInChannel: true }))).toBe(true);
  });

  it("false when neither signal is set", () => {
    expect(isAlreadyHandled(msg())).toBe(false);
  });

  it("treats undefined userIsLastSenderInChannel as false (back-compat)", () => {
    const m = msg();
    // explicitly drop the optional field
    delete (m as Partial<InboundMessage>).userIsLastSenderInChannel;
    expect(isAlreadyHandled(m)).toBe(false);
  });
});

describe("filterReasonToIgnoreCategory", () => {
  it("maps every filter reason to an ignore category", () => {
    expect(filterReasonToIgnoreCategory("bot-or-noreply")).toBe("automated-notification");
    expect(filterReasonToIgnoreCategory("not-addressed")).toBe("not-addressed");
    expect(filterReasonToIgnoreCategory("already-answered")).toBe("already-answered");
  });
});

describe("mayProduceActionType — answered threads are mined, not re-replied", () => {
  const answered = (over: Partial<InboundMessage> = {}) =>
    msg({ threadAnsweredByUserAfter: true, ...over });

  // A thread the owner spoke last in is where his own commitments live ("好",
  // "我去订", a confirmed appointment). 1,550 messages were discarded unseen
  // for this reason, and a missed task leaves no trace to reject.
  it("allows task / calendar / tool on a thread the owner answered", () => {
    for (const t of ["task", "calendar", "tool", "ignore"]) {
      expect(mayProduceActionType(answered(), t)).toBe(true);
    }
  });

  // REGRESSION: re-drafting a reply to a conversation the owner already
  // finished is the most irritating false positive there is. The prompt is
  // told, but a prompt is not enforcement.
  it("NEVER allows a reply / relay / forward there", () => {
    for (const t of ["reply", "relay", "forward"]) {
      expect(mayProduceActionType(answered(), t)).toBe(false);
      expect(mayProduceActionType(msg({ userIsLastSenderInChannel: true }), t)).toBe(false);
    }
  });

  it("leaves an unanswered thread completely unrestricted", () => {
    for (const t of ["reply", "relay", "forward", "task", "calendar", "tool"]) {
      expect(mayProduceActionType(msg(), t)).toBe(true);
    }
  });
});
