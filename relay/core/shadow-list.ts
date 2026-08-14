// Phase 3 of specs/person-first-consolidation.md: the DERIVED list, run in
// shadow. Pure core, no I/O.
//
// The thesis under test: a to-do list computed from the commitment ledger —
// not authored by a model reading threads — cannot contain the failure classes
// the owner struck from the real list (already-finished work, other people's
// work, vague chase-ups). An item exists iff
//
//     who == "me"  AND  status == "open"
//
// This is the mechanical core of the owner's own standard. needs_leo (the
// per-commitment verdict from the assess step) is NOT here yet — phase 3
// measures how far the raw ledger gets before that judgment is added on top.
//
// SHADOW means shadow: nothing here touches the queue, the plans, or TickTick.
// The output is a dated JSONL record beside the state file, one row per run,
// diffed against the real list so the two can be compared item by item over
// days. The diff is the deliverable — it is how ledger coverage gaps (risk 1)
// and the needs_leo judgment (risk 4) get measured before anything switches.

import type { Commitment } from "./persona-v3.js";

export interface ShadowItem {
  /** The persona the commitment lives on. */
  personaKey: string;
  /** The commitment's own wording — never rewritten. */
  what: string;
  due?: string;
}

export interface ShadowDiff {
  at: string;
  shadow: ShadowItem[];
  /** Titles currently on the real list (grouped tasks + loose card headlines). */
  real: string[];
  /** Real titles with no shadow item that plausibly covers them. */
  realOnly: string[];
  /** Shadow items with no real counterpart. */
  shadowOnly: ShadowItem[];
  /** Pairs that look like the same work. */
  matched: Array<{ real: string; shadow: string }>;
}

/** Leo's own open commitments, across every persona — the derived list. */
export function deriveShadowList(
  personas: ReadonlyArray<{ key: string; commitments?: Commitment[] }>,
): ShadowItem[] {
  const out: ShadowItem[] = [];
  for (const p of personas) {
    for (const c of p.commitments ?? []) {
      if (c.who !== "me" || c.status !== "open") continue;
      out.push({ personaKey: p.key, what: c.what, ...(c.due ? { due: c.due } : {}) });
    }
  }
  return out;
}

// Matching is deliberately dumb: significant-token overlap, no LLM. A fuzzy
// matcher would hide exactly the gaps this diff exists to expose — when in
// doubt, report a mismatch and let a human look. Tokens are words (latin) and
// bigrams (CJK), lowercased; two titles match when either side has ≥50% of its
// tokens in the other.
function tokens(s: string): Set<string> {
  const t = new Set<string>();
  for (const m of s.toLowerCase().matchAll(/[a-z0-9][a-z0-9'-]*/g)) t.add(m[0]);
  const cjk = s.replace(/[^一-鿿]/g, "");
  for (let i = 0; i + 1 < cjk.length; i++) t.add(cjk.slice(i, i + 2));
  return t;
}

function overlaps(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const x of ta) if (tb.has(x)) shared++;
  return shared >= Math.ceil(Math.min(ta.size, tb.size) * 0.5);
}

export function diffShadow(
  at: string,
  shadow: ShadowItem[],
  real: string[],
): ShadowDiff {
  const matched: ShadowDiff["matched"] = [];
  const usedShadow = new Set<number>();
  const realOnly: string[] = [];

  for (const r of real) {
    const i = shadow.findIndex((s, idx) => !usedShadow.has(idx) && overlaps(r, s.what));
    if (i >= 0) {
      usedShadow.add(i);
      matched.push({ real: r, shadow: shadow[i]!.what });
    } else {
      realOnly.push(r);
    }
  }
  const shadowOnly = shadow.filter((_, idx) => !usedShadow.has(idx));
  return { at, shadow, real, realOnly, shadowOnly, matched };
}
