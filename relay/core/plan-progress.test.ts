import { describe, expect, it } from "vitest";
import { ADDED_PREFIX, PROGRESS_HEADER, applyPlanUpdate, findPlanProgress, mergePlanUpdates } from "./plan-progress.js";
import { spokenFromCorpus } from "./closure-check.js";

const PLAN = {
  id: "tk1",
  title: "零跑 Benchmarking",
  steps: ["节后找 Sky 定 12 号那周到场的两天", "去之前改好跑分脚本"],
  stepIds: ["s1", "s2"],
};
const NEW = spokenFromCorpus(["[2026-10-08 10:12] 凯。: 13、14号我们都可以，就定13号到场", "[2026-10-08 10:13] 凯。: 收到"].join("\n"));

describe("findPlanProgress — the gate", () => {
  it("ticks a step and records the news, quoting the line, never the model's words", async () => {
    const u = await findPlanProgress("凯。", [PLAN], NEW, async () => ({
      done: [{ ticket: "T1", step: 1, evidence: "就定13号到场" }],
      news: [{ ticket: "T1", evidence: "13、14号我们都可以，就定13号到场" }],
    }), "2026-10-08");
    expect(u).toEqual([{ ticketId: "tk1", check: ["s1"], notes: ["10/8 凯。：「13、14号我们都可以，就定13号到场」"], addSteps: [] }]);
  });
  it("drops an unknown plan or step, and a quote no line carries", async () => {
    const u = await findPlanProgress("凯。", [PLAN], NEW, async () => ({
      done: [{ ticket: "T9", step: 1, evidence: "就定13号到场" }, { ticket: "T1", step: 7, evidence: "就定13号到场" }, { ticket: "T1", step: 2, evidence: "脚本写好了" }],
      news: [{ ticket: "T1", evidence: "Sky 确认了日期" }],
    }), "2026-10-08");
    expect(u).toEqual([]);
  });
  it("asks nothing without plans or new lines; a failed call changes nothing", async () => {
    let asked = 0;
    const json = async () => ((asked += 1), {});
    expect(await findPlanProgress("x", [], NEW, json, "2026-10-08")).toEqual([]);
    expect(await findPlanProgress("x", [PLAN], [], json, "2026-10-08")).toEqual([]);
    expect(asked).toBe(0);
    expect(await findPlanProgress("x", [PLAN], NEW, async () => { throw new Error("down"); }, "2026-10-08")).toEqual([]);
  });
});

describe("applyPlanUpdate — never touches what he wrote", () => {
  const task = {
    desc: "■ 你的计划\n第一天采数据",
    items: [
      { id: "s1", title: "节后找 Sky 定 12 号那周到场的两天", status: 0, sortOrder: 0 },
      { id: "s2", title: "去之前改好跑分脚本", status: 0, sortOrder: 1 },
    ],
  };
  it("ticks, appends progress under one header, adds a marked step", () => {
    const next = applyPlanUpdate(task, { ticketId: "tk1", check: ["s1"], notes: ["10/8 凯。：「就定13号到场」"], addSteps: ["把报告发郭总"] })!;
    expect(next.items.map((i) => [i.title, i.status])).toEqual([
      ["节后找 Sky 定 12 号那周到场的两天", 1],
      ["去之前改好跑分脚本", 0],
      [`${ADDED_PREFIX}把报告发郭总`, 0],
    ]);
    expect(next.desc).toBe(`■ 你的计划\n第一天采数据\n\n${PROGRESS_HEADER}\n· 10/8 凯。：「就定13号到场」`);
    const again = applyPlanUpdate(next, { ticketId: "tk1", check: ["s1"], notes: ["10/8 凯。：「就定13号到场」"], addSteps: ["把报告发郭总"] });
    expect(again).toBeNull(); // nothing new — nothing written
  });
  it("a step he already listed is not added again", () => {
    expect(applyPlanUpdate(task, { ticketId: "tk1", check: [], notes: [], addSteps: ["改好跑分脚本"] })).toBeNull();
  });
});

describe("mergePlanUpdates", () => {
  it("one write per ticket", () => {
    expect(mergePlanUpdates([
      { ticketId: "a", check: ["s1"], notes: [], addSteps: [] },
      { ticketId: "a", check: ["s1"], notes: ["n"], addSteps: ["x"] },
    ])).toEqual([{ ticketId: "a", check: ["s1"], notes: ["n"], addSteps: ["x"] }]);
  });
});
