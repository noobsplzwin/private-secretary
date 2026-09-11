import { describe, expect, it } from "vitest";
import { scoreTicket, type DraftedTicket, type TicketCase } from "./ticket-score.js";

// The rubric comes from the two tickets the owner reviewed on 2026-09-09.
const ihorCase = (over: Partial<TicketCase> = {}): TicketCase => ({
  id: "memfault-offline-logs",
  personaKey: "ihor-kachura",
  corpus: "(frozen thread)",
  assignee: { name: "Ihor Kachura", alsoAccept: ["ihor@taiv.tv"] },
  mustCarry: [
    { label: "存哪些日志", anyOf: ["logcat"] },
    { label: "tcpdump", anyOf: ["tcpdump"] },
    { label: "存到 /data", anyOf: ["/data"] },
    { label: "eMMC 约束", anyOf: ["emmc", "eMMC"] },
  ],
  mustOmit: [{ label: "融资", anyOf: ["fundrais", "融资"] }],
  maxChars: 1800,
  ...over,
});

const good: DraftedTicket = {
  tool: "jira",
  project: "TAIV",
  summary: "Investigate offline log collection on the box",
  assignee: "ihor@taiv.tv",
  description: "Save periodically to /data: logcat filtered, tombstones, tcpdump, dumpsys. Must not burn through eMMC.",
};

describe("scoreTicket", () => {
  it("passes a ticket the assignee could act on unaided", () => {
    const v = scoreTicket(ihorCase(), [good]);
    expect(v.pass).toBe(true);
    expect(v.missing).toEqual([]);
    expect(v.assignee).toBe("right");
  });

  it("fails when the brain never decided a ticket was owed", () => {
    const v = scoreTicket(ihorCase(), [{ tool: "ticktick", summary: "look into logs" }]);
    expect(v.ticketed).toBe(false);
    expect(v.pass).toBe(false);
  });

  it("names the facts that only exist in the chat, when they are missing", () => {
    // A body without tcpdump or the eMMC limit sends Ihor back to Slack, which
    // is the whole failure this measures.
    const v = scoreTicket(ihorCase(), [
      { ...good, description: "Collect some logs on the box and analyze them later." },
    ]);
    expect(v.missing).toEqual(["存哪些日志", "tcpdump", "存到 /data", "eMMC 约束"]);
    expect(v.pass).toBe(false);
  });

  it("counts a wrong assignee as worse than none", () => {
    // TAIV-7050 shipped to Zack instead of Ihor.
    expect(scoreTicket(ihorCase(), [{ ...good, assignee: "Zack Louttit" }]).assignee).toBe("wrong");
    expect(scoreTicket(ihorCase(), [{ ...good, assignee: undefined }]).assignee).toBe("absent");
  });

  it("accepts the DISPLAY NAME, which is what the field holds", () => {
    // params.assignee is free text matched on exact Jira display name
    // (core/jira-assignee.ts). Demanding the email scored a correct answer
    // wrong on 2026-09-10.
    expect(scoreTicket(ihorCase(), [{ ...good, assignee: "Ihor Kachura" }]).assignee).toBe("right");
    expect(scoreTicket(ihorCase(), [{ ...good, assignee: "ihor@taiv.tv" }]).assignee).toBe("right");
  });

  it("flags strategy padding the owner strikes out", () => {
    const v = scoreTicket(ihorCase(), [
      { ...good, description: `${good.description} This is affecting the fundraising.` },
    ]);
    expect(v.padded).toEqual(["融资"]);
    expect(v.pass).toBe(false);
  });

  it("flags a body longer than his reviewed tickets", () => {
    const v = scoreTicket(ihorCase(), [{ ...good, description: `${good.description} ${"x".repeat(2000)}` }]);
    expect(v.tooLong).toBe(true);
    expect(v.pass).toBe(false);
  });

  it("accepts the model's own wording for a fact", () => {
    // anyOf exists so the bench scores understanding, not phrasing.
    const v = scoreTicket(
      ihorCase({ mustCarry: [{ label: "首个交付物是评估", anyOf: ["1-2 week", "scoping", "评估工作量"] }] }),
      [{ ...good, description: "First deliverable is a scoping answer, not an implementation." }],
    );
    expect(v.missing).toEqual([]);
  });
});
