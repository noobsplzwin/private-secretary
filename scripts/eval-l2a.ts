#!/usr/bin/env -S npx tsx
// Run one L2A strategy over the frozen corpus and score it against the owner's
// adjudications.
//
//   npx tsx scripts/eval-l2a.ts --strategy s0
//
// Outputs:
//   eval/l2a-reports/scorecard-<strategy>-<date>.json  (counts only — committed)
//   eval/l2a-reports/detail-<strategy>-<date>.md       (quotes text — gitignored)

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadGroundTruth } from "../relay/eval/l2a-ground.js";
import { matchProposals, score } from "../relay/eval/l2a-match.js";
import type { EvalInput, FrozenPerson, L2AStrategy } from "../relay/eval/l2a.js";
import { s0Current } from "../relay/eval/strategies/s0-current.js";
import { s1Cfa } from "../relay/eval/strategies/s1-cfa.js";
import { createClaudeCliJsonCaller } from "../relay/proc/llm-claude-cli.js";

const argv = process.argv.slice(2);
const strategyName = argv.includes("--strategy") ? argv[argv.indexOf("--strategy") + 1]! : "s0";

const corpusDir = resolve(process.cwd(), "eval/l2a-corpus");
const reportDir = resolve(process.cwd(), "eval/l2a-reports");
mkdirSync(reportDir, { recursive: true });

// ── load frozen input ──
const manifest = JSON.parse(readFileSync(`${corpusDir}/MANIFEST.json`, "utf8")) as {
  frozenAt: string;
};
const persons: FrozenPerson[] = readdirSync(corpusDir)
  .filter((f) => f.endsWith(".json") && f !== "MANIFEST.json")
  .map((f) => JSON.parse(readFileSync(`${corpusDir}/${f}`, "utf8")) as FrozenPerson);
if (persons.length === 0) {
  console.error("no frozen corpus — run scripts/eval-l2a-freeze.ts first");
  process.exit(1);
}

const ground = loadGroundTruth(resolve(process.cwd(), "eval/ground-truth.yaml"));
const input: EvalInput = { frozenAt: manifest.frozenAt, matters: [], persons };

// ── strategy registry ──
const strategies: Record<string, () => L2AStrategy> = {
  s0: () => s0Current(createClaudeCliJsonCaller({ timeoutMs: 480_000 })),
  s1: () => s1Cfa(createClaudeCliJsonCaller({ timeoutMs: 480_000 })),
};
const make = strategies[strategyName];
if (!make) {
  console.error(`unknown strategy "${strategyName}" — known: ${Object.keys(strategies).join(", ")}`);
  process.exit(1);
}
const strategy = make();

console.log(`[bench] ${strategy.name} over ${persons.length} person(s), frozen ${manifest.frozenAt}`);
const t0 = Date.now();
const proposals = await strategy.propose(input);
const elapsed = Math.round((Date.now() - t0) / 1000);
console.log(`[bench] ${proposals.length} proposal(s) in ${elapsed}s`);

const match = matchProposals(proposals, ground);
const card = score(strategy.name, manifest.frozenAt, proposals, ground, match);

// ── reports ──
const stamp = new Date().toISOString().slice(0, 10);

// Raw proposals, so a later change to the matcher or to the ground truth can be
// re-scored offline instead of costing another 80-minute LLM run. (2026-08-25:
// tightening the hint rule stranded S0's card for exactly this reason.)
writeFileSync(
  `${reportDir}/proposals-${strategy.name}-${stamp}.json`,
  JSON.stringify({ strategy: strategy.name, frozenAt: manifest.frozenAt, proposals }, null, 2),
);

writeFileSync(
  `${reportDir}/scorecard-${strategy.name}-${stamp}.json`,
  JSON.stringify({ ...card, elapsedSeconds: elapsed, groundTruthSize: ground.length }, null, 2),
);

const byId = new Map(ground.map((g) => [g.id, g]));
const detail = [
  `# ${strategy.name} — ${stamp}(明细,含原文,勿提交)`,
  ``,
  `## 命中`,
  ...match.pairs.map((p) => {
    const g = byId.get(p.groundId)!;
    const pr = proposals[p.proposalIdx]!;
    return `- [${g.verdict}] ${g.id} ← 「${pr.title}」(score ${p.score.toFixed(2)})`;
  }),
  ``,
  `## 漏掉的 real`,
  ...card.misses.map((id) => `- ${id}: ${byId.get(id)!.title}${byId.get(id)!.mustFind ? "  ⚠️ mustFind" : ""}`),
  ``,
  `## 未匹配提案(需 owner 裁决 —— 可能是新真项,也可能是新垃圾)`,
  ...match.unmatchedProposals.map((i) => {
    const pr = proposals[i]!;
    return `- [${pr.personaKey}] ${pr.title}\n  依据: ${pr.evidence.join(" / ") || "(无)"}`;
  }),
].join("\n");
writeFileSync(`${reportDir}/detail-${strategy.name}-${stamp}.md`, detail);

// ── console scorecard ──
console.log(`
════ ${strategy.name} 记分卡 ════
提案数           ${card.proposals}
真阳性(TP)      ${card.truePositives} / ${ground.filter((g) => g.verdict === "real").length} real
复现已知错误      ${JSON.stringify(card.reproducedMistakes)}
未知提案(待裁决) ${card.unknown}
漏检(策略责任)  ${card.misses.length}  ${card.misses.join(", ")}
输入层漏检        ${card.inputMisses.length}  ${card.inputMisses.join(", ")}(发掘人的洞,所有策略共同的天花板)
硬门漏检          ${card.hardMisses.length > 0 ? `❌ FAIL: ${card.hardMisses.join(", ")}` : "✅ 0"}
precision(known) ${(card.precisionKnown * 100).toFixed(0)}%
recall           ${(card.recall * 100).toFixed(0)}%
明细: eval/l2a-reports/detail-${strategy.name}-${stamp}.md`);
