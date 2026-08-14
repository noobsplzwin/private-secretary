import { describe, expect, it } from "vitest";
import { evidenceGrounded, hasVerbatim } from "./quote-check.js";

const CORPUS = `[2026-07-30] From Yang:
Please find attached the production and processing agreement — signed and
returned to us today. 温总说：周日发货，没问题。`;

describe("hasVerbatim", () => {
  it("finds an exact quote", () => {
    expect(hasVerbatim(CORPUS, "signed and returned to us today")).toBe(true);
  });

  // Thread text is reflowed constantly; the corpus has this across a newline.
  it("is forgiving about whitespace and case", () => {
    expect(hasVerbatim(CORPUS, "Signed And   Returned to us")).toBe(true);
  });

  it("folds typographic punctuation both ways", () => {
    expect(hasVerbatim(CORPUS, "agreement - signed")).toBe(true); // — vs -
    expect(hasVerbatim(CORPUS, "温总说:周日发货,没问题.")).toBe(true); // ASCII vs CJK punct
  });

  // The failure this exists to catch: supporting text that is simply not there.
  it("rejects an invented quote", () => {
    expect(hasVerbatim(CORPUS, "the factory confirmed the countersign")).toBe(false);
  });

  it("rejects a near-miss with different content", () => {
    expect(hasVerbatim(CORPUS, "signed and returned to you today")).toBe(false);
  });

  // An empty string is "in" everything, which would make the check a no-op.
  it("rejects empty and blank quotes", () => {
    expect(hasVerbatim(CORPUS, "")).toBe(false);
    expect(hasVerbatim(CORPUS, "   ")).toBe(false);
  });
});

describe("evidenceGrounded", () => {
  const C = `[2026-08-13] U08020UEM4J: Tomorrow I will have it ready
[2026-08-13] U08020UEM4J: Or maybe next Monday since I just want to study a little bit
[2026-08-13] U08020UEM4J: So please don't share it with Chu until I confirm that everything is correct
[2026-08-13] me: For sure`;

  // The real case: 4 of 4 genuine commitments were rejected because the model
  // spliced multiple verbatim quotes into one evidence string.
  it("accepts spliced quotes when every fragment is verbatim", () => {
    expect(evidenceGrounded(C, "Tomorrow I will have it ready / Or maybe next Monday since I just want to study")).toBe(true);
    expect(evidenceGrounded(C, '"…until I confirm that everything is correct" — "For sure"')).toBe(true);
  });

  it("rejects a splice with one invented fragment", () => {
    expect(evidenceGrounded(C, "Tomorrow I will have it ready / the factory has countersigned")).toBe(false);
  });

  it("rejects evidence with no substantial fragment", () => {
    expect(evidenceGrounded(C, '" / "')).toBe(false);
    expect(evidenceGrounded(C, "")).toBe(false);
  });

  it("still accepts a plain single quote", () => {
    expect(evidenceGrounded(C, "So please don't share it with Chu")).toBe(true);
  });
});
