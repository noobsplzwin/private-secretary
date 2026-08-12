import { describe, expect, it } from "vitest";
import {
  TICKTICK_BATCH_MAX,
  fingerprintFor,
  fingerprintOfExisting,
  notesFor,
  payloadFor,
  priorityFor,
  rruleFor,
  titleFor,
  type MsTask,
} from "./mstodo.js";

function ms(over: Partial<MsTask> = {}): MsTask {
  return {
    id: "AQMk-1",
    title: "发送SoW",
    status: "completed",
    importance: "normal",
    createdDateTime: "2026-06-18T01:43:36.827656Z",
    dueDateTime: { dateTime: "2026-06-17T00:00:00.0000000" },
    completedDateTime: { dateTime: "2026-06-19T00:00:00.0000000" },
    ...over,
  };
}

// TickTick truncates a >50 batch silently (empty id2error), which is how the
// first bulk run lost 803 tasks. This constant is the guard.
it("pins TickTick's silent batch ceiling at 50", () => {
  expect(TICKTICK_BATCH_MAX).toBe(50);
});

describe("titleFor", () => {
  it("flattens a multi-line Microsoft title", () => {
    expect(titleFor(ms({ title: "减资\r更换公司类型" }))).toBe("减资 / 更换公司类型");
  });

  it("never returns an empty title", () => {
    expect(titleFor(ms({ title: "   " }))).toBe("(untitled)");
  });
});

describe("priorityFor", () => {
  it("maps Microsoft importance onto TickTick's 0/1/3/5", () => {
    expect(priorityFor("high")).toBe(5);
    expect(priorityFor("normal")).toBe(0);
    expect(priorityFor("low")).toBe(1);
  });
});

describe("rruleFor", () => {
  const rec = (pattern: Record<string, unknown>) => ms({ recurrence: { pattern } });

  it("maps the patterns present in the export", () => {
    expect(rruleFor(rec({ type: "absoluteMonthly", interval: 1, dayOfMonth: 9 }))).toBe(
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=9",
    );
    expect(rruleFor(rec({ type: "weekly", interval: 1, daysOfWeek: ["monday"] }))).toBe(
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
    );
    expect(rruleFor(rec({ type: "daily", interval: 28 }))).toBe("RRULE:FREQ=DAILY;INTERVAL=28");
  });

  // A guessed rule generates to-dos forever, so an unmapped pattern is dropped.
  it("drops an unmapped pattern rather than guessing", () => {
    expect(rruleFor(rec({ type: "relativeYearly", interval: 1 }))).toBeUndefined();
    expect(rruleFor(ms())).toBeUndefined();
  });
});

describe("payloadFor", () => {
  it("carries dates, tag and timezone", () => {
    const p = payloadFor(ms(), "Tasks", "proj1");
    expect(p).toMatchObject({
      title: "发送SoW",
      projectId: "proj1",
      kind: "TEXT",
      dueDate: "2026-06-17T00:00:00+0000",
      startDate: "2026-06-17T00:00:00+0000",
      isAllDay: true,
      tags: ["mstodo"],
    });
  });

  // REGRESSION: completing a task that carries a repeatFlag makes TickTick
  // spawn the next occurrence — 300 exported rows recur, so this would leave
  // 300 phantom open to-dos.
  it("strips recurrence from a COMPLETED task but keeps it on an open one", () => {
    const recurring = { pattern: { type: "daily", interval: 28 } };
    expect(payloadFor(ms({ recurrence: recurring }), "Tasks", "p").repeatFlag).toBeUndefined();
    expect(
      payloadFor(ms({ status: "notStarted", recurrence: recurring }), "Tasks", "p").repeatFlag,
    ).toBe("RRULE:FREQ=DAILY;INTERVAL=28");
  });

  it("puts notes in desc + items for a checklist, content for plain text", () => {
    const withItems = payloadFor(
      ms({ checklistItems: [{ displayName: "step one", isChecked: true }] }),
      "Tasks",
      "p",
    );
    expect(withItems.kind).toBe("CHECKLIST");
    expect(withItems.items).toEqual([{ title: "step one", status: 1, sortOrder: 0 }]);
    expect(withItems.desc).toBeTruthy();
    expect(withItems.content).toBeUndefined();

    const plain = payloadFor(ms(), "Tasks", "p");
    expect(plain.content).toBeTruthy();
    expect(plain.desc).toBeUndefined();
  });

  it("omits due/start when Microsoft had no due date", () => {
    const p = payloadFor(ms({ dueDateTime: undefined }), "秦老师", "p");
    expect(p.dueDate).toBeUndefined();
    expect(p.isAllDay).toBeUndefined();
  });
});

describe("notesFor", () => {
  // This string is a WIRE FORMAT: it is the identity of a migrated row and the
  // only place the true Microsoft dates survive. Pinned exactly.
  it("emits the exact provenance line", () => {
    expect(notesFor(ms(), "Tasks")).toBe(
      "— Microsoft To Do · list: Tasks · created 2026-06-18 · due 2026-06-17 · completed 2026-06-19",
    );
  });

  it("keeps the original body above the provenance line", () => {
    const n = notesFor(ms({ body: { content: "范 - 23号\r\nFranky 23号" } }), "Tasks");
    expect(n.startsWith("范 - 23号\nFranky 23号\n\n— Microsoft To Do")).toBe(true);
  });

  it("omits facts Microsoft did not have", () => {
    const n = notesFor(ms({ dueDateTime: undefined, completedDateTime: undefined }), "秦老师");
    expect(n).toBe("— Microsoft To Do · list: 秦老师 · created 2026-06-18");
  });
});

describe("fingerprint", () => {
  // Title alone cannot identify a row: 42 exported titles repeat, one of them
  // 43 times, each occurrence with different dates. Title + notes can.
  it("distinguishes same-titled rows by their dates", () => {
    const a = fingerprintFor(ms({ title: "股票", dueDateTime: { dateTime: "2026-07-10T00:00:00" } }), "Tasks");
    const b = fingerprintFor(ms({ title: "股票", dueDateTime: { dateTime: "2026-08-07T00:00:00" } }), "Tasks");
    expect(a).not.toBe(b);
  });

  it("round-trips against what TickTick returns for a TEXT task", () => {
    const t = ms();
    const payload = payloadFor(t, "Tasks", "p");
    expect(fingerprintOfExisting({ title: payload.title, content: payload.content as string })).toBe(
      fingerprintFor(t, "Tasks"),
    );
  });

  it("round-trips for a CHECKLIST task, whose notes live in desc", () => {
    const t = ms({ checklistItems: [{ displayName: "s", isChecked: false }] });
    const payload = payloadFor(t, "Tasks", "p");
    expect(fingerprintOfExisting({ title: payload.title, desc: payload.desc as string })).toBe(
      fingerprintFor(t, "Tasks"),
    );
  });
});
