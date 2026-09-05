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

import { resolve, join } from "node:path";
import { readdirSync } from "node:fs";
import { personaPath, readPersonaV3File } from "../relay/io/persona-store.js";
import { personCorpus, slackDmIndexes } from "../relay/io/person-corpus.js";
import { extractCommitmentsOnce } from "../relay/proc/persona-update.js";
import { createClaudeCliJsonCaller } from "../relay/proc/llm-claude-cli.js";

const argv = process.argv.slice(2);
const who = argv.includes("--person") ? argv[argv.indexOf("--person") + 1] : undefined;
const allOpen = argv.includes("--all-open");
if (!who && !allOpen) {
  console.error("usage: seed-commitments.ts --person key1,key2,…  |  --all-open");
  process.exit(1);
}
const personaDir = resolve(process.cwd(), "personas");
// Default model (pinned in llm-claude-cli) — the "opus" hardcode predated the switch.
// 480s, not the 180s default: six ledgers timed out repeatedly at 180s even
// with nothing else running — the same silent-timeout failure the consolidate
// pass hit, and a seed that dies quietly leaves a contact invisible.
const json = createClaudeCliJsonCaller({ timeoutMs: 480_000 });

// --all-open: every persona holding an open commitment, EITHER side. This is the
// backfill the list switchover needs — unassessed counts as NO, so until each
// of these gets a verdict the derived list renders nothing for them.
//
// 2026-09-05: this used to select who=me only, which was right when only
// who=me could carry a verdict. Now that a commitment they owe can also need
// Leo's time (the chase), a who=them-only ledger must be picked up too — those
// are exactly the 107 entries that had never been judged.
let keys: string[];
if (allOpen) {
  keys = readdirSync(personaDir)
    .filter((f) => f.endsWith(".yaml"))
    .flatMap((f) => {
      try {
        const p = readPersonaV3File(join(personaDir, f));
        const open = (p.commitments ?? []).some((c) => c.status === "open");
        return open ? [p.key] : [];
      } catch {
        return [];
      }
    });
  console.log(`--all-open: ${keys.length} persona(s) with open commitments (either side)`);
} else {
  keys = who!.split(",").map((s) => s.trim()).filter(Boolean);
}

const dms = await slackDmIndexes();
for (const key of keys) {
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
    // extractCommitmentsOnce swallows its own error; at least say the call died.
    console.log(`  LLM/read failed (see stderr above if any) — rerun this key`);
    continue;
  }
  console.log(`  added ${r.added}, statusChanged ${r.statusChanged}, assessed ${r.assessed}, discarded ${r.discarded} ungrounded`);
}
