#!/usr/bin/env -S npx tsx
// One-off ledger audit — the cleanup the first shadow diff demanded
// ("89 derived | 10 real | 0 matched"). Re-adjudicates every OPEN who=me
// commitment against the person's fresh cross-source corpus.
//
//   npx tsx scripts/audit-ledger.ts [--person <key>] [--max N] [--dry-run]
//   npx tsx scripts/audit-ledger.ts --drop "<key>:<idx>,<idx> <key>:<idx>"
//
// done    → auto-applied, but ONLY through the verbatim-quote gate.
// dropped → PROPOSED, printed for the owner; nothing is written until he
//           confirms with --drop. Silence has no quote, so a drop can never
//           self-certify (ASK-not-GUESS).
//
// The corpus here is assembled BY HANDLE (gmail query, wechat history, slack
// DM lookup) — unlike run-notify's fetchAllForPerson it needs no open card, so
// it can audit a persona with no live traffic at all. The two builders should
// merge when phase 4 of specs/person-first-consolidation.md lands.

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { personCorpus, slackDmIndexes } from "../relay/io/person-corpus.js";
import { personaPath, readPersonaV3File, writePersonaFile } from "../relay/io/persona-store.js";
import { createClaudeCliJsonCaller } from "../relay/proc/llm-claude-cli.js";
import { buildLedgerAuditRequest, parseAuditVerdicts } from "../relay/proc/ledger-audit-prompt.js";
import { hasVerbatim } from "../relay/core/quote-check.js";
import type { Commitment } from "../relay/core/persona-v3.js";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const onlyPerson = argv.includes("--person") ? argv[argv.indexOf("--person") + 1] : undefined;
const maxPersons = argv.includes("--max") ? Number(argv[argv.indexOf("--max") + 1]) : Infinity;
const dropArg = argv.includes("--drop") ? argv[argv.indexOf("--drop") + 1] : undefined;
const personaDir = resolve(process.cwd(), "personas");

function openMine(cs: Commitment[]): Array<{ index: number; c: Commitment }> {
  return cs.map((c, index) => ({ index, c })).filter(({ c }) => c.who === "me" && c.status === "open");
}

// ── --drop mode: apply owner-confirmed drops, then exit ────────────────────
if (dropArg) {
  for (const part of dropArg.split(/\s+/).filter(Boolean)) {
    const [key, idxs] = part.split(":");
    if (!key || !idxs) {
      console.error(`bad --drop token: ${part} (want key:1,2,3)`);
      process.exit(1);
    }
    const file = personaPath(personaDir, key);
    const cs = (readPersonaV3File(file).commitments ?? []).map((c) => ({ ...c }));
    let n = 0;
    for (const i of idxs.split(",").map(Number)) {
      const c = cs[i];
      if (!c || c.who !== "me" || c.status !== "open") {
        console.error(`  ${key}#${i}: not an open who=me commitment — skipped`);
        continue;
      }
      c.status = "dropped";
      n++;
    }
    if (n > 0) {
      writePersonaFile(
        file,
        { set: { commitments: cs }, evidence: { commitments: "owner-confirmed ledger audit drop" } },
        // The OWNER confirmed each index — this is his edit, not an inference.
        "human",
      );
    }
    console.log(`${key}: dropped ${n}`);
  }
  process.exit(0);
}

// ── audit mode ──────────────────────────────────────────────────────────────
// Corpus assembly lives in relay/io/person-corpus.ts (shared with the
// commitment seeding script).

async function main(): Promise<void> {
  const json = createClaudeCliJsonCaller({ model: "opus" });
  const today = new Date().toISOString().slice(0, 10);

  const files = readdirSync(personaDir).filter((f) => f.endsWith(".yaml"));
  const targets: Array<{ key: string; file: string; open: ReturnType<typeof openMine> }> = [];
  for (const f of files) {
    try {
      const p = readPersonaV3File(join(personaDir, f));
      if (onlyPerson && p.key !== onlyPerson) continue;
      const open = openMine(p.commitments ?? []);
      if (open.length > 0) targets.push({ key: p.key, file: join(personaDir, f), open });
    } catch {
      /* unreadable persona */
    }
  }
  targets.sort((a, b) => b.open.length - a.open.length);
  console.log(`${targets.length} persona(s) with open who=me commitments`);

  const dms = await slackDmIndexes();
  let audited = 0;
  const proposals: string[] = [];

  for (const t of targets.slice(0, maxPersons)) {
    const p = readPersonaV3File(t.file);
    const corpus = await personCorpus(
      { slack: p.handles?.slack, gmail: p.handles?.gmail, wechat: p.handles?.wechat },
      dms,
    );
    if (!corpus.trim()) {
      console.log(`\n${t.key}: no corpus reachable (${t.open.length} open) — skipped`);
      continue;
    }
    audited++;
    console.log(`\n=== ${t.key} (${t.open.length} open, corpus ${Math.round(corpus.length / 1000)}k) ===`);

    let verdicts;
    try {
      const raw = await json(
        buildLedgerAuditRequest({ name: p.display_name ?? t.key, today, open: t.open, corpus }),
      );
      verdicts = parseAuditVerdicts(raw, new Set(t.open.map((o) => o.index)));
    } catch (e) {
      console.error(`  LLM failed: ${(e as Error).message.split("\n")[0]}`);
      continue;
    }

    const cs = (p.commitments ?? []).map((c) => ({ ...c }));
    let dones = 0;
    let ungrounded = 0;
    for (const v of verdicts) {
      const c = cs[v.index]!;
      if (v.verdict === "done") {
        // The gate: a done that cannot quote the corpus is not a done.
        if (hasVerbatim(corpus, v.evidence)) {
          c.status = "done";
          dones++;
          console.log(`  ✓ done   #${v.index} ${c.what.slice(0, 64)}`);
          console.log(`           “${v.evidence.slice(0, 76)}”`);
        } else {
          ungrounded++;
          console.log(`  ✗ REJECTED done (quote not in corpus) #${v.index} ${c.what.slice(0, 52)}`);
        }
      } else if (v.verdict === "dropped") {
        proposals.push(`${t.key}:${v.index}  ${c.what.slice(0, 70)}\n    理由: ${v.evidence.slice(0, 90)}`);
      }
    }
    if (dones > 0 && !dryRun) {
      writePersonaFile(
        t.file,
        { set: { commitments: cs }, evidence: { commitments: "ledger audit: quote-verified done" } },
        "llm",
      );
    }
    console.log(`  applied ${dryRun ? 0 : dones} done(s), rejected ${ungrounded} ungrounded, proposed ${verdicts.filter((v) => v.verdict === "dropped").length} drop(s)`);
  }

  if (proposals.length > 0) {
    console.log(`\n──── PROPOSED DROPS (nothing written — confirm with --drop "key:idx,idx …") ────`);
    for (const line of proposals) console.log(line);
  }
  console.log(`\naudited ${audited} persona(s).`);
}

main().catch((e) => {
  console.error("audit crashed:", (e as Error).message);
  process.exit(1);
});
