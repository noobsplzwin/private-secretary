import { describe, it, expect } from "vitest";
import { canAutoExecute, ALWAYS_CONFIRM } from "./executors.js";
import type { ActionItem } from "./action-item.js";

function item(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    id: "a1",
    source_message_id: "m1",
    action_type: "ignore",
    target: {},
    reason: "newsletter",
    confidence: 0.95,
    params: { category: "newsletter" },
    status: "suggested",
    created_at: "2026-06-10T00:00:00Z",
    ...overrides,
  };
}

describe("canAutoExecute (V1 hard rules)", () => {
  it("send-type and calendar actions NEVER auto-execute, even at confidence 1.0", () => {
    for (const type of ALWAYS_CONFIRM) {
      expect(
        canAutoExecute(
          item({
            action_type: type,
            confidence: 1.0,
            draft: "x",
            target: { personaKey: "p", platform: "gmail" },
            params: { title: "t", start: "s", end: "e", attendees: ["a"] },
          }),
        ),
      ).toBe(false);
    }
  });

  it("high-confidence ignore may auto-execute; task never does", () => {
    expect(canAutoExecute(item())).toBe(true);
    // task used to auto-execute ≥0.9 until 2026-07-31: a task is somebody's
    // request — auto-completing it marks undone work as done. ignore-only now.
    expect(
      canAutoExecute(item({ action_type: "task", params: { title: "do it" } })),
    ).toBe(false);
  });

  it("below the threshold: no auto-execute", () => {
    expect(canAutoExecute(item({ confidence: 0.8 }))).toBe(false);
  });

  it("missing info blocks auto-execute", () => {
    expect(canAutoExecute(item({ params: {} }))).toBe(false);
  });

  it("only suggested actions auto-execute", () => {
    expect(canAutoExecute(item({ status: "approved" }))).toBe(false);
    expect(canAutoExecute(item({ status: "executed" }))).toBe(false);
  });
});

describe("calendar auto-creation (owner removed the approval gate 2026-09-14)", () => {
  const cal = (over: Record<string, unknown> = {}, conf = 0.95): ActionItem => ({
    id: "c1",
    source_message_id: "wechat:蘇一:1",
    action_type: "calendar",
    target: { platform: "wechat" },
    reason: "meeting agreed in the thread",
    confidence: conf,
    params: { title: "郭律 Legal OH", start: "2026-09-16T14:00:00+08:00", end: "2026-09-16T16:00:00+08:00", time_confirmed: true, ...over },
    status: "suggested",
    created_at: "2026-09-14T00:00:00Z",
  });

  it("auto-executes a calendar whose time the thread confirmed", () => {
    expect(canAutoExecute(cal())).toBe(true);
  });

  // The fail-closed half of "never invent a clock time" — the owner's
  // 「你哪来的20-21时间?」. Auto-creation must not weaken it.
  it("refuses one whose time was never confirmed", () => {
    expect(canAutoExecute(cal({ time_confirmed: undefined }))).toBe(false);
    expect(canAutoExecute(cal({ time_confirmed: false }))).toBe(false);
  });

  it("refuses one missing a start or an end", () => {
    expect(canAutoExecute(cal({ start: "" }))).toBe(false);
    expect(canAutoExecute(cal({ end: "" }))).toBe(false);
  });

  it("refuses a low-confidence read", () => {
    expect(canAutoExecute(cal({}, 0.5))).toBe(false);
  });

  it("never re-executes one already handled", () => {
    expect(canAutoExecute({ ...cal(), status: "executed" })).toBe(false);
    expect(canAutoExecute({ ...cal(), status: "rejected" })).toBe(false);
  });

  it("still requires a human for reply / relay / forward / tool", () => {
    for (const t of ["reply", "relay", "forward", "tool"] as const) expect(ALWAYS_CONFIRM.has(t)).toBe(true);
    expect(ALWAYS_CONFIRM.has("calendar")).toBe(false);
  });
});
