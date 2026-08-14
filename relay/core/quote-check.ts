// Is this quote actually IN the corpus? Pure core, no I/O.
//
// Several fields already ask the model for a verbatim quote as grounding —
// params.time_quote since it shipped, commitment evidence, ledger status
// transitions — and until now NOTHING checked one. An unchecked quote is
// decoration: the model can (and does) invent supporting text, which is
// precisely the failure the quote was meant to prevent. The owner's direction:
// the model does logical analysis, it does not create ("他只做逻辑分析，不会创造")
// — so grounding must be a mechanical check, not another instruction.
//
// Matching is deliberately forgiving about TRANSPORT, strict about CONTENT:
// whitespace runs collapse (thread text is reflowed constantly), case folds,
// and the typographic quote/dash variants normalize — but every content
// character must match, in order. No fuzzy matching: "close enough" is how an
// invented quote survives.

const PUNCT_MAP: Record<string, string> = {
  "‘": "'", "’": "'", "“": '"', "”": '"',
  "–": "-", "—": "-", "…": "...",
  "，": ",", "。": ".", "：": ":", "；": ";", "！": "!", "？": "?",
  "（": "(", "）": ")", "、": ",",
};

function fold(s: string): string {
  return s
    .replace(/[‘’“”–—…，。：；！？（）、]/g, (c) => PUNCT_MAP[c] ?? c)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True iff `quote` appears verbatim in `corpus`, up to whitespace, case and
 * typographic punctuation. Empty or blank quotes are NOT verbatim — an empty
 * string is "in" everything, which would make the check a no-op.
 */
export function hasVerbatim(corpus: string, quote: string): boolean {
  const q = fold(quote);
  if (q === "") return false;
  return fold(corpus).includes(q);
}

/**
 * Multi-quote evidence: the model often splices SEVERAL verbatim quotes with
 * "…", " / ", " — " or " | " — e.g. «Tomorrow I will have it ready / Or maybe
 * next Monday», both halves real, the concatenation nowhere. That is more
 * honest, not less, and a strict single-substring check rejected 4 of 4 real
 * commitments for one contact.
 *
 * So: split on the splice tokens and require EVERY substantial fragment to be
 * verbatim. One invented fragment still sinks the whole thing; fragments too
 * short to mean anything (< 5 chars folded) are ignored, and evidence with NO
 * substantial fragment fails.
 */
const SPLICE = /\s*(?:\.\.\.|…|\/|\||—|--)\s*/g;

export function evidenceGrounded(corpus: string, evidence: string): boolean {
  const fragments = evidence
    .split(SPLICE)
    .map((f) => f.replace(/^["'«»„"]+|["'«»„"]+$/g, "").trim())
    .filter((f) => f.replace(/\s+/g, "").length >= 5);
  if (fragments.length === 0) return false;
  return fragments.every((f) => hasVerbatim(corpus, f));
}
