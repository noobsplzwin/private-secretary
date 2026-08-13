import { describe, expect, it } from "vitest";
import { buildTaskPayload, deadlineFor, shouldSync, wallClockLabel, type TaskUnit } from "./ticktick-plan.js";
import type { ActionItem } from "./action-item.js";
import type { TaskPlan } from "./tasks.js";

const member = (over: Partial<ActionItem> = {}): ActionItem => ({
  id: "a1",
  source_message_id: "slack:C1:1",
  action_type: "task",
  target: {},
  reason: "r",
  confidence: 0.9,
  params: { title: "订机票" },
  status: "suggested",
  created_at: "2026-08-12T00:00:00Z",
  ...over,
});

const plan = (over: Partial<TaskPlan> = {}): TaskPlan => ({
  tier: "A",
  rank: 0,
  why: "下周就要走",
  at: "2026-08-12T00:00:00Z",
  ...over,
});

const unit = (over: Partial<TaskUnit> = {}): TaskUnit => ({
  unitKey: "t1",
  title: "香港出差",
  grouped: true,
  plan: plan(),
  members: [member()],
  ...over,
});

describe("shouldSync — keeps the list short", () => {
  it("syncs a grouped task", () => {
    expect(shouldSync(unit())).toBe(true);
  });

  it("drops D-tier as noise", () => {
    expect(shouldSync(unit({ plan: plan({ tier: "D" }) }))).toBe(false);
  });

  // The 20-40 row list the owner does not want comes from surfacing every
  // unconsolidated message as its own to-do. Only a top-tier loner gets in.
  it("drops an ungrouped card unless it is A-tier", () => {
    expect(shouldSync(unit({ grouped: false, plan: plan({ tier: "B" }) }))).toBe(false);
    expect(shouldSync(unit({ grouped: false, plan: plan({ tier: "A" }) }))).toBe(true);
  });

  it("drops a task whose members are all finished", () => {
    expect(shouldSync(unit({ members: [member({ status: "executed" })] }))).toBe(false);
  });
});

describe("buildTaskPayload — the task IS the unit", () => {
  it("makes one task with its steps as a checklist", () => {
    const built = buildTaskPayload(
      unit({
        members: [
          member({ id: "m1", params: { title: "订机票" } }),
          member({ id: "m2", params: { title: "订宾馆" } }),
        ],
      }),
    );
    expect(built.payload.title).toBe("香港出差");
    expect(built.payload.kind).toBe("CHECKLIST");
    expect(built.payload.items?.map((i) => i.title)).toEqual(["订机票", "订宾馆"]);
    expect(built.payload.priority).toBe(5); // tier A
  });

  it("puts why + entities in the description, without the deadline entity", () => {
    const built = buildTaskPayload(
      unit({
        plan: plan({
          entities: [
            { kind: "price", label: "机票", value: "¥3,200" },
            { kind: "deadline", label: "截止", value: "2026-08-20" },
          ],
        }),
      }),
    );
    expect(built.payload.desc).toContain("下周就要走");
    expect(built.payload.desc).toContain("机票: ¥3,200");
    expect(built.payload.desc).not.toContain("截止"); // it becomes the due date
  });

  // The member's own line is a SUMMARY and its next_actions are the same thing
  // spelled out. Emitting both listed one job twice ("跟进…发货与运单号" then
  // "向温总确认是否已寄出"), so the summary yields to the steps.
  it("drops the member's summary line when its steps replace it", () => {
    const built = buildTaskPayload(
      unit({ members: [member({ next_actions: ["查签证要求", " ", "收拾行李"] })] }),
    );
    expect(built.payload.items?.map((i) => i.title)).toEqual(["查签证要求", "收拾行李"]);
  });

  it("keeps the member line when there are no steps to replace it", () => {
    const built = buildTaskPayload(unit({ members: [member({ next_actions: [] })] }));
    expect(built.payload.items?.map((i) => i.title)).toEqual(["订机票"]);
  });

  // An executable line IS the action, not a description of it, so it survives
  // alongside its steps — dropping it would remove the only tickable thing.
  it("keeps an executable line even when the member has steps", () => {
    const built = buildTaskPayload(
      unit({
        members: [
          member({
            id: "cal1",
            action_type: "calendar",
            params: { title: "评审", start: "2026-08-20T09:00:00-05:00", attendees: ["k@x.com"] },
            next_actions: ["提前发议程"],
          }),
        ],
      }),
    );
    expect(built.payload.items).toHaveLength(2);
    expect(built.payload.items![0]!.title).toContain("k@x.com");
    expect(built.executable).toEqual([{ sortOrder: 0, actionId: "cal1" }]);
  });

  it("skips members that already finished", () => {
    const built = buildTaskPayload(
      unit({ members: [member({ id: "m1", status: "executed" }), member({ id: "m2", params: { title: "订宾馆" } })] }),
    );
    expect(built.payload.items?.map((i) => i.title)).toEqual(["订宾馆"]);
  });
});

describe("buildTaskPayload — executable lines", () => {
  const cal = (attendees: unknown) =>
    member({
      id: "cal1",
      action_type: "calendar",
      params: { title: "产品评审", start: "2026-08-20T09:00:00-05:00", attendees },
    });

  it("an event WITH attendees becomes a tickable invite naming the addresses", () => {
    const built = buildTaskPayload(unit({ members: [cal(["kevin@acme.com", "sara@x.io"])] }));
    const line = built.payload.items![0]!.title;
    expect(line).toContain("kevin@acme.com");
    expect(line).toContain("sara@x.io");
    expect(line).toContain("8/20 09:00");
    expect(built.executable).toEqual([{ sortOrder: 0, actionId: "cal1" }]);
  });

  // Attendee-less events are auto-created (spec §2), so they are not a step.
  it("an attendee-less event produces no line at all", () => {
    const built = buildTaskPayload(unit({ members: [cal([])] }));
    expect(built.payload.items ?? []).toHaveLength(0);
    expect(built.executable).toEqual([]);
  });

  // REGRESSION: ASK-not-GUESS. An unresolved name must never sit behind a
  // tickable send.
  it("an unresolved attendee degrades to a NON-executable warning", () => {
    const built = buildTaskPayload(unit({ members: [cal(["Gouwa Wang", "real@x.com"])] }));
    expect(built.payload.items![0]!.title).toContain("无法解析");
    expect(built.payload.items![0]!.title).toContain("Gouwa Wang");
    expect(built.executable).toEqual([]);
  });

  it("a tool action is tickable and shows destination + assignee", () => {
    const built = buildTaskPayload(
      unit({
        members: [
          member({
            id: "j1",
            action_type: "tool",
            params: { tool: "Jira", project: "OUS", summary: "修 HDMI", assignee: "kevin@acme.com" },
          }),
        ],
      }),
    );
    expect(built.payload.items![0]!.title).toContain("OUS");
    expect(built.payload.items![0]!.title).toContain("kevin@acme.com");
    expect(built.executable).toEqual([{ sortOrder: 0, actionId: "j1" }]);
  });

  it("a reply is listed but NOT executable", () => {
    const built = buildTaskPayload(
      unit({ members: [member({ id: "r1", action_type: "reply", headline: "回复报价" })] }),
    );
    expect(built.payload.items![0]!.title).toContain("回复报价");
    expect(built.payload.items![0]!.title).toContain("cockpit");
    expect(built.executable).toEqual([]);
  });
});

describe("due dates are never invented", () => {
  it("has no due date when the task has no real deadline", () => {
    const built = buildTaskPayload(unit());
    expect(built.payload).not.toHaveProperty("dueDate");
  });

  it("uses a real deadline entity", () => {
    const built = buildTaskPayload(
      unit({ plan: plan({ entities: [{ kind: "deadline", label: "交付", value: "2026-08-20" }] }) }),
    );
    expect(built.payload.dueDate).toBe("2026-08-20");
    expect(built.payload.isAllDay).toBe(true);
  });

  it("falls back to the earliest dated calendar member", () => {
    const u = unit({
      members: [
        member({ id: "c2", action_type: "calendar", params: { start: "2026-09-01T10:00:00-05:00", attendees: [] } }),
        member({ id: "c1", action_type: "calendar", params: { start: "2026-08-20T09:00:00-05:00", attendees: [] } }),
      ],
    });
    expect(deadlineFor(u)).toBe("2026-08-20T09:00:00-05:00");
  });
});

describe("wallClockLabel", () => {
  // The string carries its own offset, so the literal fields ARE the local
  // time — no conversion, nothing to get wrong.
  it("reads the literal wall clock, whatever the offset", () => {
    expect(wallClockLabel("2026-08-20T09:00:00-05:00")).toBe("8/20 09:00");
    expect(wallClockLabel("2026-08-20T09:00:00+08:00")).toBe("8/20 09:00");
  });

  it("returns null for something that is not a datetime", () => {
    expect(wallClockLabel("next week")).toBeNull();
  });
});

describe("attendees after draft-time resolution", () => {
  // Names now become addresses at draft time; whatever could not be resolved is
  // parked in params.attendees_unresolved. ASK-not-GUESS still holds: an
  // unresolved name must not sit behind a tickable send.
  it("a resolved invite is tickable and names the addresses", () => {
    const built = buildTaskPayload(
      unit({
        members: [
          member({
            id: "cal1",
            action_type: "calendar",
            params: {
              title: "评审",
              start: "2026-08-20T09:00:00-05:00",
              attendees: ["michael@taiv.tv", "zech@taiv.tv"],
            },
          }),
        ],
      }),
    );
    expect(built.payload.items![0]!.title).toContain("michael@taiv.tv");
    expect(built.executable).toEqual([{ sortOrder: 0, actionId: "cal1" }]);
  });

  it("an unresolved name in attendees_unresolved blocks the tickable line", () => {
    const built = buildTaskPayload(
      unit({
        members: [
          member({
            id: "cal1",
            action_type: "calendar",
            params: {
              title: "评审",
              start: "2026-08-20T09:00:00-05:00",
              attendees: ["michael@taiv.tv"],
              attendees_unresolved: ["Gouwa Wang"],
            },
          }),
        ],
      }),
    );
    expect(built.payload.items![0]!.title).toContain("无法解析");
    expect(built.payload.items![0]!.title).toContain("Gouwa Wang");
    expect(built.executable).toEqual([]);
  });
});
