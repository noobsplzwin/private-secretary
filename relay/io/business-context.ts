// The owner's business facts, injected into the drafting prompt so the model can
// ground business claims instead of inventing them ("who is a customer vs a
// partner", "what stage is the company at", "which product is which").
//
// WHY THIS IS A FILE AND NOT CODE: these facts are per-user AND commercially
// sensitive — company positioning, funding stage, deal directions. Hard-coding
// one person's facts means anyone who runs this engine ships those facts, and
// their model would ground its analysis in someone else's company. So the file
// is gitignored and `config/business-context.example.md` shows the shape.
//
// With no config the drafting prompt drops the block and instead forbids
// asserting ANY unsourced business fact. That is the safe default: a model with
// no business grounding is cautious; a model with the WRONG grounding is
// confidently wrong, which is this project's worst failure mode.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let cached: string | null | undefined;

export function loadBusinessContext(): string | null {
  if (cached !== undefined) return cached;
  const explicit = process.env.SECRETARY_BUSINESS_CONTEXT?.trim();
  const path = explicit || join(process.cwd(), "config", "business-context.md");
  if (!existsSync(path)) {
    cached = null;
    return cached;
  }
  const text = readFileSync(path, "utf8")
    .split("\n")
    // Drop markdown headings and comment lines so the block reads as plain
    // grounding bullets inside the system prompt.
    .filter((l) => !l.trimStart().startsWith("#") && !l.trimStart().startsWith("<!--"))
    .join("\n")
    .trim();
  cached = text === "" ? null : text;
  return cached;
}

