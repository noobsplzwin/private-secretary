#!/usr/bin/env -S npx tsx
// Freeze the L2A bench corpus: snapshot each bench person's cross-source
// corpus (the SAME reader production uses) and their ledger commitments into
// eval/l2a-corpus/. Run ONCE; every strategy then replays the same bytes.
//
//   npx tsx scripts/eval-l2a-freeze.ts --person key1,key2,…
//   npx tsx scripts/eval-l2a-freeze.ts --from-ground-truth   # concrete keys in the truth set
//
// The freeze costs source-API calls (no LLM). Output is gitignored: real chat.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { personCorpus, slackDmIndexes } from "../relay/io/person-corpus.js";
import { personaPath, readPersonaV3File } from "../relay/io/persona-store.js";
import { loadGroundTruth } from "../relay/eval/l2a-ground.js";

const argv = process.argv.slice(2);
const personaDir = resolve(process.cwd(), "personas");
const outDir = resolve(process.cwd(), "eval/l2a-corpus");

let keys: string[];
if (argv.includes("--from-ground-truth")) {
  const gt = loadGroundTruth(resolve(process.cwd(), "eval/ground-truth.yaml"));
  keys = [...new Set(gt.map((g) => g.personaKey).filter((k) => k !== "*"))];
} else {
  const who = argv.includes("--person") ? argv[argv.indexOf("--person") + 1] : "";
  keys = (who ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
if (keys.length === 0) {
  console.error("usage: eval-l2a-freeze.ts --person key1,key2,… | --from-ground-truth");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const dms = await slackDmIndexes();
const manifest: Array<{ personaKey: string; displayName: string; corpusChars: number; ledgerCount: number }> = [];

for (const key of keys) {
  let p;
  try {
    p = readPersonaV3File(personaPath(personaDir, key));
  } catch (e) {
    console.error(`${key}: unreadable persona — ${(e as Error).message.split("\n")[0]}`);
    continue;
  }
  const corpus = await personCorpus(
    { slack: p.handles?.slack, gmail: p.handles?.gmail, wechat: p.handles?.wechat },
    dms,
  );
  const ledger = (p.commitments ?? []).map((c) => ({
    who: c.who,
    what: c.what,
    status: c.status,
    ...(c.due ? { due: c.due } : {}),
    ...(c.matter_id ? { matter_id: c.matter_id } : {}),
    // The VERDICT rides along. It is what promotes a commitment onto the
    // working list, so a snapshot without it is a ledger with no memory —
    // dropping it scored the 2026-09-07 run at 0% on 28 verdicts that existed.
    ...(c.assessment ? { assessment: c.assessment } : {}),
  }));
  writeFileSync(
    `${outDir}/${key}.json`,
    JSON.stringify(
      { personaKey: key, displayName: p.display_name ?? key, corpus, ledger },
      null,
      1,
    ),
  );
  manifest.push({
    personaKey: key,
    displayName: p.display_name ?? key,
    corpusChars: corpus.length,
    ledgerCount: ledger.length,
  });
  console.log(`${key}: corpus ${Math.round(corpus.length / 1000)}k, ledger ${ledger.length}`);
}

writeFileSync(
  `${outDir}/MANIFEST.json`,
  JSON.stringify({ frozenAt: new Date().toISOString(), persons: manifest }, null, 1),
);
console.log(`\nfrozen ${manifest.length}/${keys.length} person(s) → ${outDir}`);
