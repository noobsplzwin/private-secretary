import { describe, it, expect } from "vitest";
import { isChatOnlyTask } from "./task-kind.js";

describe("isChatOnlyTask", () => {
  it("drops a reply and a time to agree", () => {
    expect(isChatOnlyTask({ title: "确认周一会议是否逐条讲SoW", kind: "reply" })).toBe(true);
    expect(isChatOnlyTask({ title: "问马总下周是否有空，回杜维定时间", kind: "schedule" })).toBe(true);
    expect(isChatOnlyTask({ kind: " Reply " })).toBe(true);
    expect(isChatOnlyTask({ title: "决定PCB现金流解决方案", kind: "decide" })).toBe(true);
  });

  it("keeps work, deliverables and money", () => {
    for (const kind of ["deliver", "pay", "work"]) expect(isChatOnlyTask({ kind })).toBe(false);
  });

  it("keeps a task with no kind — an unlabelled card is not proof of chatter", () => {
    expect(isChatOnlyTask({ title: "x" })).toBe(false);
    expect(isChatOnlyTask(undefined)).toBe(false);
  });
});
