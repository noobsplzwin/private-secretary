#!/usr/bin/env -S npx tsx
// Ticket quality bench: can the brain read a thread and produce a ticket the
// assignee can act on without going back to Slack?
//
// Runs the PRODUCTION draft path (proc/draft.ts + the real prompt). No copy of
// the pipeline lives here — the 2026-09-04 lesson was that a bench scoring its
// own reimplementation scores nothing.
//
// Approximation worth naming: the frozen thread is replayed as one inbound
// message per line, each carrying its original speaker label, so the model sees
// the exchange in order. Production feeds the draft pass inbound messages plus
// persona context; this is close but not identical.
//
//   npx tsx scripts/eval-ticket.ts

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { draftActions } from "../relay/proc/draft.js";
import { createClaudeCliLlmCaller } from "../relay/proc/llm-claude-cli.js";
import { scoreTicket, type DraftedTicket, type TicketCase } from "../relay/eval/ticket-score.js";
import { loadPersonas } from "../relay/io/personas.js";
import { buildPersonaResolver } from "../relay/proc/draft.js";
import type { InboundMessage } from "../relay/core/types.js";

// `--case <id>` runs one scenario. A bench you cannot bisect is a bench you
// cannot debug: the 2026-09-09 run had one real result and one timeout, and
// re-running both to chase the timeout costs the good one again.
const only = process.argv.includes("--case") ? process.argv[process.argv.indexOf("--case") + 1] : undefined;
// The routing decision flips run to run on identical input (2026-09-11: the
// same case ticketed once and did not the next time), so one run measures
// nothing. --repeat N reports how often it holds.
const repeat = process.argv.includes("--repeat")
  ? Math.max(1, Number(process.argv[process.argv.indexOf("--repeat") + 1]))
  : 1;
const cases = (
  parse(readFileSync(resolve(process.cwd(), "eval/ticket-cases.yaml"), "utf8")) as { cases: TicketCase[] }
).cases.filter((c) => !only || c.id === only);

const personas = loadPersonas(resolve(process.cwd(), "personas"));
const { resolve: resolvePersona, keys } = buildPersonaResolver(personas);
const llm = createClaudeCliLlmCaller({ timeoutMs: 480_000 });

const LINE = /^\[([^\]]+)\]\s*([^:]{1,40}):\s*(.*)$/;

function messagesFor(c: TicketCase): InboundMessage[] {
  const persona = personas.find((p) => p.key === c.personaKey);
  const handle = persona?.handles?.slack ?? c.personaKey;
  return c.corpus
    .split("\n")
    .map((l) => LINE.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m, i) => ({
      id: `bench:${c.id}:${i}`,
      platform: "slack" as const,
      senderHandle: handle,
      timestampMs: Date.parse(`${m[1]!.slice(0, 10)}T12:00:00Z`) + i * 1000,
      // The speaker label rides in the text so the model can tell the sides apart.
      text: `${m[2]!.trim()}: ${m[3]!}`,
      source: "slack:bench",
      isDirectMessage: true,
      mentionsUser: true,
      isReplyInUserThread: false,
      recipientsIncludeUser: true,
      threadAnsweredByUserAfter: false,
    }));
}

let passed = 0;
const runs: Array<{ id: string; ticketed: boolean; pass: boolean }> = [];
for (const c of cases) for (let attempt = 1; attempt <= repeat; attempt++) {
  console.log(`\n[ticket] ${c.id}${repeat > 1 ? ` (${attempt}/${repeat})` : ""} …`);
  const startedAt = Date.now();
  let drafted: DraftedTicket[] = [];
  try {
    const r = await draftActions(messagesFor(c), {
      llm,
      resolvePersona,
      knownPersonaKeys: keys,
      toolKeys: ["jira", "ticktick"],
      personas,
    });
    // Print every action type. Printing only the tool ones hid WHAT it chose
    // instead on the run that declined to ticket — the same blind spot twice.
    for (const a of r.actions) {
      const p = a.params as Record<string, unknown>;
      const label = [p.summary, p.title].find((v) => typeof v === "string") ?? "";
      console.log(`  · ${a.action_type}: ${String(label).slice(0, 90)}`);
    }
    // ALL actions reach the scorer: a fact routed onto a task of Leo's is
    // placed, not dropped, and scoring only the ticket called two correctly
    // routed tasks "missing facts" on 2026-09-11.
    drafted = r.actions.map((a) => ({
      actionType: a.action_type,
      ...(a.params as DraftedTicket),
    }));
    if (r.errors.length > 0) console.error(`  LLM: ${r.errors[0]!.error.split("\n")[0]}`);
    console.log(`  → ${r.actions.length} action(s), ${drafted.length} tool, ${Math.round((Date.now() - startedAt) / 1000)}s`);
  } catch (e) {
    console.error(`  FAILED after ${Math.round((Date.now() - startedAt) / 1000)}s — ${(e as Error).message.split("\n")[0]}`);
  }

  // Print what it actually produced. Inferring from a scorecard is how a
  // scorer bug (demanding an email where the field holds a display name) got
  // mistaken for a brain bug on 2026-09-10.
  for (const d of drafted.filter((x) => (x.tool ?? "").toLowerCase() === "jira")) {
    console.log(`  ── ${d.tool} · ${d.project ?? "(no project)"} · assignee=${d.assignee ?? "(none)"}`);
    console.log(`     ${d.summary ?? "(no summary)"}`);
    for (const line of (d.description ?? "").split("\n")) console.log(`     | ${line}`);
  }

  const v = scoreTicket(c, drafted);
  runs.push({ id: c.id, ticketed: v.ticketed, pass: v.pass });
  if (v.pass) passed++;
  console.log(`  开票 ${v.ticketed ? "✅" : "❌"} | assignee ${v.assignee} | 正文 ${v.chars} 字${v.tooLong ? " ❌超长" : ""}`);
  const total = v.carried.length + v.carriedElsewhere.length + v.missing.length;
  console.log(`  票内 context ${v.carried.length}/${total}${v.carriedElsewhere.length ? ` (另有 ${v.carriedElsewhere.length} 条分流到你的待办: ${v.carriedElsewhere.join("、")})` : ""}`);
  if (v.missing.length) console.log(`  ❌ 缺: ${v.missing.join("、")}`);
  if (v.padded.length) console.log(`  ❌ 冗余: ${v.padded.join("、")}`);
  console.log(`  ${v.pass ? "✅ PASS" : "❌ FAIL"}`);
}
console.log(`\n════ ${passed}/${runs.length} 通过 ════`);
if (repeat > 1) {
  for (const id of new Set(runs.map((r) => r.id))) {
    const mine = runs.filter((r) => r.id === id);
    console.log(`  ${id}: 开票 ${mine.filter((r) => r.ticketed).length}/${mine.length} 次`);
  }
}
