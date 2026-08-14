import { describe, expect, it } from "vitest";
import { stabilizePlans, type StablePlan } from "./plan-stability.js";

const plan = (tier: "A" | "B" | "C" | "D", over: Partial<StablePlan> = {}): StablePlan => ({
  tier,
  rank: 0,
  why: "w",
  at: "t",
  ...over,
});

const LIVE = new Set(["t1"]);

describe("stabilizePlans", () => {
  // The overnight measurement this exists for: 26 of 38 consecutive snapshots
  // differed because a borderline B flipped to C and back, entering and
  // leaving TickTick each time.
  it("holds a listed tier on the first demotion vote", () => {
    const out = stabilizePlans({ t1: plan("C") }, { t1: plan("B") }, LIVE);
    expect(out.t1!.tier).toBe("B");
    expect(out.t1!.pending_demotion).toBe(true);
  });

  it("accepts the demotion on the second consecutive vote", () => {
    const out = stabilizePlans({ t1: plan("C") }, { t1: plan("B", { pending_demotion: true }) }, LIVE);
    expect(out.t1!.tier).toBe("C");
    expect(out.t1!.pending_demotion).toBeUndefined();
  });

  it("clears the pending flag when the next vote re-lists", () => {
    const out = stabilizePlans({ t1: plan("B") }, { t1: plan("B", { pending_demotion: true }) }, LIVE);
    expect(out.t1!.tier).toBe("B");
    expect(out.t1!.pending_demotion).toBeUndefined();
  });

  // A newly urgent thing must not wait a tick.
  it("applies a promotion immediately", () => {
    const out = stabilizePlans({ t1: plan("A") }, { t1: plan("C") }, LIVE);
    expect(out.t1!.tier).toBe("A");
  });

  it("keeps the fresh why/entities while holding only the tier", () => {
    const out = stabilizePlans(
      { t1: plan("C", { why: "fresh reasoning" }) },
      { t1: plan("B", { why: "old reasoning" }) },
      LIVE,
    );
    expect(out.t1!.tier).toBe("B");
    expect(out.t1!.why).toBe("fresh reasoning");
  });

  // The other flap source: the ranking sometimes just omits a unit.
  it("keeps the previous plan for a live unit the ranking omitted", () => {
    const out = stabilizePlans({}, { t1: plan("B") }, LIVE);
    expect(out.t1!.tier).toBe("B");
  });

  it("drops the plan of a unit with no live members", () => {
    const out = stabilizePlans({}, { dead: plan("B") }, LIVE);
    expect(out.dead).toBeUndefined();
  });

  it("C-to-D and C-to-C need no hysteresis — never listed", () => {
    const out = stabilizePlans({ t1: plan("D") }, { t1: plan("C") }, LIVE);
    expect(out.t1!.tier).toBe("D");
    expect(out.t1!.pending_demotion).toBeUndefined();
  });
});
