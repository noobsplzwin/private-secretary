import { describe, expect, it } from "vitest";
import { dueFields, buildTaskPayload, deadlineFor, shouldRenderCardUnit, isExecutableAction, wallClockLabel, type TaskUnit } from "./ticktick-plan.js";
import type { ActionItem } from "./action-item.js";

// The owner's real zone; the fixtures' -05:00 is its summer offset, so the
// wall-clock labels below read the same either way.
const ZONE = "America/Winnipeg";

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


const unit = (over: Partial<TaskUnit> = {}): TaskUnit => ({
  unitKey: "t1",
  title: "香港出差",
  grouped: true,
  members: [member()],
  ...over,
});

// The LEDGER is the list now; a card unit renders only when it is EXECUTABLE
// (tickable invite/tool line) or PERSONA-LESS (work no ledger can carry). The
// old A/B tier gate died with the ranking pass.
describe("shouldRenderCardUnit", () => {
  const NOW = Date.parse("2026-08-13T12:00:00-05:00");
  const noPersona = () => true;
  const hasPersona = () => false;

  const invite = () =>
    member({
      action_type: "calendar",
      params: { start: "2026-08-20T14:00:00-05:00", attendees: ["zech@taiv.tv"] },
    });

  it("renders an executable unit from a persona sender", () => {
    expect(shouldRenderCardUnit(unit({ members: [invite()] }), hasPersona, NOW)).toBe(true);
  });

  it("renders a persona-less task unit", () => {
    expect(shouldRenderCardUnit(unit({ members: [member({ action_type: "task" })] }), noPersona, NOW)).toBe(true);
  });

  // Persona senders' plain work belongs to the LEDGER: rendering the card too
  // would put the same to-do on the list twice, from two sources.
  it("drops a persona sender's plain task card — the ledger owns it", () => {
    expect(shouldRenderCardUnit(unit({ members: [member({ action_type: "task" })] }), hasPersona, NOW)).toBe(false);
  });

  // An EVENT that already happened is over. This is what made a site visit
  // agreed two weeks earlier reappear at the top of the list every week.
  const at = (iso: string) => member({ action_type: "calendar", params: { start: iso } });

  it("drops a unit whose only live members are events that already happened", () => {
    expect(shouldRenderCardUnit(unit({ members: [at("2026-08-06T14:00:00-05:00")] }), noPersona, NOW)).toBe(false);
  });

  it("keeps an event still to come, and one from earlier today", () => {
    expect(shouldRenderCardUnit(unit({ members: [at("2026-08-20T14:00:00-05:00")] }), noPersona, NOW)).toBe(true);
    // Within the day of grace: params.start is a wall clock whose zone lives in
    // params.tz, so same-day parsing is only accurate to within a day.
    expect(shouldRenderCardUnit(unit({ members: [at("2026-08-13T09:00:00-05:00")] }), noPersona, NOW)).toBe(true);
  });

  it("drops a unit whose members are all finished", () => {
    expect(shouldRenderCardUnit(unit({ members: [member({ status: "executed" })] }), noPersona, NOW)).toBe(false);
  });
});

// Mirrors lineFor's actionId branches: the lines whose tick executes.
describe("isExecutableAction", () => {
  it("calendar with every attendee resolved is executable", () => {
    expect(isExecutableAction(member({ action_type: "calendar", params: { attendees: ["a@x.com"] } }))).toBe(true);
  });
  it("ASK-not-GUESS: an unresolved attendee kills executability", () => {
    expect(
      isExecutableAction(member({ action_type: "calendar", params: { attendees: ["a@x.com"], attendees_unresolved: ["王工"] } })),
    ).toBe(false);
  });
  it("attendee-less calendar is auto-created, not a step", () => {
    expect(isExecutableAction(member({ action_type: "calendar", params: {} }))).toBe(false);
  });
  it("tool cards are executable", () => {
    expect(isExecutableAction(member({ action_type: "tool", params: {} }))).toBe(true);
  });
});

// Notes live in `content` for a TEXT task and `desc` for a CHECKLIST one.
// A TEXT task carries its note in `content`, a CHECKLIST one in `desc`, and the
// builder always sends BOTH (the inactive one as ""), so `??` would stop at the
// empty string. Take whichever actually has text.
const noteOf = (p: { content?: string; desc?: string }): string =>
  [p.content, p.desc].find((v) => typeof v === "string" && v !== "") ?? "";

describe("buildTaskPayload — the task IS the unit", () => {
  it("makes one task with its steps as a checklist", () => {
    const built = buildTaskPayload(
      unit({
        members: [
          member({ id: "m1", params: { title: "订机票" } }),
          member({ id: "m2", params: { title: "订宾馆" } }),
        ],
      }), ZONE);
    expect(built.payload.title).toBe("香港出差");
    expect(built.payload.kind).toBe("CHECKLIST");
    expect(built.payload.items?.map((i) => i.title)).toEqual(["订机票", "订宾馆"]);
    // Fixed medium since the ranking pass retired: card rows are executable/
    // persona-less only, and dates (never flags) drive the Today view.
    expect(built.payload.priority).toBe(3);

  });


  // The member's own line is a SUMMARY and its next_actions are the same thing
  // spelled out. Emitting both listed one job twice ("跟进…发货与运单号" then
  // "向温总确认是否已寄出"), so the summary yields to the steps.
  it("drops the member's summary line when its steps replace it", () => {
    const built = buildTaskPayload(
      unit({ members: [member({ next_actions: ["查签证要求", " ", "收拾行李"] })] }), ZONE);
    expect(built.payload.items?.map((i) => i.title)).toEqual(["查签证要求", "收拾行李"]);
  });

  it("keeps the member line when there are no steps to replace it", () => {
    const built = buildTaskPayload(unit({ members: [member({ next_actions: [] })] }), ZONE);
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
      }), ZONE);
    expect(built.payload.items).toHaveLength(2);
    expect(built.payload.items![0]!.title).toContain("k@x.com");
    expect(built.executable).toEqual([{ sortOrder: 0, actionId: "cal1" }]);
  });

  it("skips members that already finished", () => {
    const built = buildTaskPayload(
      unit({ members: [member({ id: "m1", status: "executed" }), member({ id: "m2", params: { title: "订宾馆" } })] }), ZONE);
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
    const built = buildTaskPayload(unit({ members: [cal(["kevin@acme.com", "sara@x.io"])] }), ZONE);
    const line = built.payload.items![0]!.title;
    expect(line).toContain("kevin@acme.com");
    expect(line).toContain("sara@x.io");
    expect(line).toContain("8/20 09:00");
    expect(built.executable).toEqual([{ sortOrder: 0, actionId: "cal1" }]);
  });

  // Attendee-less events are auto-created (spec §2), so they are not a step.
  it("an attendee-less event produces no line at all", () => {
    const built = buildTaskPayload(unit({ members: [cal([])] }), ZONE);
    expect(built.payload.items ?? []).toHaveLength(0);
    expect(built.executable).toEqual([]);
  });

  // REGRESSION: ASK-not-GUESS. An unresolved name must never sit behind a
  // tickable send.
  it("an unresolved attendee degrades to a NON-executable warning", () => {
    const built = buildTaskPayload(unit({ members: [cal(["Gouwa Wang", "real@x.com"])] }), ZONE);
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
      }), ZONE);
    expect(built.payload.items![0]!.title).toContain("OUS");
    expect(built.payload.items![0]!.title).toContain("kevin@acme.com");
    expect(built.executable).toEqual([{ sortOrder: 0, actionId: "j1" }]);
  });

  // reply/relay/forward are retired from production (owner, 2026-08-14) — a
  // legacy card still in state renders nothing; the owed answer arrives as a
  // fresh `task` from the passes instead.
  it("a legacy reply card renders no line at all", () => {
    const built = buildTaskPayload(
      unit({ members: [member({ id: "r1", action_type: "reply", headline: "回复报价", next_actions: ["不该出现"] })] }), ZONE);
    expect(built.payload.items ?? []).toEqual([]);
    expect(built.executable).toEqual([]);
  });
});

describe("due dates are never invented", () => {
  it("has no due date when the task has no real deadline", () => {
    const built = buildTaskPayload(unit(), ZONE);
    expect(built.payload).not.toHaveProperty("dueDate");
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

describe("stale fields and dropped steps", () => {
  // REGRESSION: lineFor returns null for an attendee-less calendar card (it is
  // auto-created, so it is not a step Leo performs). The loop used to `continue`
  // on that, throwing away the card's next_actions with it — a real task went
  // from five checklist items to none while TickTick kept displaying the old five.
  it("keeps the steps of a calendar card that has no summary line", () => {
    const built = buildTaskPayload(
      unit({
        members: [
          member({
            action_type: "calendar",
            params: { title: "rollout 计划会", start: "2026-08-13T15:00:00-05:00", attendees: [] },
            next_actions: ["确认 franklin/amlogic 用同一 init 文件", "催 Ezra 授权仓库访问"],
          }),
        ],
      }),
      ZONE,
    );
    expect(built.payload.items?.map((i) => i.title)).toEqual([
      "确认 franklin/amlogic 用同一 init 文件",
      "催 Ezra 授权仓库访问",
    ]);
  });

  it("contributes nothing for an ignore card", () => {
    const built = buildTaskPayload(
      unit({
        members: [member({ action_type: "ignore", next_actions: ["不该出现"] })],
      }),
      ZONE,
    );
    expect(built.payload.items ?? []).toEqual([]);
  });

  // REGRESSION: update_task is a PARTIAL patch, so an omitted field keeps
  // whatever TickTick already has. A task ended up with a TEXT-round `content`
  // and a CHECKLIST-round `desc` at once, plus a five-item checklist our payload
  // said was empty — and the hash gate called it "in sync".
  it("always sends both note fields and items", () => {
    const checklist = buildTaskPayload(
      unit({ members: [member({ next_actions: ["一步"] })] }),
      ZONE,
    ).payload;
    expect(checklist.kind).toBe("CHECKLIST");
    expect(checklist.content).toBe("");
    expect(checklist.items).toHaveLength(1);

    const text = buildTaskPayload(
      unit({ members: [member({ action_type: "ignore" })] }),
      ZONE,
    ).payload;
    expect(text.kind).toBe("TEXT");
    expect(text.desc).toBe("");
    expect(text.items).toEqual([]);
  });
});

describe("wallClockLabel", () => {
  // With no zone to convert into, the literal fields are all there is.
  it("reads the literal wall clock when given no zone", () => {
    expect(wallClockLabel("2026-08-20T09:00:00-05:00")).toBe("8/20 09:00");
    expect(wallClockLabel("2026-08-20T09:00:00+08:00")).toBe("8/20 09:00");
  });

  // REGRESSION, from a real card: a 15:00 Lisbon call came back as
  // "2026-08-13T22:00:00+08:00" — the right instant, a China offset. Reading the
  // literal fields put "8/13 22:00" on the checklist for a 09:00 call.
  it("converts a foreign offset into the owner's zone", () => {
    expect(wallClockLabel("2026-08-13T22:00:00+08:00", ZONE)).toBe("8/13 09:00");
    expect(wallClockLabel("2026-08-20T14:00:00Z", ZONE)).toBe("8/20 09:00");
  });

  // Same wall clock, already in the owner's zone → unchanged.
  it("leaves a datetime already in the owner's zone alone", () => {
    expect(wallClockLabel("2026-08-20T09:00:00-05:00", ZONE)).toBe("8/20 09:00");
  });

  it("returns null for something that is not a datetime", () => {
    expect(wallClockLabel("next week")).toBeNull();
  });
});

describe("dueFields", () => {
  // REGRESSION: create_task declares dueDate as format: date-time, so a bare
  // date is a validation error. It becomes local midnight, all-day.
  it("expands a bare date to local midnight, all-day", () => {
    expect(dueFields("2026-08-20", ZONE)).toEqual({
      dueDate: "2026-08-20T00:00:00-05:00",
      isAllDay: true,
    });
  });

  it("keeps a datetime's own offset", () => {
    expect(dueFields("2026-08-20T09:00:00-05:00", ZONE)).toEqual({
      dueDate: "2026-08-20T09:00:00-05:00",
      isAllDay: false,
    });
  });

  it("stamps the owner's offset on an unzoned datetime", () => {
    expect(dueFields("2026-08-20 09:00", ZONE)).toEqual({
      dueDate: "2026-08-20T09:00:00-05:00",
      isAllDay: false,
    });
  });

  // REGRESSION, the value that broke the create: a free-text deadline.
  it("refuses anything that is not entirely a date or datetime", () => {
    expect(dueFields("2026-08-13 15:00 Portugal time", ZONE)).toBeNull();
    expect(dueFields("next Thursday", ZONE)).toBeNull();
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
      }), ZONE);
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
      }), ZONE);
    expect(built.payload.items![0]!.title).toContain("无法解析");
    expect(built.payload.items![0]!.title).toContain("Gouwa Wang");
    expect(built.executable).toEqual([]);
  });
});

describe("unverified names surface in the notes", () => {
  // The steps below may tell the owner to contact that person, so the warning
  // goes at the TOP of the notes rather than being left implicit.
  it("names them, deduped across members", () => {
    const built = buildTaskPayload(
      unit({
        members: [
          member({ id: "m1", params: { title: "t", unverified_names: ["Fabian"] } }),
          member({ id: "m2", params: { title: "t2", unverified_names: ["Fabian", "Rajat"] } }),
        ],
      }), ZONE);
    const note = built.payload.desc ?? built.payload.content ?? "";
    expect(note).toContain("姓名未核实");
    expect(note.match(/Fabian/g)).toHaveLength(1);
    expect(note).toContain("Rajat");
    expect(note.startsWith("⚠️")).toBe(true); // first thing read
  });

  it("says nothing when every name checked out", () => {
    const note = buildTaskPayload(unit(), ZONE).payload.desc ?? buildTaskPayload(unit(), ZONE).payload.content ?? "";
    expect(note).not.toContain("姓名未核实");
  });
});

// OWNER 2026-09-09: 「你是应该在ticktick创建一个一键创建ticket的待办，让我review
// 一下你准备创建的ticket」. The tick IS the approval, so whatever the row does
// not show, he approves blind.
//
// Both of that day's real tickets went wrong in exactly the part the row hides:
// TAIV-7049 needed its description cut in half, TAIV-7050 went out assigned to
// the wrong engineer. Neither is visible in 「🎫 创建：jira · Taiv Firmware · …」.
//
// The module header argues the body is omitted because a wrong body is cheap to
// fix. Cheap to fix is not the test. The test is whether he can review it.
describe("a tickable ticket must be reviewable before it is ticked", () => {
  const ticket = (over: Record<string, unknown> = {}) =>
    unit({
      title: "File ticket: Memfault offline log collection",
      members: [
        member({
          id: "j1",
          action_type: "tool",
          params: {
            tool: "jira",
            project: "TAIV",
            summary: "Investigate offline log collection on the box",
            assignee: "ihor@taiv.tv",
            description:
              "Screen health is the top priority and we are short on logs.\n\n" +
              "Save periodically to /data: logcat filtered, tombstones, tcpdump, dumpsys.\n\n" +
              "Hard constraint: must not burn through eMMC.",
            ...over,
          },
        }),
      ],
    });

  it("shows the drafted body in the note, not only the destination", () => {
    const note = noteOf(buildTaskPayload(ticket(), ZONE).payload);
    expect(note).toContain("tcpdump");
    expect(note).toContain("eMMC");
  });

  it("shows the assignee in the note too, not only on the tick line", () => {
    // TAIV-7050 shipped to the wrong person. The name must be readable where
    // the body is read, not only in a one-line label that scrolls.
    expect(noteOf(buildTaskPayload(ticket(), ZONE).payload)).toContain("ihor@taiv.tv");
  });

  it("names the destination project in the note", () => {
    expect(noteOf(buildTaskPayload(ticket(), ZONE).payload)).toContain("TAIV");
  });

  it("says so when the drafter resolved no assignee", () => {
    // ASK-not-GUESS is already enforced upstream; the row must not let an
    // unassigned ticket look assigned by saying nothing at all.
    const note = noteOf(buildTaskPayload(ticket({ assignee: undefined }), ZONE).payload);
    expect(note).toMatch(/未指派|unassigned/i);
  });

  it("keeps the tick line itself one line", () => {
    // The line stays scannable; the body lives in the note.
    const line = buildTaskPayload(ticket(), ZONE).payload.items![0]!.title;
    expect(line).not.toContain("\n");
    expect(line).toContain("TAIV");
  });
});
