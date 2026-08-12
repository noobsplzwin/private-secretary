import { _resetIdentity, _setIdentityForTest } from "../io/identity.js";
import { describe, it, expect, vi } from "vitest";
import {
  executeAction,
  toRfc3339,
  ExecutorMisconfiguredError,
  NeedsVerificationError,
  type CalendarInserter,
  type ExecuteDeps,
  type GmailDrafter,
  type SlackSender,
} from "./execute.js";
import type { ActionItem } from "../core/action-item.js";
import type { CalendarEvent } from "../io/calendar-api.js";

const NOW = "2026-06-14T12:00:00.000Z";

function action(over: Partial<ActionItem> = {}): ActionItem {
  return {
    id: "a1",
    source_message_id: "slack:C123:1781000000.0001",
    action_type: "reply",
    target: { platform: "slack", personaKey: "michael-dobosz" },
    reason: "r",
    confidence: 0.95,
    params: {},
    draft: "hello there",
    status: "approved",
    created_at: "2026-06-14T00:00:00Z",
    ...over,
  };
}

function deps(over: Partial<ExecuteDeps> = {}): ExecuteDeps {
  return { now: () => NOW, ...over };
}

describe("executeAction — idempotency + crash safety", () => {
  it("already-has-receipt → returns untouched, no side effect", async () => {
    const slack: SlackSender = {
      postMessage: vi.fn(),
      getPermalink: vi.fn(),
    };
    const a = action({
      status: "executed",
      params: { execution_receipt: { kind: "sent", ref: "https://x", at: NOW } },
    });
    const r = await executeAction(a, deps({ slack }));
    expect(r.receipt?.ref).toBe("https://x");
    expect(slack.postMessage).not.toHaveBeenCalled();
  });

  it("executing-without-receipt → NeedsVerificationError, never blind-resends", async () => {
    const slack: SlackSender = { postMessage: vi.fn(), getPermalink: vi.fn() };
    const a = action({ params: { execution_started_at: "2026-06-14T11:59:00Z" } });
    await expect(executeAction(a, deps({ slack }))).rejects.toBeInstanceOf(
      NeedsVerificationError,
    );
    expect(slack.postMessage).not.toHaveBeenCalled();
  });
});

describe("executeAction — Slack send", () => {
  it("posts message, builds permalink receipt, marks executed", async () => {
    const slack: SlackSender = {
      postMessage: vi.fn(async () => ({ ts: "1781000123.0009", channel: "C123" })),
      getPermalink: vi.fn(async () => "https://taiv.slack.com/archives/C123/p17810001230009"),
    };
    const claims: ActionItem[] = [];
    const r = await executeAction(
      action(),
      deps({ slack, persistClaim: async (c) => void claims.push(c) }),
    );
    // claim persisted BEFORE the side effect (crash-safe ordering)
    expect(claims).toHaveLength(1);
    expect(claims[0]!.params.execution_started_at).toBe(NOW);
    // posted to the channel parsed from the source id
    expect(slack.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      text: "hello there",
      threadTs: undefined,
    });
    expect(r.action.status).toBe("executed");
    expect(r.receipt).toEqual({
      kind: "sent",
      ref: "https://taiv.slack.com/archives/C123/p17810001230009",
      at: NOW,
    });
    expect(r.awaitingManual).toBe(false);
  });

  it("uses params.channel + params.thread_ts when present (thread reply)", async () => {
    const slack: SlackSender = {
      postMessage: vi.fn(async () => ({ ts: "1.0", channel: "D999" })),
      getPermalink: vi.fn(async () => "link"),
    };
    await executeAction(
      action({ params: { channel: "D999", thread_ts: "1780.0001" } }),
      deps({ slack }),
    );
    expect(slack.postMessage).toHaveBeenCalledWith({
      channel: "D999",
      text: "hello there",
      threadTs: "1780.0001",
    });
  });

  it("throws when no draft text", async () => {
    const slack: SlackSender = { postMessage: vi.fn(), getPermalink: vi.fn() };
    await expect(
      executeAction(action({ draft: "" }), deps({ slack })),
    ).rejects.toBeInstanceOf(ExecutorMisconfiguredError);
  });

  it("throws when no Slack sender configured", async () => {
    await expect(executeAction(action(), deps({}))).rejects.toBeInstanceOf(
      ExecutorMisconfiguredError,
    );
  });
});

describe("executeAction — Gmail draft-only", () => {
  it("creates a draft, records draft id, stays awaitingManual (no receipt)", async () => {
    const drafter: GmailDrafter = {
      createDraft: vi.fn(async () => ({ id: "DRAFT-1" })),
    };
    const a = action({
      action_type: "reply",
      target: { platform: "gmail", personaKey: "tony-fai" },
      params: { mailbox: "leo@taiv.tv", raw_mime: "encoded", thread_id: "T1" },
    });
    const r = await executeAction(a, deps({ gmail: { "leo@taiv.tv": drafter } }));
    expect(drafter.createDraft).toHaveBeenCalledWith({ raw: "encoded", threadId: "T1" });
    expect(r.awaitingManual).toBe(true);
    expect(r.receipt).toBeUndefined();
    expect(r.action.status).toBe("approved"); // NOT executed — user sends in Gmail
    expect(r.action.params.gmail_draft_id).toBe("DRAFT-1");
  });

  it("throws when mailbox can't be resolved (wrong-recipient guard)", async () => {
    const a = action({
      target: { platform: "gmail" },
      params: { raw_mime: "x" }, // no mailbox
    });
    await expect(
      executeAction(a, deps({ gmail: { "leo@taiv.tv": { createDraft: vi.fn() } } })),
    ).rejects.toBeInstanceOf(ExecutorMisconfiguredError);
  });
});

describe("executeAction — WeChat manual", () => {
  it("non-auto-send platform → awaitingManual, no external call, no receipt", async () => {
    const a = action({
      target: { platform: "wechat", personaKey: "wang-acme" },
    });
    const r = await executeAction(a, deps({}));
    expect(r.awaitingManual).toBe(true);
    expect(r.receipt).toBeUndefined();
    expect(r.action.status).toBe("approved");
  });
});

describe("executeAction — calendar with conflict check", () => {
  const calBase = {
    action_type: "calendar" as const,
    target: { platform: "gmail" as const },
    draft: undefined,
    params: {
      mailbox: "leo@taiv.tv",
      title: "Sync with Michael",
      start: "2026-06-15T20:00:00Z",
      end: "2026-06-15T21:00:00Z",
      attendees: ["michael@taiv.tv"],
    },
  };

  it("no conflict → inserts event, marks executed with calendar_event receipt", async () => {
    const inserter: CalendarInserter = {
      listAllEvents: vi.fn(async () => []),
      insertEvent: vi.fn(async () => ({ id: "EVT-1", start: {}, end: {} }) as CalendarEvent),
    };
    const r = await executeAction(
      action(calBase),
      deps({ calendar: { "leo@taiv.tv": inserter } }),
    );
    expect(inserter.insertEvent).toHaveBeenCalled();
    expect(r.action.status).toBe("executed");
    expect(r.receipt).toEqual({ kind: "calendar_event", ref: "EVT-1", at: NOW });
  });

  it("drops non-email attendees (name-only WeChat contact) so Calendar doesn't 400", async () => {
    const inserter: CalendarInserter = {
      listAllEvents: vi.fn(async () => []),
      insertEvent: vi.fn(async () => ({ id: "EVT-A", start: {}, end: {} }) as CalendarEvent),
    };
    const withName = { ...calBase, params: { ...calBase.params, attendees: ["Gouwa Wang", "real@x.com"] } };
    await executeAction(action(withName), deps({ calendar: { "leo@taiv.tv": inserter } }));
    const ev = (inserter.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0]![0].event as CalendarEvent;
    expect(ev.attendees).toEqual([{ email: "real@x.com" }]); // "Gouwa Wang" dropped
  });

  it("online meeting (no location) → attaches a Meet createRequest + inserts with conferenceDataVersion 1", async () => {
    let passed: { event: CalendarEvent; conferenceDataVersion?: number } | undefined;
    const inserter: CalendarInserter = {
      listAllEvents: vi.fn(async () => []),
      insertEvent: vi.fn(async (o: { event: CalendarEvent; conferenceDataVersion?: number }) => {
        passed = o;
        return { id: "EVT-M", start: {}, end: {} } as CalendarEvent;
      }),
    };
    const online = { ...calBase, params: { ...calBase.params, attendees: [] } }; // no location
    await executeAction(action(online), deps({ calendar: { "leo@taiv.tv": inserter } }));
    expect((passed!.event.conferenceData as { createRequest?: unknown }).createRequest).toBeTruthy();
    expect(passed!.conferenceDataVersion).toBe(1);
  });

  it("in-person meeting (has location) → no Meet link", async () => {
    let ev: CalendarEvent | undefined;
    const inserter: CalendarInserter = {
      listAllEvents: vi.fn(async () => []),
      insertEvent: vi.fn(async (o: { event: CalendarEvent }) => { ev = o.event; return { id: "EVT-L", start: {}, end: {} } as CalendarEvent; }),
    };
    const located = { ...calBase, params: { ...calBase.params, attendees: [], location: "高青路站2号口" } };
    await executeAction(action(located), deps({ calendar: { "leo@taiv.tv": inserter } }));
    expect(ev!.conferenceData).toBeUndefined();
  });

  it("all-name attendees → attendees omitted entirely (not an empty/invalid list)", async () => {
    const inserter: CalendarInserter = {
      listAllEvents: vi.fn(async () => []),
      insertEvent: vi.fn(async () => ({ id: "EVT-B", start: {}, end: {} }) as CalendarEvent),
    };
    const allNames = { ...calBase, params: { ...calBase.params, attendees: ["Gouwa Wang", "陈古龙"] } };
    await executeAction(action(allNames), deps({ calendar: { "leo@taiv.tv": inserter } }));
    const ev = (inserter.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0]![0].event as CalendarEvent;
    expect(ev.attendees).toBeUndefined();
  });

  // Asserts the BEHAVIOUR (no params.mailbox → routes to the single wired
  // account) rather than one person's address. The old version hard-coded the
  // owner's email, so it failed on any clone without an identity config — the
  // colleague's very first `npm test`.
  it("no mailbox in params → routes to the configured/only calendar + sets reminders", async () => {
    const inserter: CalendarInserter = {
      listAllEvents: vi.fn(async () => []),
      insertEvent: vi.fn(async () => ({ id: "EVT-2", start: {}, end: {} }) as CalendarEvent),
    };
    const noMailbox = {
      ...calBase,
      params: { title: calBase.params.title, start: calBase.params.start, end: calBase.params.end },
    };
    // Pin the identity so this passes identically on a configured machine and on
    // a fresh clone.
    _setIdentityForTest({ primaryEmail: "owner@example.com", calendarMailbox: "owner@example.com" });
    let r;
    try {
      r = await executeAction(
        action(noMailbox),
        deps({ calendar: { "owner@example.com": inserter } }),
      );
    } finally {
      _resetIdentity();
    }
    expect(inserter.insertEvent).toHaveBeenCalled();
    expect(r.action.status).toBe("executed");
    const event = (inserter.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0]![0].event as CalendarEvent;
    expect(event.reminders?.useDefault).toBe(false);
    expect(event.reminders?.overrides?.map((o) => o.minutes)).toEqual([1440, 30]);
  });

  it("conflict → does NOT insert, returns conflicts, action stays approved", async () => {
    const conflicting: CalendarEvent = {
      summary: "Existing standup",
      start: { dateTime: "2026-06-15T20:30:00Z" },
      end: { dateTime: "2026-06-15T21:30:00Z" },
    };
    const inserter: CalendarInserter = {
      listAllEvents: vi.fn(async () => [conflicting]),
      insertEvent: vi.fn(),
    };
    const r = await executeAction(
      action(calBase),
      deps({ calendar: { "leo@taiv.tv": inserter } }),
    );
    expect(inserter.insertEvent).not.toHaveBeenCalled();
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts?.[0]?.event.summary).toBe("Existing standup");
    expect(r.action.status).toBe("approved");
  });
});

describe("executeAction — local types", () => {
  it("task → executed with local receipt, no deps needed", async () => {
    const r = await executeAction(
      action({ action_type: "task", target: {}, draft: undefined, params: { title: "follow up" } }),
      deps({}),
    );
    expect(r.receipt).toEqual({ kind: "local", ref: "local", at: NOW });
    expect(r.action.status).toBe("executed");
  });

  it("ignore → executed with local receipt", async () => {
    const r = await executeAction(
      action({ action_type: "ignore", target: {}, draft: undefined, params: { category: "newsletter" } }),
      deps({}),
    );
    expect(r.receipt?.kind).toBe("local");
    expect(r.action.status).toBe("executed");
  });
});

describe("executeAction — task → TickTick", () => {
  const taskAction = (over: Partial<ActionItem> = {}) =>
    action({
      action_type: "task",
      target: {},
      draft: undefined,
      params: { title: "Send the SoW" },
      ...over,
    });

  it("creates the TickTick to-do and takes a tool_result receipt", async () => {
    const run = vi.fn().mockResolvedValue({ ref: "ticktick:6a7c" });
    const r = await executeAction(taskAction(), deps({ ticktick: { run } }));
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0]).toMatchObject({ title: "Send the SoW", kind: "TEXT" });
    expect(r.receipt).toEqual({ kind: "tool_result", ref: "ticktick:6a7c", at: NOW });
    expect(r.action.status).toBe("executed");
  });

  it("passes the plan tier through as the TickTick priority", async () => {
    const run = vi.fn().mockResolvedValue({ ref: "ticktick:1" });
    await executeAction(
      taskAction(),
      deps({
        ticktick: { run },
        planFor: () => ({ tier: "A", rank: 0, why: "client blocked", at: NOW }),
      }),
    );
    expect(run.mock.calls[0]![0]).toMatchObject({ priority: 5 });
  });

  // REGRESSION: TickTick is optional. Without it a task must keep its old
  // local receipt — a `tool_result` would also make the card non-restorable.
  it("stays local when TickTick is not connected", async () => {
    const r = await executeAction(taskAction(), deps({}));
    expect(r.receipt).toEqual({ kind: "local", ref: "local", at: NOW });
  });

  // The claim must be persisted BEFORE the external call, same as every other
  // side effect, so a crash mid-create cannot double-create.
  it("persists the executing claim before calling TickTick", async () => {
    const order: string[] = [];
    const run = vi.fn().mockImplementation(async () => {
      order.push("create");
      return { ref: "ticktick:1" };
    });
    await executeAction(
      taskAction(),
      deps({
        ticktick: { run },
        persistClaim: async () => {
          order.push("claim");
        },
      }),
    );
    expect(order).toEqual(["claim", "create"]);
  });

  it("does not touch TickTick for an ignore card", async () => {
    const run = vi.fn();
    const r = await executeAction(
      action({ action_type: "ignore", target: {}, draft: undefined, params: { category: "newsletter" } }),
      deps({ ticktick: { run } }),
    );
    expect(run).not.toHaveBeenCalled();
    expect(r.receipt?.kind).toBe("local");
  });
});

describe("executeAction — tool (connected MCP, stubbed runner)", () => {
  it("dispatches to the tool's runner and marks executed with a tool_result receipt", async () => {
    const run = vi.fn(async () => ({ ref: "BKO-123" }));
    const r = await executeAction(
      action({
        action_type: "tool",
        target: { platform: "jira", personaKey: null },
        params: {
          tool: "jira",
          project: "BKO",
          summary: "Homepage breaks on iOS",
          description: "Repro in the 2.4 build",
          assignee: "leo",
        },
        draft: undefined,
      }),
      deps({ tools: { jira: { run } } }),
    );
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "jira",
        project: "BKO",
        summary: "Homepage breaks on iOS",
        assignee: "leo",
      }),
    );
    expect(r.receipt).toEqual({ kind: "tool_result", ref: "BKO-123", at: NOW });
    expect(r.action.status).toBe("executed");
    expect(r.awaitingManual).toBe(false);
  });

  it("errors clearly when no runner is configured for the selected tool", async () => {
    await expect(
      executeAction(
        action({
          action_type: "tool",
          target: { platform: "jira", personaKey: null },
          params: { tool: "jira", project: "BKO", summary: "x", description: "y" },
          draft: undefined,
        }),
        deps({}),
      ),
    ).rejects.toThrow(/no runner configured for tool "jira"/);
  });

  it("errors when the card has no tool key at all", async () => {
    await expect(
      executeAction(
        action({ action_type: "tool", target: {}, params: {}, draft: undefined }),
        deps({ tools: { jira: { run: async () => ({ ref: "X-1" }) } } }),
      ),
    ).rejects.toThrow(/no runner configured for tool "\(none\)"/);
  });
});

describe("toRfc3339 — datetime normalization (Calendar HTTP 400 guard)", () => {
  it("adds the default offset to a bare local datetime", () => {
    expect(toRfc3339("2026-08-05T09:00:00")).toBe("2026-08-05T09:00:00+08:00");
  });
  it("adds missing seconds too", () => {
    expect(toRfc3339("2026-08-05T09:00")).toBe("2026-08-05T09:00:00+08:00");
  });
  it("passes through an already-zoned value (offset or Z)", () => {
    expect(toRfc3339("2026-07-13T16:00:00+08:00")).toBe("2026-07-13T16:00:00+08:00");
    expect(toRfc3339("2026-07-13T08:00:00Z")).toBe("2026-07-13T08:00:00Z");
  });
  it("leaves non-datetime input untouched", () => {
    expect(toRfc3339("not a date")).toBe("not a date");
  });
});
