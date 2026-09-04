// The corpus, read as LINES — the mechanical half of the commitment gates.
//
// specs/commitment-brain.md §2-3 and the L2A bench's S1 strategy: the model is
// asked ONE thing (what does this utterance commit), and every structural fact
// is read off the corpus instead of trusted to the answer:
//
//   who spoke   → the line's own speaker label (never the model's claim)
//   when        → the line's own date
//   hedged      → the wording of the quote
//   closed      → a later line by the same speaker declaring it done
//
// The bench measured why this matters: the production path, asked five
// judgments at once, reproduced 5 of the owner's known-bad items and scored
// ~29% precision; the same corpus with these gates in front scored 80%.
//
// Pure. No I/O, no LLM.

export type Speaker = "me" | "them" | "unknown";

export interface CorpusLine {
  /** YYYY-MM-DD from the line's own prefix, or null when it carries none. */
  date: string | null;
  speaker: Speaker;
  text: string;
}

// `[2026-08-20 10:00] 名字: text` and `[2026-08-20] Uxxxx: text` both match;
// the speaker label is capped so a prose line containing a colon is not
// mistaken for a speaker turn.
const LINE = /^\[(\d{4}-\d{2}-\d{2})[^\]]*\]\s*([^:]{1,40}):\s*(.*)$/;

/**
 * Index every line. A line with no `[date] speaker:` prefix — a Gmail body
 * line, a slice header — is speaker "unknown": attributable to nobody. That is
 * a real state, not a defect, and the gates below decline to act on it rather
 * than guessing.
 */
export function indexCorpus(corpus: string): CorpusLine[] {
  return corpus.split("\n").map((raw) => {
    const m = LINE.exec(raw.trim());
    if (!m) return { date: null, speaker: "unknown" as Speaker, text: raw };
    const who = m[2]!.trim().toLowerCase();
    return { date: m[1]!, speaker: who === "me" ? "me" : ("them" as Speaker), text: raw };
  });
}

const fold = (s: string): string => s.toLowerCase().replace(/\s+/g, "");

/**
 * The single line containing this quote, or null.
 *
 * A quote that spans lines resolves to nothing: it was stitched together, so
 * no one line said it and no speaker or date can be claimed for it.
 */
export function lineOf(lines: readonly CorpusLine[], quote: string): CorpusLine | null {
  const q = fold(quote);
  // CJK carries far more per character — 「发你了」 is a complete closure
  // utterance in three. Latin needs more before a match means anything.
  const min = /[一-鿿]/.test(q) ? 2 : 4;
  if (q.length < min) return null;
  return lines.find((l) => fold(l.text).includes(q)) ?? null;
}

/**
 * In Chinese these are softened REFUSALS, not agreements — the owner's own
 * ruling on 「这个根本不需要创建ticket，这就是考虑一下」. English hedges sit
 * alongside them because the failure is identical.
 */
const HEDGES = [
  "我看看", "看看吧", "再看", "考虑一下", "考虑下", "想一下", "想想",
  "应该可以", "应该能", "尽量", "回头", "有空", "抽空", "试试", "研究一下", "琢磨",
  "maybe", "i'll think", "let me think", "we'll see", "probably", "at some point",
  "if i get a chance", "try to",
];

/** A hedge never mints an obligation, whatever the model called it. */
export function isHedged(quote: string): boolean {
  const q = quote.toLowerCase();
  return HEDGES.some((h) => q.includes(h));
}

const DONE_WORDS =
  /发你了|发了|寄了|搞定|弄完|做完|已经好|完成了|办好了|已下单|订好了|已付|付了|sent it|already sent|done|shipped|ordered it|paid/;

/**
 * Did the performer later declare this finished?
 *
 * Evidence: a line AFTER the committing one, spoken by the SAME side, carrying
 * a completion word and either sharing a content token with the commitment or
 * sitting close behind it in the same stretch of talk. Terse Chinese
 * confirmations rarely repeat the subject — 「发你了」 names nothing — so
 * proximity is the second accepted signal.
 */
export function closedLater(
  lines: readonly CorpusLine[],
  commitLine: CorpusLine,
  what: string,
  proximity = 5,
): boolean {
  const at = lines.indexOf(commitLine);
  if (at < 0 || !commitLine.date) return false;
  const tokens = new Set(fold(what).match(/[a-z0-9]{3,}|[一-鿿]{2}/g) ?? []);
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.speaker !== commitLine.speaker) continue;
    if (!l.date || l.date < commitLine.date) continue;
    if (!DONE_WORDS.test(l.text)) continue;
    const t = fold(l.text);
    if ([...tokens].some((tok) => t.includes(tok))) return true;
    if (i - at <= proximity) return true;
  }
  return false;
}

/** Days between a line's date and now — Infinity when the line has no date. */
export function ageInDays(line: CorpusLine, nowMs: number): number {
  if (!line.date) return Infinity;
  const t = Date.parse(`${line.date}T00:00:00Z`);
  if (Number.isNaN(t)) return Infinity;
  return (nowMs - t) / 86_400_000;
}

/**
 * How old a line may be and still MINT new work. Past it a conversation is
 * history: it can close or re-assess something already tracked, but it cannot
 * invent a fresh obligation. Two of the owner's verdicts on the first generated
 * list were simply 「很久以前」 — trips already taken, resurfaced as to-dos.
 */
export const MINT_WINDOW_DAYS = 14;

/**
 * May this extraction mint a commitment? THE one implementation — production
 * (proc/persona-update.ts) and the bench's S0 strategy both call it, because a
 * gate the bench cannot see is a gate the bench cannot score. The 2026-09-04
 * S0 re-run measured no change for exactly that reason: the gates existed only
 * on the production orchestrator, which the bench never enters.
 *
 * Refuses only on a POSITIVE reading:
 *   - a who=me promise sitting in THEIR line (the arrow is reversed)
 *   - a dated line older than the mint window
 *   - a who=me promise whose line hedges (「考虑一下」 is a softened no)
 *
 * Evidence resolving to no single line, or to a line with no speaker (a Gmail
 * body line), passes: declining to act beats guessing, and guessing here
 * deletes real commitments.
 */
export function mintable(
  lines: readonly CorpusLine[],
  c: { who?: string; evidence?: string },
  nowMs: number,
  windowDays: number = MINT_WINDOW_DAYS,
): boolean {
  const line = lineOf(lines, c.evidence ?? "");
  if (!line) return true;
  if (c.who === "me" && line.speaker === "them") return false;
  if (line.speaker !== "unknown" && ageInDays(line, nowMs) > windowDays) return false;
  if (c.who === "me" && isHedged(line.text)) return false;
  return true;
}
