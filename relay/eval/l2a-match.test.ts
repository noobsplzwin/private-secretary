import { describe, expect, it } from "vitest";
import { matchProposals, overlapScore, score } from "./l2a-match.js";
import type { GroundTruthItem, ProposedTodo } from "./l2a.js";

const g = (over: Partial<GroundTruthItem>): GroundTruthItem => ({
  id: "g1",
  personaKey: "zech",
  title: "签署高通 NDA 并回传给李冰",
  verdict: "real",
  ...over,
});

const p = (over: Partial<ProposedTodo>): ProposedTodo => ({
  personaKey: "zech",
  title: "签署高通 NDA 并回传",
  evidence: [],
  ...over,
});

describe("overlapScore", () => {
  it("scores same work under wording drift high, different work low", () => {
    expect(overlapScore("Book a house cleaner before Sept 1", "Book house cleaner before the Sept 1 move-in")).toBeGreaterThan(0.6);
    expect(overlapScore("签署高通NDA并回传给李冰", "订购1500台长周期物料")).toBeLessThan(0.2);
  });
});

describe("matchProposals", () => {
  it("pairs within the same persona only", () => {
    const m = matchProposals([p({ personaKey: "someone-else" })], [g({})]);
    expect(m.pairs).toEqual([]);
    expect(m.unmatchedProposals).toEqual([0]);
    expect(m.unmatchedGround).toEqual(["g1"]);
  });

  // REGRESSION 2026-08-24: the S0 scorecard reported a true positive for
  // 「和朱桦去井智科技」 because the proposal 「帮朱桦搭 PPT agent」 shared the
  // name 朱桦. A person says WHO, never WHAT — one anchor is not a match.
  it("one shared person-name does NOT match a two-anchor item", () => {
    const m = matchProposals(
      [p({ title: "帮朱桦搭 Claude agent 自动生成 NXP 格式 PPT", evidence: [] })],
      [g({ id: "jingzhi", title: "和朱桦去井智科技", matchHints: ["井智", "朱桦"] })],
    );
    expect(m.pairs).toEqual([]);
    expect(m.unmatchedProposals).toEqual([0]);
  });

  it("both anchors present still matches on hints alone", () => {
    const m = matchProposals(
      [p({ title: "约朱桦时间去井智科技拜访", evidence: [] })],
      [g({ id: "jingzhi", title: "和朱桦去井智科技", matchHints: ["井智", "朱桦"] })],
    );
    expect(m.pairs).toHaveLength(1);
  });

  it("a single-anchor item still matches on its one anchor", () => {
    const m = matchProposals(
      [p({ title: "Visit 茂名 — moved to Saturday", evidence: [] })],
      [g({ id: "maoming", title: "8/28 与金小奇、诚哥去茂名", matchHints: ["茂名"] })],
    );
    expect(m.pairs).toHaveLength(1);
  });

  it("a match hint (entity) pins lexically distant same-work pairs", () => {
    const m = matchProposals(
      [p({ title: "安排瑞萨周一寄两块开发板给陈古龙", evidence: ["我让他们周一给你寄两块U2A8的板子"] })],
      [g({ id: "u2a8", title: "寄板事件——型号被串染", verdict: "invented_detail", matchHints: ["U2A8"] })],
    );
    expect(m.pairs).toHaveLength(1);
    expect(m.pairs[0]!.groundId).toBe("u2a8");
  });

  it("greedy: one proposal claims at most one ground item", () => {
    const m = matchProposals(
      [p({ title: "签署高通 NDA 并回传给李冰" })],
      [g({ id: "a" }), g({ id: "b", title: "签署高通 NDA 回传" })],
    );
    expect(m.pairs).toHaveLength(1);
    expect(m.unmatchedGround).toHaveLength(1);
  });
});

describe("score", () => {
  const ground: GroundTruthItem[] = [
    g({ id: "real1", verdict: "real" }),
    g({ id: "real2", verdict: "real", title: "下 3500 套新订单", mustFind: true, matchHints: ["3500"] }),
    g({ id: "bad1", verdict: "not_mine", title: "Talk to Mitch about cable box brands" }),
  ];

  it("splits TP, reproduced mistakes, unknowns, misses and hard misses", () => {
    const proposals: ProposedTodo[] = [
      p({ title: "签署高通 NDA 并回传给李冰" }), // → real1
      p({ title: "Talk to Mitch about the cable box brands" }), // → bad1 (reproduced known-bad)
      p({ title: "完全无关的新提案" }), // unknown
    ];
    const m = matchProposals(proposals, ground);
    const s = score("s0", "t", proposals, ground, m);
    expect(s.truePositives).toBe(1);
    expect(s.reproducedMistakes).toEqual({ not_mine: 1 });
    expect(s.unknown).toBe(1);
    expect(s.misses).toEqual(["real2"]);
    // real2 is mustFind — missing it is a hard failure, the Echo class
    expect(s.hardMisses).toEqual(["real2"]);
    expect(s.precisionKnown).toBe(0.5);
    expect(s.recall).toBe(0.5);
  });
});
