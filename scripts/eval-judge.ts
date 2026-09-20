// npm run eval — score a judge against the owner's own verdicts.
//
// The judge itself is not written yet. That is deliberate: the scoreboard comes
// first, because a judge built before its scoreboard is a judge nobody can
// contradict. Until one exists, this runs the BASELINE judge — the one that
// answers whichever class is commonest, every time — so the harness can be seen
// catching the exact failure it was built for.
//
// Run: npm run eval [-- --state state/loop-state.json]

import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import {
  ownerVerdicts,
  scoreJudge,
  renderScorecard,
  VERDICTS,
  MIN_PER_CLASS,
  type LabelLike,
  type ScoredPair,
  type Verdict,
} from "../relay/core/judge-score.js";

const arg = (flag: string, fallback: string): string => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

const statePath = resolve(arg("--state", join(process.cwd(), "state", "loop-state.json")));
const labelsPath = join(dirname(statePath), "labels.jsonl");

function readLabels(file: string): LabelLike[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    console.error(`no label ledger at ${file} — nothing to score yet.`);
    process.exit(1);
  }
  const out: LabelLike[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    try {
      const r = JSON.parse(t) as LabelLike & { note?: string };
      out.push(r);
    } catch {
      // A truncated last line is normal while the daemon is appending.
    }
  }
  return out;
}

const labels = readLabels(labelsPath);
const truth = ownerVerdicts(labels);

// THE BASELINE. Not a strawman — it is the judge you get for free by learning
// nothing, and every real judge has to beat it to have earned its keep.
const tally = new Map<Verdict, number>(VERDICTS.map((v) => [v, 0]));
for (const v of truth.values()) tally.set(v, (tally.get(v) ?? 0) + 1);
const majority = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "not_a_thing";

const pairs: ScoredPair[] = [...truth.entries()].map(([actionId, owner]) => ({
  actionId,
  owner,
  judge: majority,
}));

const card = scoreJudge(pairs);

console.log("");
console.log("═══ 裁判成绩单 ═══");
console.log(`裁判：BASELINE（闭眼全判 "${majority}"）— 真裁判尚未实现`);
console.log("");
console.log(renderScorecard(card));
console.log("");
console.log("─── 标签库存 ───");
for (const v of VERDICTS) {
  const n = card.perClass[v].n;
  const need = Math.max(0, MIN_PER_CLASS - n);
  console.log(`  ${v.padEnd(12)} ${String(n).padStart(3)} 条${need > 0 ? `   还差 ${need} 条才够用` : "   够了"}`);
}
console.log("");
console.log(
  card.trustworthy
    ? "基线居然通过了门槛 —— 那是门槛错了，不是基线对了。去看 judge-score.ts。"
    : "基线没通过门槛。这正是这块记分牌该有的行为。",
);
console.log("");
