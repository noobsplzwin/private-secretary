// One-time migration: the Microsoft To Do export (todo-export/todo_export.json)
// into TickTick. Runs OUTSIDE the engine — it touches no loop-state and creates
// no action items; it only writes to TickTick.
//
// FOUR TICKTICK BEHAVIOURS THIS ENCODES, all verified against the live API and
// all of which fail SILENTLY:
//
//   1. batch_add_tasks CAPS AT 50 TASKS PER CALL and truncates without saying
//      so — ask for 100 and it creates 50, returns 50 ids and an EMPTY
//      id2error. The first bulk run lost 803 tasks to exactly this. Chunk size
//      is clamped to TICKTICK_BATCH_MAX and a short count is a loud failure.
//   2. create_task IGNORES `status: 2` — a task cannot be created completed.
//      Completion is a SECOND pass (batch_update_tasks with status 2).
//   3. There is no `completedTime` field on the API, so the ORIGINAL completion
//      date cannot be restored; TickTick stamps the moment of the update. Every
//      task therefore carries its real Microsoft dates in its notes, which is
//      the only place they survive. Expect the whole archive to show as
//      completed on the day you run this.
//   4. NEVER set repeatFlag on a task that will be completed — completing a
//      recurring task makes TickTick spawn the NEXT occurrence, and 300 of the
//      exported tasks recur.
//
// IDEMPOTENT: a Microsoft id is written to state/mstodo-migration.jsonl ONLY
// after its whole chunk is confirmed created, and recorded ids are skipped on a
// re-run. A chunk that comes back short is left OUT of the ledger so the re-run
// retries it — never the reverse, which would silently drop tasks forever.
//
//   npx tsx scripts/migrate-mstodo-to-ticktick.ts --dry-run
//   npx tsx scripts/migrate-mstodo-to-ticktick.ts --include completed
//   npx tsx scripts/migrate-mstodo-to-ticktick.ts --limit 50
//
// Requires the `ticktick` tool configured with config.type "mcp" + config.url
// (SETUP.md §5) — the same connection the executor uses.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  callMcpTool,
  callResultObject,
  callResultRows,
  mcpAuthServiceFor,
} from "../relay/io/mcp-tool.js";
import { effectiveToolSpecs } from "../relay/io/tools.js";
import { resolveTickTickProject, type TickTickProject } from "../relay/core/ticktick.js";
import { TICKTICK_BATCH_MAX, payloadFor, type MsList, type MsTask } from "../relay/core/mstodo.js";

const argv = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
}
const dryRun = argv.includes("--dry-run");
const statePath = arg("--state", "state/loop-state.json");
const exportPath = arg("--export", "todo-export/todo_export.json");
const archiveList = arg("--archive", "📥 MS To Do Archive");
const openList = arg("--open-list", "💼Work");
const include = arg("--include", "completed") as "completed" | "open" | "all";
const limit = Number(arg("--limit", "0")) || Infinity;
const ledgerPath = arg("--ledger", "state/mstodo-migration.jsonl");
// Clamped, not configurable upward: above 50 TickTick drops the remainder.
const chunkSize = Math.min(Number(arg("--chunk", String(TICKTICK_BATCH_MAX))), TICKTICK_BATCH_MAX);

// ─── ledger (idempotency) ────────────────────────────────────────────

function readLedger(): Set<string> {
  if (!existsSync(ledgerPath)) return new Set();
  const ids = new Set<string>();
  for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { ms_id?: string };
      if (row.ms_id) ids.add(row.ms_id);
    } catch {
      // A torn last line from an interrupted run — skip it, don't abort.
    }
  }
  return ids;
}

// The ticktick_id is deliberately NOT recorded per row: batch_add_tasks returns
// its ids unordered, so any pairing would be a guess. The real join key back to
// TickTick is the fingerprint in relay/core/mstodo.ts.
function appendLedger(rows: Array<{ ms_id: string; completed: boolean }>): void {
  if (rows.length === 0) return;
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const at = new Date().toISOString();
  appendFileSync(
    ledgerPath,
    rows.map((r) => JSON.stringify({ ...r, ticktick_id: "(created)", at })).join("\n") + "\n",
  );
}

// ─── MCP ─────────────────────────────────────────────────────────────

function connection(): { url: string; authService: string } {
  const cfg = effectiveToolSpecs(statePath).ticktick?.config ?? {};
  if (cfg.type !== "mcp" || !cfg.url) {
    throw new Error(
      'ticktick is not configured — set config.type "mcp" + config.url in config/tools.json (SETUP.md §5)',
    );
  }
  return { url: cfg.url, authService: mcpAuthServiceFor("ticktick", cfg.authService) };
}

async function resolveProject(
  conn: { url: string; authService: string },
  name: string,
): Promise<string> {
  const res = await callMcpTool(conn.url, conn.authService, "list_projects", {});
  // One JSON object per project — callResultRows normalises that shape.
  const rows = callResultRows(res).filter(
    (r): r is TickTickProject =>
      typeof r === "object" && r !== null && typeof (r as TickTickProject).id === "string",
  );
  const resolution = resolveTickTickProject(name, rows);
  if (resolution.status !== "resolved") {
    throw new Error(`no TickTick list named "${name}" (have: ${rows.map((p) => p.name).join(", ")})`);
  }
  return resolution.id;
}

// ─── main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const lists = JSON.parse(readFileSync(exportPath, "utf8")) as MsList[];
  const done = readLedger();

  const selected: Array<{ t: MsTask; listName: string }> = [];
  for (const l of lists) {
    for (const t of l.tasks) {
      const completed = t.status === "completed";
      if (include === "completed" && !completed) continue;
      if (include === "open" && completed) continue;
      if (done.has(t.id)) continue;
      selected.push({ t, listName: l.list });
    }
  }
  const work = selected.slice(0, limit === Infinity ? undefined : limit);

  const completedCount = work.filter((w) => w.t.status === "completed").length;
  console.log(
    `${work.length} to migrate (${completedCount} completed, ${work.length - completedCount} open)` +
      `${selected.length > work.length ? ` — capped from ${selected.length} by --limit` : ""}` +
      `${done.size > 0 ? `; ${done.size} already migrated (ledger)` : ""}`,
  );
  if (work.length === 0) return;

  if (dryRun) {
    for (const { t, listName } of work.slice(0, 3)) {
      console.log(JSON.stringify(payloadFor(t, listName, "<projectId>"), null, 1));
    }
    console.log(
      `\n--dry-run: nothing written. ${Math.ceil(work.length / chunkSize) * 2} MCP calls at chunk=${chunkSize}.`,
    );
    return;
  }

  const conn = connection();
  const archiveId = await resolveProject(conn, archiveList);
  const openId = completedCount < work.length ? await resolveProject(conn, openList) : archiveId;

  let created = 0;
  let completed = 0;
  let shortChunks = 0;
  for (let i = 0; i < work.length; i += chunkSize) {
    const chunk = work.slice(i, i + chunkSize);
    const payloads = chunk.map(({ t, listName }) =>
      payloadFor(t, listName, t.status === "completed" ? archiveId : openId),
    );

    // Pass 1 — create. Always lands active (behaviour 2).
    const addRes = await callMcpTool(conn.url, conn.authService, "batch_add_tasks", {
      tasks: payloads,
    });
    const added = callResultObject(addRes) as {
      id2etag?: Record<string, string>;
      id2error?: Record<string, string>;
    };
    const newIds = Object.keys(added.id2etag ?? {});
    const errors = Object.entries(added.id2error ?? {});
    created += newIds.length;
    if (errors.length > 0) {
      console.warn(`  chunk ${i / chunkSize + 1}: ${errors.length} create errors`, errors.slice(0, 3));
    }

    // A short count is behaviour 1 biting despite the clamp. Do NOT ledger the
    // chunk — an over-recorded ledger loses tasks permanently, whereas an
    // under-recorded one just means the next run redoes this chunk.
    if (newIds.length !== chunk.length) {
      shortChunks++;
      console.warn(
        `  chunk ${i / chunkSize + 1}: asked ${chunk.length}, created ${newIds.length} — NOT recorded, re-run will retry`,
      );
      continue;
    }
    appendLedger(chunk.map((c) => ({ ms_id: c.t.id, completed: c.t.status === "completed" })));

    // Pass 2 — complete the ones Microsoft had completed (behaviour 3).
    const toComplete = newIds.filter((_, j) => chunk[j]!.t.status === "completed");
    if (toComplete.length > 0) {
      const upRes = await callMcpTool(conn.url, conn.authService, "batch_update_tasks", {
        tasks: toComplete.map((id) => ({ id, projectId: archiveId, status: 2 })),
      });
      const upd = callResultObject(upRes) as { id2error?: Record<string, string> };
      const upErrors = Object.keys(upd.id2error ?? {}).length;
      completed += toComplete.length - upErrors;
      if (upErrors > 0) console.warn(`  chunk ${i / chunkSize + 1}: ${upErrors} completion errors`);
    }

    console.log(`  ${Math.min(i + chunkSize, work.length)}/${work.length}`);
  }

  console.log(`\ncreated ${created}, marked complete ${completed}. Ledger: ${ledgerPath}`);
  if (shortChunks > 0) {
    console.error(
      `${shortChunks} chunk(s) came back short and were left unrecorded — re-run this command to finish them.`,
    );
    process.exit(1);
  }
  console.log(
    "TickTick stamped today as the completion date for the whole archive — the real dates are in each task's notes.",
  );
}

main().catch((e) => {
  console.error(`migration failed: ${(e as Error).message}`);
  process.exit(1);
});
