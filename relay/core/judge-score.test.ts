import { describe, expect, it } from "vitest";
import { scoreJudge, renderScorecard, ownerVerdicts, MIN_PER_CLASS, BALANCED_FLOOR, type ScoredPair, type Verdict } from "./judge-score.js";

const pairs = (owner: Verdict, judge: Verdict | null, n: number, tag = ""): ScoredPair[] =>
  Array.from({ length: n }, (_, i) => ({ actionId: `${tag}${owner}-${i}`, owner, judge }));

describe("scoreJudge", () => {
  // THE WHOLE REASON THIS FILE EXISTS. The real golden set is 131 negative / 4
  // positive, where answering `not_a_thing` every time is right 97% of the
  // time. Plain accuracy would crown that judge; balanced accuracy prices it at
  // a coin flip, and the degenerate flag names it outright.
  it("prices an always-negative judge at chance, not 97%", () => {
    const s = scoreJudge([
      ...pairs("not_a_thing", "not_a_thing", 131),
      ...pairs("confirmed", "not_a_thing", 4),
    ]);
    expect(s.agreement).toBeCloseTo(131 / 135, 3); // the flattering number
    expect(s.balanced).toBeCloseTo(0.5, 3); // the honest one
    expect(s.degenerate).toBe(true);
    expect(s.trustworthy).toBe(false);
    expect(s.note).toContain("DEGENERATE");
  });

  it("reports the majority baseline so a score is read against it", () => {
    const s = scoreJudge([...pairs("not_a_thing", "not_a_thing", 80), ...pairs("confirmed", "confirmed", 20)]);
    expect(s.majorityBaseline).toBeCloseTo(0.8, 3);
    expect(s.balanced).toBeCloseTo(1, 3);
  });

  // Today's real position: 14 negatives, 6 positives. Enough to run the
  // pipeline, nowhere near enough to mean anything — and the card must SAY so.
  it("refuses to call a thin sample a measurement", () => {
    const s = scoreJudge([
      ...pairs("not_a_thing", "not_a_thing", 14),
      ...pairs("confirmed", "confirmed", 6),
    ]);
    expect(s.balanced).toBeCloseTo(1, 3); // a perfect score …
    expect(s.enoughData).toBe(false); // … on far too little
    expect(s.trustworthy).toBe(false);
    expect(s.note).toContain("NOT ENOUGH DATA");
    expect(s.note).toContain(`confirmed 6/${MIN_PER_CLASS}`);
  });

  it("clears the floor only when both classes do", () => {
    // 100% on the common class, 60% on the rare one: the exact shape of a judge
    // that has quietly learned "say noise" — mean 0.8 sits right on the line.
    const s = scoreJudge([
      ...pairs("not_a_thing", "not_a_thing", 30),
      ...pairs("confirmed", "confirmed", 18),
      ...pairs("confirmed", "not_a_thing", 12),
    ]);
    expect(s.perClass.confirmed.recall).toBeCloseTo(0.6, 3);
    expect(s.balanced).toBeCloseTo(0.8, 3);
    expect(s.balanced).toBeGreaterThanOrEqual(BALANCED_FLOOR);
    expect(s.degenerate).toBe(false);
    expect(s.trustworthy).toBe(true);
  });

  // Abstaining is honest and must not be scored as a wrong answer — but it also
  // must not be hidden, or a judge that answers three rows out of a hundred
  // could look perfect.
  it("counts abstentions apart from mistakes", () => {
    const s = scoreJudge([
      ...pairs("not_a_thing", null, 25),
      ...pairs("not_a_thing", "not_a_thing", 25),
      ...pairs("confirmed", "confirmed", 25),
    ]);
    expect(s.abstained).toBe(25);
    expect(s.answered).toBe(50);
    expect(s.perClass.not_a_thing.n).toBe(50);
    expect(s.perClass.not_a_thing.answered).toBe(25);
    expect(s.perClass.not_a_thing.recall).toBeCloseTo(1, 3);
  });

  it("survives an empty ledger without pretending to know anything", () => {
    const s = scoreJudge([]);
    expect(s.balanced).toBe(0);
    expect(s.trustworthy).toBe(false);
    expect(s.note).toContain("NOT ENOUGH DATA");
  });
});

describe("renderScorecard", () => {
  // The caveat leads, so a number can never be quoted without it.
  it("puts the warning on the first line", () => {
    const out = renderScorecard(scoreJudge([...pairs("not_a_thing", "not_a_thing", 14), ...pairs("confirmed", "confirmed", 6)]));
    expect(out.split("\n")[0]).toContain("NOT ENOUGH DATA");
    expect(out).toContain("平衡准确率");
    expect(out).toContain("多数类基线");
    expect(out).toContain("可信：否");
  });
});

describe("ownerVerdicts", () => {
  // The ledger is mostly the engine's own bookkeeping — 628 superseded and 153
  // pruned in the real file. Scoring a judge against those would be marking its
  // own paperwork, so only the owner's two gestures count.
  it("keeps only the verdicts the owner gives", () => {
    const v = ownerVerdicts([
      { action_id: "a", existence: "not_a_thing", decided_at: "2026-09-20T03:16:00Z" },
      { action_id: "b", existence: "confirmed", decided_at: "2026-09-20T03:21:00Z" },
      { action_id: "c", existence: null, decided_at: null },
      { action_id: "d", existence: "duplicate", decided_at: "2026-08-01T00:00:00Z" },
    ]);
    expect([...v.entries()]).toEqual([["a", "not_a_thing"], ["b", "confirmed"]]);
  });

  // He is allowed to change his mind; the newest gesture is the real one.
  it("lets the latest decision win", () => {
    const v = ownerVerdicts([
      { action_id: "a", existence: "confirmed", decided_at: "2026-09-20T01:00:00Z" },
      { action_id: "a", existence: "not_a_thing", decided_at: "2026-09-20T09:00:00Z" },
    ]);
    expect(v.get("a")).toBe("not_a_thing");
  });

  it("is not fooled by ledger order", () => {
    const v = ownerVerdicts([
      { action_id: "a", existence: "not_a_thing", decided_at: "2026-09-20T09:00:00Z" },
      { action_id: "a", existence: "confirmed", decided_at: "2026-09-20T01:00:00Z" },
    ]);
    expect(v.get("a")).toBe("not_a_thing");
  });
});
