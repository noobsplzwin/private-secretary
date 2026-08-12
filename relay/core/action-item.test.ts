import { describe, it, expect } from "vitest";
import {
  addComment,
  readComments,
  approveAction,
  isCalendarRedundant,
  redundantPendingCalendarIds,
  hasReceipt,
  InvalidActionTransition,
  markDone,
  markExecuted,
  missingInfo,
  rejectAction,
  restoreAction,
  requiresManualExecution,
  validateActionItem,
  withReceipt,
  type ActionItem,
  type ExecutionReceipt,
} from "./action-item.js";

function item(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    id: "a1",
    source_message_id: "m1",
    action_type: "relay",
    target: { personaKey: "wang-acme", platform: "gmail" },
    reason: "needs customer sign-off",
    confidence: 0.8,
    params: {},
    draft: "王总您好…",
    status: "suggested",
    created_at: "2026-06-10T00:00:00Z",
    ...overrides,
  };
}

describe("validateActionItem", () => {
  it("accepts a structurally valid item and defaults status to suggested", () => {
    const r = validateActionItem({
      source_message_id: "m1",
      action_type: "task",
      reason: "follow up",
      confidence: 0.7,
      params: { title: "ping vendor" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.item.status).toBe("suggested");
  });

  it("rejects unknown action_type, bad confidence, missing reason", () => {
    const r = validateActionItem({
      source_message_id: "m1",
      action_type: "summon",
      reason: "",
      confidence: 1.5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes("action_type"))).toBe(true);
      expect(r.errors.some((e) => e.includes("confidence"))).toBe(true);
      expect(r.errors.some((e) => e.includes("reason"))).toBe(true);
    }
  });

  it("rejects a non-object", () => {
    expect(validateActionItem("nope").ok).toBe(false);
  });

  // Phase 2 T1/T2 — new optional fields accepted and carried through.
  it("accepts and carries task_id + context (T1/T2)", () => {
    const r = validateActionItem({
      source_message_id: "m1",
      action_type: "task",
      reason: "x",
      confidence: 0.5,
      params: { title: "t" },
      task_id: "task-chicago",
      context: { original_message: "hi", attachments: [], evidence_consulted: ["thread:1"] },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.item.task_id).toBe("task-chicago");
      expect(r.item.context?.evidence_consulted).toEqual(["thread:1"]);
    }
  });

  it("accepts and carries project_id; rejects a non-string", () => {
    const ok = validateActionItem({
      source_message_id: "m1", action_type: "task", reason: "x", confidence: 0.5,
      params: { title: "t" }, project_id: "OUS-1",
    });
    expect(ok.ok && ok.item.project_id).toBe("OUS-1");
    const bad = validateActionItem({
      source_message_id: "m1", action_type: "task", reason: "x", confidence: 0.5, project_id: 7,
    });
    expect(bad.ok).toBe(false);
  });

  it("rejects an empty/whitespace task_id and a non-object context", () => {
    expect(validateActionItem({ source_message_id: "m", action_type: "task", reason: "r", confidence: 0.5, task_id: "  " }).ok).toBe(false);
    expect(validateActionItem({ source_message_id: "m", action_type: "task", reason: "r", confidence: 0.5, context: "nope" }).ok).toBe(false);
  });

  // ★ CRITICAL REGRESSION (never delete): an item WITHOUT task_id/context
  // validates to exactly the pre-T1 shape — task_id/context simply absent, no
  // other field changed. Guards the back-compat promise from the eng review.
  it("an item with no task_id/context is byte-identical to the pre-T1 shape (regression)", () => {
    const r = validateActionItem({
      source_message_id: "m1",
      action_type: "task",
      reason: "follow up",
      confidence: 0.7,
      params: { title: "ping" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect("task_id" in r.item).toBe(false);
      expect("context" in r.item).toBe(false);
      expect(r.item).toEqual({
        id: "",
        source_message_id: "m1",
        action_type: "task",
        target: {},
        reason: "follow up",
        confidence: 0.7,
        params: { title: "ping" },
        draft: undefined,
        status: "suggested",
        created_at: "",
      });
    }
  });
});

describe("markExecuting (T4 crash-safe send)", () => {
  it("writes execution_started_at on an approved item; isExecuting true until a receipt lands", async () => {
    const { markExecuting, isExecuting } = await import("./action-item.js");
    const claimed = markExecuting(approveAction(item()), "2026-06-12T00:00:00Z");
    expect(claimed.params.execution_started_at).toBe("2026-06-12T00:00:00Z");
    expect(isExecuting(claimed)).toBe(true);
    // once the receipt is written, it's no longer "executing" (send confirmed)
    const done = withReceipt(claimed, { kind: "sent", ref: "l", at: "2026-06-12T00:01:00Z" });
    expect(isExecuting(done)).toBe(false);
  });

  it("refuses to claim a non-approved item", async () => {
    const { markExecuting } = await import("./action-item.js");
    expect(() => markExecuting(item({ status: "suggested" }), "t")).toThrow(
      InvalidActionTransition,
    );
  });
});

describe("restoreAction (T6 undo)", () => {
  it("rejected → suggested", () => {
    const rej = rejectAction(item());
    expect(restoreAction(rej).status).toBe("suggested");
  });

  it("approved → suggested (un-approve before flush)", () => {
    const appr = approveAction(item());
    expect(restoreAction(appr).status).toBe("suggested");
  });

  it("refuses to restore an item with a real side effect — sent receipt (no double-send)", () => {
    const sent = withReceipt(approveAction(item()), {
      kind: "sent",
      ref: "link",
      at: "2026-06-12T00:00:00Z",
    });
    expect(() => restoreAction(sent)).toThrow(InvalidActionTransition);
  });

  it("refuses to restore an item with a real side effect — calendar_event receipt", () => {
    const booked = withReceipt(markExecuted(item({ action_type: "calendar", status: "approved" })), {
      kind: "calendar_event",
      ref: "evt-1",
      at: "2026-06-12T00:00:00Z",
    });
    expect(() => restoreAction(booked)).toThrow(InvalidActionTransition);
  });

  it("restores an executed item with a LOCAL receipt (auto-done task/ignore — no side effect)", () => {
    const done = withReceipt(markExecuted(approveAction(item({ action_type: "task", params: { title: "t" }, draft: undefined }))), {
      kind: "local",
      ref: "manual-done",
      at: "2026-06-12T00:00:00Z",
    });
    expect(restoreAction(done).status).toBe("suggested");
  });

  it("refuses to restore a suggested item", () => {
    expect(() => restoreAction(item({ status: "suggested" }))).toThrow();
  });

  it("restores a legacy executed item with NO receipt (nothing left the machine)", () => {
    const exec = markExecuted(approveAction(item()));
    expect(restoreAction(exec).status).toBe("suggested");
  });
});

describe("missingInfo", () => {
  it("relay needs recipient persona + platform + draft", () => {
    expect(
      missingInfo(item({ target: {}, draft: undefined })),
    ).toEqual(["target.personaKey", "target.platform", "draft"]);
    expect(missingInfo(item())).toEqual([]);
  });

  it("reply needs NO persona — recipient is the sender (context.sender_handle)", () => {
    // New contact, no persona resolved (personaKey null): still approvable
    // because the reply goes back to the sender we already have.
    const reply = item({
      action_type: "reply",
      target: { platform: "gmail", personaKey: null },
      draft: "Hi Alfredo, thanks…",
      context: { sender_handle: "alfredo@renesas.com" },
    });
    expect(missingInfo(reply)).toEqual([]);
  });

  it("reply flags a missing recipient only when no sender/to/persona at all", () => {
    const reply = item({
      action_type: "reply",
      target: { platform: "gmail" },
      draft: "hi",
      context: {},
      params: {},
    });
    expect(missingInfo(reply)).toEqual(["target.personaKey"]);
  });

  it("calendar needs title/start/end; attendees are optional (own-calendar block)", () => {
    const cal = item({ action_type: "calendar", params: { title: "Sync" }, draft: undefined });
    const missing = missingInfo(cal);
    expect(missing).toContain("params.start");
    expect(missing).toContain("params.end");
    expect(missing).not.toContain("params.title");
    // attendees no longer required — a WeChat-agreed meeting has no emails.
    expect(missing).not.toContain("params.attendees");
  });

  it("calendar with title/start/end is approvable with no attendees", () => {
    const cal = item({
      action_type: "calendar",
      params: { title: "实车测试", start: "2026-06-24T09:30:00+08:00", end: "2026-06-24T11:00:00+08:00" },
      draft: undefined,
    });
    expect(missingInfo(cal)).toEqual([]);
  });

  it("tool needs a tool key + the tool's required params; assignee optional", () => {
    const tool = item({
      action_type: "tool",
      target: { platform: "jira", personaKey: null },
      params: { tool: "jira", project: "BKO" },
      draft: undefined,
    });
    const missing = missingInfo(tool);
    expect(missing).toContain("params.summary");
    expect(missing).toContain("params.description");
    expect(missing).not.toContain("params.project");
    // unassigned is valid — never guessed
    expect(missing).not.toContain("params.assignee");

    // a missing tool key is flagged too
    expect(missingInfo(item({ action_type: "tool", params: {}, draft: undefined }))).toContain(
      "params.tool",
    );

    const complete = item({
      action_type: "tool",
      target: { platform: "jira", personaKey: null },
      params: { tool: "jira", project: "BKO", summary: "Homepage breaks on iOS", description: "Repro in the 2.4 build" },
      draft: undefined,
    });
    expect(missingInfo(complete)).toEqual([]);
  });

  it("tool validation honors a CUSTOM registry (a user-configured tool's required params)", () => {
    const registry = {
      jira: { key: "jira", label: "Jira", requiredParams: ["project"] },
      notion: { key: "notion", label: "Notion", requiredParams: ["title", "content"] },
    };
    const t = item({ action_type: "tool", target: {}, params: { tool: "notion" }, draft: undefined });
    expect(missingInfo(t, registry)).toContain("params.title");
    expect(missingInfo(t, registry)).toContain("params.content");
    expect(
      missingInfo({ ...t, params: { tool: "notion", title: "x", content: "y" } }, registry),
    ).toEqual([]);
  });

  it("task needs title; ignore needs category", () => {
    expect(missingInfo(item({ action_type: "task", params: {} }))).toEqual(["params.title"]);
    expect(missingInfo(item({ action_type: "ignore", params: {} }))).toEqual(["params.category"]);
  });
});

describe("status state machine", () => {
  it("suggested -> approved -> executed", () => {
    const executed = markExecuted(approveAction(item()));
    expect(executed.status).toBe("executed");
  });

  it("suggested -> rejected via skip", () => {
    expect(rejectAction(item()).status).toBe("rejected");
  });

  it("refuses to approve with missing info (no guessing)", () => {
    expect(() => approveAction(item({ draft: undefined }))).toThrow(
      InvalidActionTransition,
    );
  });

  // REGRESSION (mandatory): an executed action cannot run twice. Terminal state.
  it("REGRESSION: no double execute — executed is terminal", () => {
    const executed = markExecuted(approveAction(item()));
    expect(() => approveAction(executed)).toThrow(InvalidActionTransition);
    expect(() => markExecuted(executed)).toThrow(InvalidActionTransition);
    expect(() => rejectAction(executed)).toThrow(InvalidActionTransition);
  });

  it("cannot mark a suggested action executed (must approve first)", () => {
    expect(() => markExecuted(item())).toThrow(InvalidActionTransition);
  });

  it("cannot skip an approved action", () => {
    expect(() => rejectAction(approveAction(item()))).toThrow(InvalidActionTransition);
  });
});

describe("reply executes after approval (human-in-the-loop, not never-send)", () => {
  function reply(overrides: Partial<ActionItem> = {}): ActionItem {
    return item({
      action_type: "reply",
      target: { personaKey: "wang-acme", platform: "gmail" },
      draft: "回复内容",
      ...overrides,
    });
  }

  it("reply: suggested -> approved -> executed (sends after approval)", () => {
    expect(markExecuted(approveAction(reply())).status).toBe("executed");
  });

  it("reply still cannot execute without approval", () => {
    expect(() => markExecuted(reply())).toThrow(InvalidActionTransition);
  });

  it("markDone: a task/ignore reminder ticks straight to executed, no missing-info gate", () => {
    const t = item({ action_type: "task", params: {} }); // no params.title → would block approve
    expect(missingInfo(t)).toContain("params.title");
    expect(markDone(t).status).toBe("executed"); // still marks done
    expect(markDone(item({ action_type: "ignore", params: {} })).status).toBe("executed");
  });

  it("markDone: reply/calendar are NOT eligible (no silent tick)", () => {
    expect(() => markDone(reply())).toThrow(InvalidActionTransition);
    expect(() => markDone(item({ action_type: "calendar" }))).toThrow(InvalidActionTransition);
  });
});

describe("execution receipt (idempotency)", () => {
  const receipt: ExecutionReceipt = {
    kind: "sent",
    ref: "https://slack/msg/123",
    at: "2026-06-11T00:00:00Z",
  };

  it("hasReceipt is false until a receipt is attached", () => {
    expect(hasReceipt(item())).toBe(false);
    expect(hasReceipt(withReceipt(item(), receipt))).toBe(true);
  });

  it("withReceipt preserves other params and does not mutate input", () => {
    const base = item({ params: { foo: "bar" } });
    const after = withReceipt(base, receipt);
    expect(after.params.foo).toBe("bar");
    expect(after.params.execution_receipt).toEqual(receipt);
    expect(base.params.execution_receipt).toBeUndefined(); // input untouched
  });
});

describe("requiresManualExecution", () => {
  it("wechat AND gmail reply/relay/forward are manual (gmail connector is draft-only)", () => {
    expect(requiresManualExecution(item({ target: { personaKey: "x", platform: "wechat" } }))).toBe(true);
    // item() default target platform is gmail → manual (create_draft, user sends)
    expect(requiresManualExecution(item())).toBe(true);
    expect(
      requiresManualExecution(
        item({ action_type: "forward", target: { personaKey: "x", platform: "wechat" }, draft: undefined }),
      ),
    ).toBe(true);
  });

  it("slack sends and non-send types are not manual", () => {
    expect(requiresManualExecution(item({ target: { personaKey: "x", platform: "slack" } }))).toBe(false);
    expect(
      requiresManualExecution(item({ action_type: "calendar", params: {} })),
    ).toBe(false);
  });
});

describe("isCalendarRedundant", () => {
  const booked = item({
    id: "done1",
    action_type: "calendar",
    status: "executed",
    task_id: "t9",
    params: { title: "Q3", start: "2026-08-02T15:00:00+08:00" },
  });
  it("matches an executed calendar by exact start", () => {
    const fresh = item({ id: "f1", action_type: "calendar", params: { title: "Q3", start: "2026-08-02T15:00:00+08:00" } });
    expect(isCalendarRedundant(fresh, [booked])).toBe(true);
  });
  it("matches an executed calendar by task_id", () => {
    const fresh = item({ id: "f2", action_type: "calendar", task_id: "t9", params: { title: "Q3", start: "2026-08-03T15:00:00+08:00" } });
    expect(isCalendarRedundant(fresh, [booked])).toBe(true);
  });
  it("does NOT match a different start, a non-executed calendar, or a non-calendar action", () => {
    const other = item({ id: "f3", action_type: "calendar", params: { title: "Q3", start: "2026-08-04T15:00:00+08:00" } });
    expect(isCalendarRedundant(other, [booked])).toBe(false);
    expect(isCalendarRedundant(other, [item({ ...booked, status: "suggested" })])).toBe(false);
    expect(isCalendarRedundant(item({ id: "f4", action_type: "task" }), [booked])).toBe(false);
  });
});

describe("isCalendarRedundant — pending duplicates", () => {
  const cal = (over: Record<string, unknown> = {}) =>
    ({
      id: "x",
      action_type: "calendar",
      status: "suggested",
      params: { start: "2026-08-13T22:00:00Z", end: "2026-08-13T23:00:00Z" },
      task_id: "t1",
      ...over,
    }) as never;

  // REGRESSION: refresh re-emits a calendar card every TTL, and those cards are
  // exempt from supersede, so with only an executed-check one meeting grew a
  // new duplicate every ten minutes. Six cards for one Thursday meeting.
  it("treats a pending card for the same slot as redundant", () => {
    expect(isCalendarRedundant(cal({ id: "new" }), [cal({ id: "old" })])).toBe(true);
  });

  // The meeting moving is a real change the user must see.
  it("lets a pending card through when the start moved", () => {
    const moved = cal({ id: "new", params: { start: "2026-08-13T21:00:00Z" } });
    expect(isCalendarRedundant(moved, [cal({ id: "old" })])).toBe(false);
  });

  // Same task, different slot, already on the calendar: still a re-booking.
  it("keeps blocking a re-book of an executed event by task", () => {
    const other = cal({ id: "new", params: { start: "2026-08-14T09:00:00Z" } });
    expect(isCalendarRedundant(other, [cal({ id: "done", status: "executed" })])).toBe(true);
  });

  it("ignores cards the user already acted on", () => {
    expect(isCalendarRedundant(cal({ id: "new" }), [cal({ id: "skipped", status: "rejected" })])).toBe(false);
  });
});

describe("redundantPendingCalendarIds — cleaning up what already accumulated", () => {
  const cal = (id: string, over: Record<string, unknown> = {}) =>
    ({
      id,
      action_type: "calendar",
      status: "suggested",
      created_at: `2026-08-10T0${id.slice(-1)}:00:00Z`,
      source_message_id: "slack:D1:1",
      task_id: "t1",
      params: { start: "2026-08-13T22:00:00Z" },
      context: { sender_handle: "U1" },
      ...over,
    }) as never;

  // The state observed on a real machine: one card per refresh tick.
  it("keeps only the newest card for a slot", () => {
    const drop = redundantPendingCalendarIds([cal("c1"), cal("c2"), cal("c3")]);
    expect(drop.sort()).toEqual(["c1", "c2"]);
  });

  it("leaves a single card alone", () => {
    expect(redundantPendingCalendarIds([cal("c1")])).toEqual([]);
  });

  // Reversed after seeing real data: grouping by time preserved three
  // timezone mistakes as three "reschedules". The newest read wins instead.
  it("keeps only the newest when the same task has several times", () => {
    const moved = cal("c2", { params: { start: "2026-08-13T21:00:00Z" } });
    expect(redundantPendingCalendarIds([cal("c1"), moved])).toEqual(["c1"]);
  });

  // Anything the user acted on is their decision, not ours to tidy.
  it("never touches approved, executed or rejected cards", () => {
    const drop = redundantPendingCalendarIds([
      cal("c1", { status: "approved" }),
      cal("c2", { status: "executed" }),
      cal("c3", { status: "rejected" }),
      cal("c4"),
    ]);
    expect(drop).toEqual([]);
  });

  // A half-baked card with no time is still a pending calendar card for the
  // task, and the newest one supersedes it.
  it("collapses cards with no start too", () => {
    const noStart = (id: string) => cal(id, { params: {} });
    expect(redundantPendingCalendarIds([noStart("c1"), noStart("c2")])).toEqual(["c1"]);
  });

  it("does not merge different conversations that share a slot", () => {
    const other = cal("c2", { task_id: "t2" });
    expect(redundantPendingCalendarIds([cal("c1"), other])).toEqual([]);
  });
});

describe("start times compare as instants, not strings", () => {
  const cal = (id: string, start: string, over: Record<string, unknown> = {}) =>
    ({
      id,
      action_type: "calendar",
      status: "suggested",
      created_at: `2026-08-10T0${id.slice(-1)}:00:00Z`,
      source_message_id: "slack:D1:1",
      task_id: "t1",
      params: { start },
      context: { sender_handle: "U1" },
      ...over,
    }) as never;

  // Observed on a real machine: consecutive refreshes wrote the SAME moment in
  // different offsets, and a string compare read them as two bookings.
  it("collapses the same moment written in different offsets", () => {
    const a = cal("c1", "2026-08-13T22:00:00+08:00"); // 14:00Z
    const b = cal("c2", "2026-08-13T15:00:00+01:00"); // 14:00Z
    expect(isCalendarRedundant(b, [a])).toBe(true);
    expect(redundantPendingCalendarIds([a, b])).toEqual(["c1"]);
  });

  // isCalendarRedundant still lets a genuinely different moment through — a
  // reschedule must be able to ARRIVE. The sweep then keeps only the newest.
  it("lets a different moment arrive, then keeps only the newest", () => {
    const a = cal("c1", "2026-08-13T15:00:00+01:00"); // 14:00Z
    const b = cal("c2", "2026-08-13T15:00:00Z"); // 15:00Z
    expect(isCalendarRedundant(b, [a])).toBe(false);
    expect(redundantPendingCalendarIds([a, b])).toEqual(["c1"]);
  });

  // The sweep groups by task, so an unreadable time is no escape hatch — but
  // isCalendarRedundant still refuses to call two unparseable times equal,
  // because it has no instant to compare.
  it("never claims two unreadable times are the same instant", () => {
    const a = cal("c1", "next Thursday");
    const b = cal("c2", "next Thursday");
    expect(isCalendarRedundant(b, [a])).toBe(false);
  });
});

describe("normalizeCalendarTimes — the model stops doing timezone maths", () => {
  const raw = (params: Record<string, unknown>) => ({
    source_message_id: "slack:D1:1",
    action_type: "calendar",
    reason: "r",
    confidence: 0.9,
    params,
  });

  // The meeting that exposed this: "3pm Portugal time" arrived as four
  // different instants across refreshes. Now the model reports what it read.
  it("converts a wall time plus zone into an instant", () => {
    const r = validateActionItem(raw({ start: "2026-08-13T15:00", tz: "Europe/Lisbon" }));
    expect(r.ok && r.item.params.start).toBe("2026-08-13T14:00:00.000Z");
  });

  it("converts end as well as start", () => {
    const r = validateActionItem(
      raw({ start: "2026-08-13T15:00", end: "2026-08-13T16:00", tz: "Europe/Lisbon" }),
    );
    expect(r.ok && r.item.params.end).toBe("2026-08-13T15:00:00.000Z");
  });

  // Two refreshes wording the same meeting differently now agree, which is
  // what stops them stacking up as separate cards.
  it("makes two spellings of the same meeting identical", () => {
    const a = validateActionItem(raw({ start: "2026-08-13T15:00", tz: "Europe/Lisbon" }));
    const b = validateActionItem(raw({ start: "2026-08-13T22:00", tz: "Asia/Shanghai" }));
    expect(a.ok && b.ok && a.item.params.start).toBe(b.ok ? b.item.params.start : "");
  });

  // Guessing a zone is how the wrong hour gets booked.
  it("leaves a wall time alone when no zone was given", () => {
    const r = validateActionItem(raw({ start: "2026-08-13T15:00" }));
    expect(r.ok && r.item.params.start).toBe("2026-08-13T15:00");
  });

  it("ignores an invented zone rather than trusting it", () => {
    const r = validateActionItem(raw({ start: "2026-08-13T15:00", tz: "Portugal time" }));
    expect(r.ok && r.item.params.start).toBe("2026-08-13T15:00");
  });

  it("passes through a value that already carries an offset", () => {
    const r = validateActionItem(raw({ start: "2026-08-13T14:00:00Z", tz: "Europe/Lisbon" }));
    expect(r.ok && r.item.params.start).toBe("2026-08-13T14:00:00.000Z");
  });

  it("does not touch non-calendar cards", () => {
    const r = validateActionItem({ ...raw({ start: "2026-08-13T15:00", tz: "Europe/Lisbon" }), action_type: "task" });
    expect(r.ok && r.item.params.start).toBe("2026-08-13T15:00");
  });
});

describe("addComment — feedback without a decision", () => {
  const card = (over: Partial<ActionItem> = {}): ActionItem => ({
    id: "a1",
    source_message_id: "slack:C1:1",
    action_type: "task",
    target: {},
    reason: "r",
    confidence: 0.9,
    params: { title: "t" },
    status: "suggested",
    created_at: "2026-08-12T00:00:00Z",
    ...over,
  });

  // THE point: leaving feedback used to require skipping, which recorded a
  // rejection for cards the owner had actually praised.
  it("never changes status", () => {
    for (const status of ["suggested", "approved", "executed", "rejected"] as const) {
      const out = addComment(card({ status }), "looks right", "2026-08-12T01:00:00Z");
      expect(out.status).toBe(status);
    }
  });

  // Appending is what removes the restore → re-skip loop used to revise a note.
  it("appends instead of replacing", () => {
    const one = addComment(card(), "first", "2026-08-12T01:00:00Z");
    const two = addComment(one, "second", "2026-08-12T02:00:00Z");
    expect(readComments(two)).toEqual([
      { at: "2026-08-12T01:00:00Z", text: "first" },
      { at: "2026-08-12T02:00:00Z", text: "second" },
    ]);
  });

  it("trims and refuses an empty comment", () => {
    expect(readComments(addComment(card(), "  padded  ", "t"))[0]!.text).toBe("padded");
    expect(() => addComment(card(), "   ", "t")).toThrow(/empty/);
  });

  it("keeps the rest of params intact", () => {
    const out = addComment(card({ params: { title: "t", start: "x" } }), "c", "t");
    expect(out.params.title).toBe("t");
    expect(out.params.start).toBe("x");
  });

  it("readComments ignores malformed rows rather than throwing", () => {
    const messy = card({ params: { comments: [{ text: "ok", at: "t" }, "junk", { text: 5 }] } });
    expect(readComments(messy)).toEqual([{ text: "ok", at: "t" }]);
  });
});
