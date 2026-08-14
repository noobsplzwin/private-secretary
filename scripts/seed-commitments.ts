#!/usr/bin/env -S npx tsx
// Seed the commitment ledger for named personas from their fresh cross-source
// corpus — the one-off for contacts who were INVISIBLE until their handles were
// filled in (the OSYX Portugal team: rich profiles, zero commitments, because
// resolvePersona could never attribute their messages).
//
//   npx tsx scripts/seed-commitments.ts --person key1,key2,…
//
// Same machinery as the tick pass (extractCommitmentsOnce): same prompt, same
// quote gate, same R1 chokepoint — a seed is just a first tick for someone the
// ticks always skipped.

import { resolve } from "node:path";
import { personaPath, readPersonaV3File } from "../relay/io/persona-store.js";
import { personCorpus, slackDmIndexes } from "../relay/io/person-corpus.js";
import { extractCommitmentsOnce } from "../relay/proc/persona-update.js";
import { createClaudeCliJsonCaller } from "../relay/proc/llm-claude-cli.js";

const argv = process.argv.slice(2);
const who = argv.includes("--person") ? argv[argv.indexOf("--person") + 1] : undefined;
if (!who) {
  console.error('usage: seed-commitments.ts --person key1,key2,…');
  process.exit(1);
}
const personaDir = resolve(process.cwd(), "personas");
const json = createClaudeCliJsonCaller({ model: "opus" });

const dms = await slackDmIndexes();
for (const key of who.split(",").map((s) => s.trim()).filter(Boolean)) {
  const file = personaPath(personaDir, key);
  let p;
  try {
    p = readPersonaV3File(file);
  } catch (e) {
    console.error(`${key}: unreadable — ${(e as Error).message.split("\n")[0]}`);
    continue;
  }
  const corpus = await personCorpus(
    { slack: p.handles?.slack, gmail: p.handles?.gmail, wechat: p.handles?.wechat },
    dms,
  );
  if (!corpus.trim()) {
    console.log(`${key}: no corpus reachable — check handles`);
    continue;
  }
  console.log(`${key}: corpus ${Math.round(corpus.length / 1000)}k …`);
  const r = await extractCommitmentsOnce({
    file,
    displayName: p.display_name ?? key,
    corpus,
    json,
  });
  if (!r) {
    console.log(`  LLM/read failed`);
    continue;
  }
  console.log(`  added ${r.added}, statusChanged ${r.statusChanged}, discarded ${r.discarded} ungrounded`);
}
