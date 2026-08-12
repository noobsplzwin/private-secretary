import { describe, expect, it } from "vitest";
import {
  approvedActionIds,
  buildInviteLabel,
  buildToolLabel,
  buildUnresolvedLabel,
  isExecutableItem,
} from "./ticktick-approval.js";

describe("buildInviteLabel", () => {
  // The tick IS the approval, so the line has to say who gets emailed. A
  // display name is not reviewable; an address is.
  it("names every recipient by resolved address, plus the time", () => {
    const label = buildInviteLabel({
      attendees: [{ email: "kevin.chen@acme.com", displayName: "Kevin" }, { email: "sara@x.io" }],
      whenLabel: "8/20 09:00",
      title: "产品评审",
    });
    expect(label).toContain("kevin.chen@acme.com");
    expect(label).toContain("sara@x.io");
    expect(label).toContain("8/20 09:00");
    expect(label).toContain("产品评审");
    expect(isExecutableItem(label)).toBe(true);
  });

  it("works without a title", () => {
    const label = buildInviteLabel({ attendees: [{ email: "a@b.c" }], whenLabel: "8/20 09:00" });
    expect(label).toContain("a@b.c");
  });

  // A tickable send with nobody to send to is a bug, not an empty invite.
  it("throws with no resolved attendee", () => {
    expect(() => buildInviteLabel({ attendees: [], whenLabel: "8/20 09:00" })).toThrow(
      /resolved attendee/,
    );
  });
});

describe("buildToolLabel", () => {
  it("shows destination, summary and assignee — the parts that reach a person", () => {
    const label = buildToolLabel({
      tool: "Jira",
      destination: "OUS",
      summary: "修复 HDMI 掉线",
      assignee: "kevin.chen@acme.com",
    });
    expect(label).toContain("Jira");
    expect(label).toContain("OUS");
    expect(label).toContain("修复 HDMI 掉线");
    expect(label).toContain("kevin.chen@acme.com");
    expect(isExecutableItem(label)).toBe(true);
  });

  it("omits the assignee clause when unassigned rather than guessing one", () => {
    const label = buildToolLabel({ tool: "Jira", destination: "OUS", summary: "x" });
    expect(label).not.toContain("指派");
  });
});

describe("buildUnresolvedLabel", () => {
  // ASK-not-GUESS: an unresolved name must never end up behind a tickable send.
  it("is NOT executable, so an unresolved name cannot be ticked into a send", () => {
    const label = buildUnresolvedLabel(["Kevin", "小张"]);
    expect(isExecutableItem(label)).toBe(false);
    expect(label).toContain("Kevin");
    expect(label).toContain("小张");
  });
});

describe("isExecutableItem", () => {
  it("is false for an ordinary note-to-self line", () => {
    expect(isExecutableItem("给敏姐打电话")).toBe(false);
    expect(isExecutableItem("回复 Kevin：明天给你答复")).toBe(false);
  });
});

describe("approvedActionIds", () => {
  const tracked = [
    { itemId: "i1", actionId: "a1" },
    { itemId: "i2", actionId: "a2" },
  ];

  it("fires only what is ticked", () => {
    const remote = [
      { id: "i1", status: 1 },
      { id: "i2", status: 0 },
    ];
    expect(approvedActionIds(remote, tracked, new Set())).toEqual(["a1"]);
  });

  // THE critical one: the daemon re-polls every cycle and a ticked item reads
  // as ticked forever, so without this the invites go out again every poll.
  it("never fires an action that already executed", () => {
    const remote = [{ id: "i1", status: 1 }];
    expect(approvedActionIds(remote, tracked, new Set(["a1"]))).toEqual([]);
  });

  // Unchecking cannot un-email anyone. It must not re-arm the item either,
  // or one tick could send twice.
  it("un-ticking after execution neither cancels nor re-arms", () => {
    const executed = new Set(["a1"]);
    expect(approvedActionIds([{ id: "i1", status: 0 }], tracked, executed)).toEqual([]);
    expect(approvedActionIds([{ id: "i1", status: 1 }], tracked, executed)).toEqual([]);
  });

  it("ignores items it has no record for", () => {
    expect(approvedActionIds([{ id: "stranger", status: 1 }], tracked, new Set())).toEqual([]);
  });

  it("returns an action once even if two items point at it", () => {
    const dupe = [
      { itemId: "i1", actionId: "a1" },
      { itemId: "i2", actionId: "a1" },
    ];
    const remote = [
      { id: "i1", status: 1 },
      { id: "i2", status: 1 },
    ];
    expect(approvedActionIds(remote, dupe, new Set())).toEqual(["a1"]);
  });
});
