// The scorecard that makes a judge trustworthy — or refuses to.
//
// WHY THIS IS THE FIRST PIECE. A judge constrained by written rules is not
// constrained at all: the drafter prompt already says "Do NOT emit a card
// asking Leo to look at, open, or listen to these" and the model emitted four
// such cards anyway, all four thrown away by the owner the same week. An
// instruction a model can ignore is not a control. A score it cannot argue with
// is. So nothing a judge says is allowed to matter until it has been measured
// against verdicts the OWNER gave.
//
// WHY BALANCED ACCURACY, NOT ACCURACY. The owner's verdicts are lopsided and
// will stay lopsided — most rows are noise. Measured: the mined golden set is
// 131 negative / 4 positive, where a judge that blindly answers `not_a_thing`
// every time scores 97%. Plain accuracy would call that judge excellent. Mean
// per-class recall calls it 50%, which is what a coin is worth. That single
// choice is the difference between a scoreboard and a mirror.
//
// This file knows nothing about models, prompts or I/O on purpose: it is the
// one part of the loop that must stay impossible to talk around.

/** The two verdicts the owner can give for free, via TickTick. */
export type Verdict = "not_a_thing" | "confirmed";

export const VERDICTS: readonly Verdict[] = ["not_a_thing", "confirmed"];

export interface ScoredPair {
  actionId: string;
  /** What the owner said — ground truth. */
  owner: Verdict;
  /** What the judge said. `null` when it could not or would not answer. */
  judge: Verdict | null;
}

export interface ClassScore {
  /** How many owner-labelled rows of this class exist. */
  n: number;
  /** How many the judge answered at all. */
  answered: number;
  /** Of the answered ones, the share the judge got right. */
  recall: number;
}

export interface Scorecard {
  pairs: number;
  answered: number;
  abstained: number;
  /** Share of ANSWERED pairs the judge got right. Kept for reference only. */
  agreement: number;
  perClass: Record<Verdict, ClassScore>;
  /** Mean of per-class recall. THE number. Immune to the class imbalance. */
  balanced: number;
  /** What a judge that always answers the commonest class would score here. */
  majorityBaseline: number;
  /** The judge answered (nearly) one class for everything — a mirror, not a judge. */
  degenerate: boolean;
  /** Enough labels of BOTH classes for any of this to mean anything. */
  enoughData: boolean;
  /** Only when it has enough data, is not degenerate, and clears the floor. */
  trustworthy: boolean;
  /** Plain words, so a number can never be read as more than it is. */
  note: string;
}

/**
 * Per class, because a judge is only useful if it can say BOTH things. Fewer
 * than this and a single lucky row moves the score by five points.
 */
export const MIN_PER_CLASS = 20;

/**
 * A coin scores 0.5 balanced. A judge allowed to retire rows on its own has to
 * be far enough above chance that its mistakes are rarer than the noise it
 * removes; 0.8 is that line, and it is deliberately hard.
 */
export const BALANCED_FLOOR = 0.8;

// ── reading the owner's verdicts out of the label ledger ───────────────
//
// Narrow shape on purpose: core must not import the io/labels record, and the
// scorer must not care where a verdict came from.
export interface LabelLike {
  action_id: string;
  existence: string | null;
  decided_at: string | null;
}

/**
 * Ground truth, keyed by action. ONLY the two verdicts the owner gives himself
 * count — `superseded` and `pruned` are bookkeeping the engine writes about
 * itself (628 and 153 of them in the real ledger), and scoring against those
 * would be the judge grading its own paperwork.
 *
 * A row can be labelled more than once; the LATEST decision wins, because the
 * owner is allowed to change his mind and the newest gesture is the real one.
 */
export function ownerVerdicts(labels: readonly LabelLike[]): Map<string, Verdict> {
  const at = new Map<string, string>();
  const out = new Map<string, Verdict>();
  for (const l of labels) {
    if (l.existence !== "not_a_thing" && l.existence !== "confirmed") continue;
    const when = l.decided_at ?? "";
    const seen = at.get(l.action_id);
    if (seen !== undefined && seen > when) continue;
    at.set(l.action_id, when);
    out.set(l.action_id, l.existence);
  }
  return out;
}

/** Answering one class for ≥95% of rows is a mirror however well it scores. */
const DEGENERATE_SHARE = 0.95;

export function scoreJudge(pairs: readonly ScoredPair[]): Scorecard {
  const answered = pairs.filter((p) => p.judge !== null);

  const perClass = {} as Record<Verdict, ClassScore>;
  for (const v of VERDICTS) {
    const mine = pairs.filter((p) => p.owner === v);
    const said = mine.filter((p) => p.judge !== null);
    const right = said.filter((p) => p.judge === p.owner).length;
    perClass[v] = {
      n: mine.length,
      answered: said.length,
      recall: said.length === 0 ? 0 : right / said.length,
    };
  }

  const agreement =
    answered.length === 0 ? 0 : answered.filter((p) => p.judge === p.owner).length / answered.length;
  const balanced = VERDICTS.reduce((s, v) => s + perClass[v].recall, 0) / VERDICTS.length;

  // What the lazy answer is worth here, stated so the real score can be read
  // against it rather than against 0.
  const biggest = Math.max(...VERDICTS.map((v) => perClass[v].n));
  const majorityBaseline = pairs.length === 0 ? 0 : biggest / pairs.length;

  const degenerate =
    answered.length > 0 &&
    VERDICTS.some((v) => answered.filter((p) => p.judge === v).length / answered.length >= DEGENERATE_SHARE);

  const enoughData = VERDICTS.every((v) => perClass[v].n >= MIN_PER_CLASS);
  const trustworthy = enoughData && !degenerate && balanced >= BALANCED_FLOOR;

  return {
    pairs: pairs.length,
    answered: answered.length,
    abstained: pairs.length - answered.length,
    agreement,
    perClass,
    balanced,
    majorityBaseline,
    degenerate,
    enoughData,
    trustworthy,
    note: noteFor({ enoughData, degenerate, balanced, perClass, trustworthy }),
  };
}

function noteFor(s: {
  enoughData: boolean;
  degenerate: boolean;
  balanced: number;
  perClass: Record<Verdict, ClassScore>;
  trustworthy: boolean;
}): string {
  // Composed, never either/or: "the judge is a mirror" and "there is too little
  // data to say" are both true at once in exactly the case that matters most
  // (131 negative / 4 positive), and dropping either one loses something real.
  // Degeneracy leads because it is a statement about the JUDGE — the data being
  // thin does not excuse a judge that never says the other word.
  const flags: string[] = [];
  if (s.degenerate)
    flags.push(
      "DEGENERATE: the judge answers one class for nearly everything. It is echoing the class balance, not judging.",
    );
  if (!s.enoughData) {
    const short = VERDICTS.filter((v) => s.perClass[v].n < MIN_PER_CLASS).map(
      (v) => `${v} ${s.perClass[v].n}/${MIN_PER_CLASS}`,
    );
    flags.push(
      `NOT ENOUGH DATA (${short.join(", ")}). The number below is a pipeline check, not a measurement — do not act on it.`,
    );
  }
  if (flags.length === 0 && !s.trustworthy)
    flags.push(`BELOW THE FLOOR (${s.balanced.toFixed(2)} < ${BALANCED_FLOOR}). Its verdicts stay observational.`);
  if (flags.length === 0)
    flags.push(
      "Clears the floor on both classes. Its verdicts are worth reading; whether they may CHANGE anything is the owner's call, not this file's.",
    );
  return flags.join(" ");
}

/** One-screen summary. Leads with the caveat, because the caveat is the point. */
export function renderScorecard(s: Scorecard): string {
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const lines = [
    s.note,
    "",
    `样本 ${s.pairs} 条（裁判作答 ${s.answered}，弃权 ${s.abstained}）`,
    ...VERDICTS.map(
      (v) => `  ${v.padEnd(12)} n=${String(s.perClass[v].n).padStart(3)}  召回 ${pct(s.perClass[v].recall)}`,
    ),
    "",
    `平衡准确率 ${pct(s.balanced)}   ← 这个数说了算`,
    `多数类基线 ${pct(s.majorityBaseline)}   ← 闭眼全判一类能拿到的分`,
    `原始一致率 ${pct(s.agreement)}   ← 仅供参考，类别不均时会骗人`,
    "",
    s.trustworthy ? "可信：是" : "可信：否",
  ];
  return lines.join("\n");
}
