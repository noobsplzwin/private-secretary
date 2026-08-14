// Tier hysteresis: the owner's list must not flap. Pure core, no I/O.
//
// The ranking pass replaces loop-state.plans WHOLESALE every run, and the list
// boundary is tier ∈ {A, B} — so a borderline task the model calls B on one
// tick and C on the next enters and leaves TickTick every half hour. Measured
// overnight: 26 of 38 consecutive snapshot pairs differed, 132 title
// crossings, one task flapping 10 times. The owner sees a different list every
// time he looks, which defeats the "stable handful" the list exists to be.
//
// Two rules, both deterministic:
//
// 1. DEMOTION NEEDS TWO CONSECUTIVE VOTES. A unit currently listed (A/B) that
//    the fresh ranking puts at C/D keeps its previous tier once, marked
//    pending; a second consecutive C/D accepts the demotion. Any A/B vote in
//    between clears the pending flag. Promotions apply immediately — a newly
//    urgent thing must not wait a tick.
//
// 2. OMISSION IS NOT DEMOTION. The fresh ranking sometimes simply omits a unit
//    (model lapse, prompt truncation). A unit that still has live cards keeps
//    its previous plan; only a unit with no live members loses it.

import type { TaskPlan, TaskPlanMap } from "./tasks.js";

const LISTED = new Set(["A", "B"]);

/** TaskPlan plus the hysteresis marker (persisted in loop-state.plans). */
export interface StablePlan extends TaskPlan {
  /** Set when the last ranking voted to demote a listed unit; cleared on any A/B vote. */
  pending_demotion?: boolean;
}

export function stabilizePlans(
  fresh: TaskPlanMap,
  prev: Record<string, StablePlan>,
  /** Unit keys that still have live (suggested/approved) members. */
  liveKeys: ReadonlySet<string>,
): Record<string, StablePlan> {
  const out: Record<string, StablePlan> = {};

  for (const [key, plan] of Object.entries(fresh)) {
    const before = prev[key];
    const wasListed = before !== undefined && LISTED.has(before.tier);
    const nowListed = LISTED.has(plan.tier);

    if (wasListed && !nowListed) {
      if (before.pending_demotion) {
        out[key] = { ...plan }; // second consecutive vote — demotion accepted
      } else {
        // First vote: keep the shown tier, remember the vote. The fresh why/
        // entities still win — only the tier is held back.
        out[key] = { ...plan, tier: before.tier, pending_demotion: true };
      }
    } else {
      out[key] = { ...plan }; // promotion, or no boundary crossing — take fresh
    }
  }

  for (const [key, plan] of Object.entries(prev)) {
    if (out[key] || !liveKeys.has(key)) continue;
    out[key] = { ...plan }; // omitted but alive — model lapse, not a demotion
  }

  return out;
}
