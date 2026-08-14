import { describe, expect, it } from "vitest";
import { hasVerbatim } from "./quote-check.js";

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
