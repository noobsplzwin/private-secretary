import { describe, expect, it } from "vitest";
import { coveredByTicket, ownerTicketsFrom, ticketBlock, ticketByHandle } from "./owner-tickets.js";

describe("ownerTicketsFrom", () => {
  it("keeps only his open tasks: not engine-tagged, not tracked", () => {
    const remote = [
      { id: "mine", status: 0, title: "股权变更", items: [{ id: "a", status: 0, title: "A 启动" }, { id: "b", status: 1, title: "已做" }] },
      { id: "engine", status: 0, title: "secretary row", tags: ["secretary"] },
      { id: "tracked", status: 0, title: "tracked row" },
      { id: "done", status: 2, title: "finished" },
    ];
    const t = ownerTicketsFrom(remote, { k: { ticktickId: "tracked", projectId: "p", hash: "h" } });
    expect(t).toEqual([{ id: "mine", title: "股权变更", steps: ["A 启动"] }]);
  });
});

describe("handles", () => {
  const tickets = [
    { id: "x1", title: "股权变更", steps: ["A 启动"] },
    { id: "x2", title: "AGV", steps: [] },
  ];
  it("render as T1, T2 with their steps", () => {
    expect(ticketBlock(tickets)).toBe("T1. 股权变更\n    · A 启动\nT2. AGV");
  });
  it("map back to the real ticket; anything else covers nothing", () => {
    expect(ticketByHandle(tickets, "T2")?.id).toBe("x2");
    expect(ticketByHandle(tickets, " t1 ")?.id).toBe("x1");
    expect(ticketByHandle(tickets, "T3")).toBeNull();
    expect(ticketByHandle(tickets, "股权变更")).toBeNull();
    expect(ticketByHandle(tickets, undefined)).toBeNull();
    expect(coveredByTicket(tickets[0]!)).toBe("owner-ticket:x1 股权变更");
  });
});
