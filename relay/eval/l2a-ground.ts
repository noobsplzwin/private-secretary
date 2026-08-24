// Ground truth loader. The YAML lives in eval/ground-truth.yaml (gitignored —
// real names) and is validated hard on load: a malformed truth set silently
// mis-scoring every strategy would be the bench lying about itself.

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { GroundTruthItem, GroundVerdict } from "./l2a.js";

const VERDICTS: GroundVerdict[] = ["real", "not_mine", "stale", "invented_detail", "too_granular", "wrong_action"];

export function loadGroundTruth(path: string): GroundTruthItem[] {
  const raw = parse(readFileSync(path, "utf8")) as { items?: unknown[] };
  if (!Array.isArray(raw.items) || raw.items.length === 0)
    throw new Error(`ground truth: no items in ${path}`);
  const seen = new Set<string>();
  return raw.items.map((x, i) => {
    const it = x as Partial<GroundTruthItem>;
    if (!it.id || seen.has(it.id)) throw new Error(`ground truth[${i}]: missing/duplicate id`);
    seen.add(it.id);
    if (!it.personaKey) throw new Error(`${it.id}: missing personaKey`);
    if (!it.title?.trim()) throw new Error(`${it.id}: missing title`);
    if (!VERDICTS.includes(it.verdict as GroundVerdict))
      throw new Error(`${it.id}: bad verdict "${String(it.verdict)}"`);
    if (it.mustFind && it.verdict !== "real")
      throw new Error(`${it.id}: mustFind only applies to real items`);
    return it as GroundTruthItem;
  });
}
