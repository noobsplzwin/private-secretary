// Matching proposals to ground truth + the scorecard. Pure, deterministic.
//
// The matcher is DELIBERATELY DUMB — significant-token overlap plus match
// hints, same doctrine as the retired shadow-list diff: a matcher smart enough
// to join lexically-distant same-work pairs is smart enough to hide exactly
// the gaps this bench exists to expose. Unmatched proposals are REPORTED for
// the owner, never silently scored as anything.

import type { GroundTruthItem, ProposedTodo } from "./l2a.js";

const STOP = new Set([
  "the","a","an","to","for","with","and","or","of","in","on","at","his","her",
  "把","的","了","和","与","给","向","去","来","要","再","就","都","很","个",
  "一个","进行","一下","关于",
]);

/** Words (latin, folded) and CJK bigrams — the same token shape the shadow diff used. */
export function tokens(s: string): Set<string> {
  const out = new Set<string>();
  const lower = s.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9./-]{1,}/g)) {
    if (!STOP.has(m[0])) out.add(m[0]);
  }
  const cjk = lower.replace(/[^一-鿿]/g, "");
  for (let i = 0; i + 1 < cjk.length; i++) {
    const bg = cjk.slice(i, i + 2);
    if (!STOP.has(bg)) out.add(bg);
  }
  return out;
}

export function overlapScore(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.min(ta.size, tb.size);
}

export interface MatchResult {
  /** proposal index → ground truth id */
  pairs: Array<{ proposalIdx: number; groundId: string; score: number }>;
  unmatchedProposals: number[];
  unmatchedGround: string[]; // ground truth ids with no proposal
}

const MATCH_THRESHOLD = 0.45;

/**
 * Greedy best-first matching, constrained to the same persona. A match hint
 * (entity/name token appearing verbatim in the proposal title or evidence)
 * counts as a hit regardless of overlap — entities are the strongest identity
 * signal we have, and they are exactly what G3 anchors.
 */
export function matchProposals(
  proposals: readonly ProposedTodo[],
  ground: readonly GroundTruthItem[],
): MatchResult {
  const candidates: Array<{ p: number; g: number; score: number }> = [];
  for (let p = 0; p < proposals.length; p++) {
    for (let g = 0; g < ground.length; g++) {
      const gt = ground[g]!;
      // "*" = person unknown or unresolvable (the Echo case has no persona at
      // all — that unresolvability is part of what the bench measures).
      if (gt.personaKey !== "*" && gt.personaKey !== proposals[p]!.personaKey) continue;
      const text = `${proposals[p]!.title} ${proposals[p]!.evidence.join(" ")}`;
      const hintHit = (gt.matchHints ?? []).some((h) =>
        text.toLowerCase().includes(h.toLowerCase()),
      );
      const score = overlapScore(proposals[p]!.title, gt.title);
      const eff = hintHit ? Math.max(score, MATCH_THRESHOLD) : score;
      if (eff >= MATCH_THRESHOLD) candidates.push({ p, g, score: eff });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const usedP = new Set<number>();
  const usedG = new Set<number>();
  const pairs: MatchResult["pairs"] = [];
  for (const c of candidates) {
    if (usedP.has(c.p) || usedG.has(c.g)) continue;
    usedP.add(c.p);
    usedG.add(c.g);
    pairs.push({ proposalIdx: c.p, groundId: ground[c.g]!.id, score: c.score });
  }
  return {
    pairs,
    unmatchedProposals: proposals.map((_, i) => i).filter((i) => !usedP.has(i)),
    unmatchedGround: ground.map((g, i) => ({ g, i })).filter(({ i }) => !usedG.has(i)).map(({ g }) => g.id),
  };
}

// ── Scorecard ──────────────────────────────────────────────────────────────

export interface Scorecard {
  strategy: string;
  frozenAt: string;
  proposals: number;
  /** matched a `real` item — the strategy found true work */
  truePositives: number;
  /** matched a known-bad, bucketed by which mistake it reproduced */
  reproducedMistakes: Record<string, number>; // verdict → count
  /** matched nothing — needs owner review, NOT auto-scored */
  unknown: number;
  /** real items the strategy missed and COULD have found */
  misses: string[];
  /** real items no strategy can find — the input layer's holes, constant across strategies */
  inputMisses: string[];
  /** reachable mustFind items missed — any entry here fails the run */
  hardMisses: string[];
  /** TP / (TP + reproduced mistakes). Unknowns excluded — they are unscored. */
  precisionKnown: number;
  /** TP / |reachable real| — input-unreachable items excluded from the denominator */
  recall: number;
}

export function score(
  strategy: string,
  frozenAt: string,
  proposals: readonly ProposedTodo[],
  ground: readonly GroundTruthItem[],
  match: MatchResult,
): Scorecard {
  const byId = new Map(ground.map((g) => [g.id, g]));
  let tp = 0;
  const reproduced: Record<string, number> = {};
  for (const pair of match.pairs) {
    const g = byId.get(pair.groundId)!;
    if (g.verdict === "real") tp++;
    else reproduced[g.verdict] = (reproduced[g.verdict] ?? 0) + 1;
  }
  const realIds = ground.filter((g) => g.verdict === "real");
  const matchedIds = new Set(match.pairs.map((p) => p.groundId));
  const missed = realIds.filter((g) => !matchedIds.has(g.id));
  const misses = missed.filter((g) => !g.inputUnreachable).map((g) => g.id);
  const inputMisses = missed.filter((g) => g.inputUnreachable).map((g) => g.id);
  const hardMisses = missed
    .filter((g) => g.mustFind && !g.inputUnreachable)
    .map((g) => g.id);
  const badCount = Object.values(reproduced).reduce((a, b) => a + b, 0);
  return {
    strategy,
    frozenAt,
    proposals: proposals.length,
    truePositives: tp,
    reproducedMistakes: reproduced,
    unknown: match.unmatchedProposals.length,
    misses,
    inputMisses,
    hardMisses,
    precisionKnown: tp + badCount === 0 ? 0 : tp / (tp + badCount),
    recall: (() => {
      const reachable = realIds.filter((g) => !g.inputUnreachable).length;
      return reachable === 0 ? 0 : tp / reachable;
    })(),
  };
}
