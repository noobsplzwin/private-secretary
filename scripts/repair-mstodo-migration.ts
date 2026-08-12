// Repairs the partially-applied Microsoft To Do migration left by the first
// bulk run, which had two bugs (both now fixed in
// scripts/migrate-mstodo-to-ticktick.ts):
//
//   1. batch_add_tasks silently caps at 50 per call. 17 chunks x 100 requested
//      created exactly 17 x 50 = 850 tasks; 803 were dropped with an EMPTY
//      id2error, so nothing looked wrong.
//   2. Because 50 != 100 the run's `paired` guard went false, which skipped the
//      completion pass entirely (0 completed, so all 850 sit ACTIVE) AND still
//      wrote every chunk member to the ledger — including the 803 that were
//      never created, which a re-run would then skip forever.
//
// The repair treats TICKTICK as the source of truth, not the ledger:
//   · completes every ACTIVE task in the archive list, in batches of 50
//   · rewrites the ledger to hold only Microsoft rows actually present in
//     TickTick, matched by FINGERPRINT (title + notes, relay/core/mstodo.ts) —
//     NOT by title, because 42 titles repeat up to 43x and a title join would
//     mark 317 uncreated rows as done
//
// Read-only by default; --apply performs the writes. Safe to re-run.
//
//   npx tsx scripts/repair-mstodo-migration.ts
//   npx tsx scripts/repair-mstodo-migration.ts --apply

import { readFileSync, writeFileSync } from "node:fs";
import { callMcpTool, callResultObject, callResultRows, mcpAuthServiceFor } from "../relay/io/mcp-tool.js";
import { effectiveToolSpecs } from "../relay/io/tools.js";
import { resolveTickTickProject, type TickTickProject } from "../relay/core/ticktick.js";
import {
  TICKTICK_BATCH_MAX,
  fingerprintFor,
  fingerprintOfExisting,
  type MsList,
} from "../relay/core/mstodo.js";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
function arg(name: string, fallback: string): string {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
}
const statePath = arg("--state", "state/loop-state.json");
const exportPath = arg("--export", "todo-export/todo_export.json");
const ledgerPath = arg("--ledger", "state/mstodo-migration.jsonl");
const archiveList = arg("--archive", "📥 MS To Do Archive");

function connection(): { url: string; authService: string } {
  const cfg = effectiveToolSpecs(statePath).ticktick?.config ?? {};
  if (cfg.type !== "mcp" || !cfg.url) throw new Error("ticktick not configured — SETUP.md §5");
  return { url: cfg.url, authService: mcpAuthServiceFor("ticktick", cfg.authService) };
}

function objects(res: unknown): Array<Record<string, unknown>> {
  return callResultRows(res).filter(
    (r): r is Record<string, unknown> => typeof r === "object" && r !== null,
  );
}

interface ExistingTask {
  id: string;
  title: string;
  content?: string;
  desc?: string;
}

// The archive's ACTIVE tasks. get_project_with_undone_tasks returns the project
// object with its active tasks nested; content/desc come back too, which is
// what makes the fingerprint join possible.
async function activeTasks(
  conn: { url: string; authService: string },
  projectId: string,
): Promise<ExistingTask[]> {
  const res = await callMcpTool(conn.url, conn.authService, "get_project_with_undone_tasks", {
    project_id: projectId,
  });
  const out: ExistingTask[] = [];
  const take = (o: Record<string, unknown>) => {
    if (typeof o.id === "string" && typeof o.title === "string") {
      out.push({
        id: o.id,
        title: o.title,
        ...(typeof o.content === "string" ? { content: o.content } : {}),
        ...(typeof o.desc === "string" ? { desc: o.desc } : {}),
      });
    }
  };
  for (const o of objects(res)) {
    const nested = o.tasks;
    if (Array.isArray(nested)) for (const t of nested) take(t as Record<string, unknown>);
    else take(o);
  }
  return out;
}

async function main(): Promise<void> {
  const conn = connection();
  const projects = objects(await callMcpTool(conn.url, conn.authService, "list_projects", {}));
  const resolved = resolveTickTickProject(archiveList, projects as unknown as TickTickProject[]);
  if (resolved.status !== "resolved") throw new Error(`archive list "${archiveList}" did not resolve`);
  const archiveId = resolved.id;

  const active = await activeTasks(conn, archiveId);
  const lists = JSON.parse(readFileSync(exportPath, "utf8")) as MsList[];

  const ledgerRows = readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { ms_id: string; ticktick_id: string });
  // Rows written before the buggy run carried a real id, so they are trustworthy.
  const trusted = new Set(
    ledgerRows.filter((r) => r.ticktick_id !== "(unpaired)").map((r) => r.ms_id),
  );

  // Fingerprints of what is really in TickTick right now (the active ones).
  const presentFp = new Map<string, number>();
  for (const t of active) {
    const fp = fingerprintOfExisting(t);
    presentFp.set(fp, (presentFp.get(fp) ?? 0) + 1);
  }

  // Walk the export and decide, per row, whether TickTick already holds it.
  // Fingerprints are consumed so N identical rows match at most N real tasks.
  const remaining = new Map(presentFp);
  const verified: Array<{ ms_id: string; completed: boolean; how: string }> = [];
  let missing = 0;
  for (const l of lists) {
    for (const t of l.tasks) {
      if (trusted.has(t.id)) {
        verified.push({ ms_id: t.id, completed: t.status === "completed", how: "(verified-earlier)" });
        continue;
      }
      const fp = fingerprintFor(t, l.list);
      const left = remaining.get(fp) ?? 0;
      if (left > 0) {
        remaining.set(fp, left - 1);
        verified.push({ ms_id: t.id, completed: t.status === "completed", how: "(verified-in-ticktick)" });
      } else {
        missing++;
      }
    }
  }

  console.log(`archive "${archiveList}" (${archiveId})`);
  console.log(`  ACTIVE tasks needing completion : ${active.length}`);
  console.log(`  ledger rows now                 : ${ledgerRows.length} (${ledgerRows.length - trusted.size} unverified)`);
  console.log(`  export rows confirmed in TickTick: ${verified.length}`);
  console.log(`  export rows genuinely MISSING    : ${missing}`);
  const unmatched = [...remaining.values()].reduce((a, b) => a + b, 0);
  if (unmatched > 0) {
    console.warn(`  ${unmatched} TickTick task(s) matched no export row — left untouched`);
  }

  if (!apply) {
    console.log(
      `\nread-only. --apply would complete ${active.length} task(s) and rewrite the ledger to ${verified.length} verified row(s).`,
    );
    return;
  }

  // 1. Complete every active archive task, in legal batches.
  let completed = 0;
  for (let i = 0; i < active.length; i += TICKTICK_BATCH_MAX) {
    const chunk = active.slice(i, i + TICKTICK_BATCH_MAX);
    const res = await callMcpTool(conn.url, conn.authService, "batch_update_tasks", {
      tasks: chunk.map((t) => ({ id: t.id, projectId: archiveId, status: 2 })),
    });
    const errs = Object.keys(
      (callResultObject(res) as { id2error?: Record<string, string> }).id2error ?? {},
    );
    completed += chunk.length - errs.length;
    if (errs.length > 0) console.warn(`  ${errs.length} completion errors in this batch`);
    console.log(`  completed ${Math.min(i + TICKTICK_BATCH_MAX, active.length)}/${active.length}`);
  }

  // 2. Rewrite the ledger from verified reality.
  const at = new Date().toISOString();
  writeFileSync(
    ledgerPath,
    verified
      .map((v) => JSON.stringify({ ms_id: v.ms_id, ticktick_id: v.how, completed: v.completed, at }))
      .join("\n") + "\n",
  );

  console.log(`\ncompleted ${completed} task(s).`);
  console.log(`ledger rewritten: ${ledgerRows.length} rows → ${verified.length} verified rows.`);
  console.log(`Now create the ${missing} missing row(s):`);
  console.log(`  npx tsx scripts/migrate-mstodo-to-ticktick.ts`);
}

main().catch((e) => {
  console.error(`repair failed: ${(e as Error).message}`);
  process.exit(1);
});
