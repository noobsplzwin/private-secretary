// L2A bench (specs/commitment-brain.md §13-to-be): from frozen chat input to a
// proposed to-do list, with the THEORY as the only swappable part.
//
// Everything around the slot is held constant so strategies compete fairly:
// the frozen corpus, the frozen ledger snapshot, the ground truth (the owner's
// own adjudications), and the scoring. A strategy may do anything inside —
// one-shot extraction, speech-act classification, direct summarization — but
// it can only PROPOSE; nothing here writes to the production ledger.
//
// This is Gate B of the July eval plan (relay/eval/baseline.ts header): live
// inference over a small gold set, affordable because the person set is ~20,
// not 1,111 rounds.

export interface FrozenPerson {
  personaKey: string;
  displayName: string;
  /** The cross-source corpus text, exactly as the production reader renders it. */
  corpus: string;
  /**
   * The person's ledger commitments at freeze time, verbatim — INCLUDING the
   * assessment. The verdict is what promotes a commitment onto the working
   * list, and a freeze that drops it hands the strategy a ledger with no
   * memory: the 2026-09-07 run scored 0% because 28 needs_leo verdicts that
   * existed on the day were simply not in the snapshot.
   */
  ledger: Array<{
    who: "me" | "them";
    what: string;
    status: string;
    due?: string;
    matter_id?: string;
    assessment?: {
      needs_leo: boolean;
      blocked_on?: "leo" | "them" | "third-party";
      next_step?: string;
      evidence: string;
      at: string;
    };
  }>;
}

export interface EvalInput {
  frozenAt: string;
  /**
   * The owner's LIVE matter ids. A commitment outside them cannot claim a slot
   * on the working list (core/ledger-list.ts's promotion gate), so a strategy
   * that renders the real list needs them.
   */
  matters: string[];
  /**
   * The matters he CLOSED. Work inside one sinks whatever the verdict says —
   * his ruling outranks a model verdict — so a strategy rendering the real
   * list needs these separately from "simply unfiled".
   */
  closedMatters?: string[];
  persons: FrozenPerson[];
}

/** What every strategy must produce: the to-do list it believes the owner owes. */
export interface ProposedTodo {
  personaKey: string;
  /** The to-do wording, in the source language. */
  title: string;
  matterId?: string;
  due?: string;
  /** Verbatim quotes the strategy claims as evidence (scored for grounding). */
  evidence: string[];
}

export interface L2AStrategy {
  name: string;
  /** Pure: reads the input, returns proposals. MUST NOT write any state. */
  propose(input: EvalInput): Promise<ProposedTodo[]>;
}

// ── Ground truth ───────────────────────────────────────────────────────────
//
// Encoded from the owner's explicit adjudications, never from Claude's belief.
// `real` items are work the owner confirmed he owes; every other verdict is a
// KNOWN-BAD the previous pipeline produced and the owner struck, kept so a
// strategy that reproduces the mistake is charged for it by name.

export type GroundVerdict =
  | "real" // the owner confirmed this is his, current, actionable
  | "not_mine" // someone else's first-person commitment mis-assigned to him
  | "stale" // long-finished or long-ago; must not resurface
  | "invented_detail" // right work, fabricated entity (the U2A8 case)
  | "too_granular" // a thought/consideration, not a deliverable
  | "wrong_action"; // real matter, but the proposed action is not what the situation needs

export interface GroundTruthItem {
  id: string;
  personaKey: string;
  /** Owner-language description of the item (used for matching). */
  title: string;
  verdict: GroundVerdict;
  matterId?: string;
  /** Tokens that pin the match (entities, names) — any hit counts. */
  matchHints?: string[];
  /** The owner's own words when he ruled. Provenance, never scored. */
  ownerQuote?: string;
  /**
   * Set when the item cannot exist in the frozen input at all (no persona, a
   * corrupt handle, a persona-less sender). These misses measure the INPUT
   * layer — the person-discovery holes — identically for every strategy, so
   * the scorecard buckets them apart from strategy misses.
   */
  inputUnreachable?: string;
  /**
   * real items only: the recall hard-set. These are things the owner had to
   * point out himself (the Echo case) — a strategy that misses one fails the
   * run outright, per the blueprint's "recall 硬门".
   */
  mustFind?: boolean;
}
