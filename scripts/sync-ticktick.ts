// Push the ranked to-do list into TickTick once, outside the daemon.
//
// The same pass the daemon runs as PHASE 6b (relay/proc/ticktick-sync.ts), so
// this is how you see what a tick would do — and the first real push, before
// the daemon takes over.
//
//   npx tsx scripts/sync-ticktick.ts --dry-run   # what would change, no writes
//   npx tsx scripts/sync-ticktick.ts             # do it
//
// A dry run needs no TickTick connection at all: the diff is computed from
// loop-state + state/ticktick-sync.json.

import { loadState } from "../relay/io/state.js";
import { effectiveToolSpecs } from "../relay/io/tools.js";
import { mcpAuthServiceFor } from "../relay/io/mcp-tool.js";
import { createTickTickWriter } from "../relay/io/ticktick-mcp.js";
import { loadSyncMap, saveSyncMap, syncPathFor } from "../relay/io/ticktick-sync-store.js";
import { syncToTickTick, taskUnitsFrom } from "../relay/proc/ticktick-sync.js";
import { buildTaskPayload, shouldSync } from "../relay/core/ticktick-plan.js";
import { diffTickTickSync, summarize } from "../relay/core/ticktick-sync.js";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const statePath = argv.includes("--state") ? argv[argv.indexOf("--state") + 1]! : "state/loop-state.json";

const state = loadState(statePath);
const map = loadSyncMap(statePath);

const units = taskUnitsFrom(state);
const eligible = units.filter(shouldSync);
console.log(`open task units: ${units.length}  →  eligible to sync: ${eligible.length}`);
console.log(`sync map: ${Object.keys(map).length} already tracked (${syncPathFor(statePath)})`);

const desired = eligible.map((u) => ({ unitKey: u.unitKey, payload: buildTaskPayload(u).payload }));
const counts = summarize(diffTickTickSync(desired, map));
console.log(
  `\nwould: create ${counts.create}  update ${counts.update}  complete ${counts.complete}  skip ${counts.skip}`,
);

if (dryRun) {
  console.log("\n--- the first few tasks as TickTick would get them ---");
  for (const u of eligible.slice(0, 5)) {
    const p = buildTaskPayload(u).payload;
    console.log(`\n[priority ${p.priority}] ${p.title}`);
    if (p.dueDate) console.log(`  due: ${p.dueDate}`);
    for (const i of p.items ?? []) console.log(`  ☐ ${i.title}`);
    const note = p.desc ?? p.content;
    if (note) console.log(`  note: ${note.split("\n")[0]}`);
  }
  console.log("\n--dry-run: nothing written.");
  process.exit(0);
}

const cfg = effectiveToolSpecs(statePath).ticktick?.config ?? {};
if (cfg.type !== "mcp" || !cfg.url) {
  console.error("ticktick is not configured — see SETUP.md §5");
  process.exit(1);
}
const writer = createTickTickWriter({
  url: cfg.url,
  authService: mcpAuthServiceFor("ticktick", cfg.authService),
  ...(cfg.project ? { project: cfg.project } : {}),
});

const { map: next, report } = await syncToTickTick(state, map, writer);
saveSyncMap(statePath, next);
console.log(
  `\ncreated ${report.created}, updated ${report.updated}, completed ${report.completed}, ` +
    `unchanged ${report.skipped}, failed ${report.failed}`,
);
if (report.failed > 0) {
  console.error("some writes failed — they were NOT recorded, so re-running retries them");
  process.exit(1);
}
