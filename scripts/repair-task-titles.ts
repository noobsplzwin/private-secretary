#!/usr/bin/env -S npx tsx
// One-off repair: strip a platform HANDLE from a task title.
//
// consolidate-prompt's own example title was "objective · person", and the model
// followed it down to titles like "Ethernet+WiFi init patch 更新范围与大规模推送
// · U031UFWA11S" — a raw Slack user id in the line Leo scans in TickTick. The
// prompt now names the objective and bans handles outright, but it also tells
// the pass to reuse an existing task's title EXACTLY (that is how a card attaches
// to the right task), so titles already minted never heal on their own.
//
// A rename is not a string edit: task_id is sha256(normalizeTaskTitle(title)),
// so the id changes with the title, and four keyed structures point at the old
// one — the task registry, every member card's task_id, plans/planOverrides, and
// the TickTick sync map. Moving all four together keeps the plan, the manual
// re-tier, and the existing TickTick task; missing one orphans the plan or
// duplicates the row.
//
//   npx tsx scripts/repair-task-titles.ts [--dry-run] [--state p]
//
// Then `npx tsx scripts/sync-ticktick.ts` pushes the new titles to TickTick.

import { loadState, saveState, acquireLock, releaseLock } from "../relay/io/state.js";
import { loadSyncMap, saveSyncMap } from "../relay/io/ticktick-sync-store.js";
import { stableTaskId } from "../relay/proc/consolidate.js";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const statePath = argv.includes("--state") ? argv[argv.indexOf("--state") + 1]! : "state/loop-state.json";

// A trailing " · <handle>": a Slack id, an email address, or a wxid. Anchored at
// the end so a legitimate mid-title separator ("卖 Jeep · 联系 Mercedes 的…") is
// untouched — only the suffix the prompt's old example produced.
const HANDLE_SUFFIX = /\s*·\s*(?:U[A-Z0-9]{8,}|[^\s·]+@[^\s·]+|wxid_[^\s·]+)\s*$/u;

const state = loadState(statePath);
const registry = state.tasks ?? {};

const renames: Array<{ oldId: string; newId: string; from: string; to: string }> = [];
for (const [oldId, meta] of Object.entries(registry)) {
  const from = meta.title;
  if (!HANDLE_SUFFIX.test(from)) continue;
  const to = from.replace(HANDLE_SUFFIX, "").trim();
  if (to === "" || to === from) continue;
  const newId = stableTaskId(to);
  if (newId === oldId) continue;
  // Refuse to merge: a title that already exists is a different task with its
  // own members and plan, and folding one into it is the contamination this
  // whole line of work has been undoing.
  if (registry[newId]) {
    console.error(`REFUSING ${oldId}: "${to}" already exists as ${newId} — merging tasks is not a rename`);
    continue;
  }
  renames.push({ oldId, newId, from, to });
}

if (renames.length === 0) {
  console.log("no handle-suffixed titles found — nothing to repair.");
  process.exit(0);
}

const map = loadSyncMap(statePath);
for (const r of renames) {
  const members = state.actions.filter((a) => a.task_id === r.oldId).length;
  console.log(`\n${r.from}\n  → ${r.to}`);
  console.log(
    `  ${r.oldId} → ${r.newId} | ${members} 张卡 | ` +
      `plan ${state.plans?.[r.oldId] ? "有" : "无"} | override ${state.planOverrides?.[r.oldId] ? "有" : "无"} | ` +
      `TickTick ${map[r.oldId] ? map[r.oldId]!.ticktickId : "未同步"}`,
  );
}

if (dryRun) {
  console.log("\n--dry-run: nothing written.");
  process.exit(0);
}

if (!acquireLock(dirname(statePath))) {
  console.error("\nstate is locked (the daemon is mid-tick) — try again in a moment.");
  process.exit(1);
}
try {
  for (const r of renames) {
    const meta = registry[r.oldId]!;
    delete registry[r.oldId];
    registry[r.newId] = { ...meta, title: r.to };

    for (const a of state.actions) if (a.task_id === r.oldId) a.task_id = r.newId;

    if (state.plans?.[r.oldId]) {
      state.plans[r.newId] = state.plans[r.oldId]!;
      delete state.plans[r.oldId];
    }
    if (state.planOverrides?.[r.oldId]) {
      state.planOverrides[r.newId] = state.planOverrides[r.oldId]!;
      delete state.planOverrides[r.oldId];
    }
    // Carrying the sync entry over is what makes this an UPDATE of the existing
    // TickTick task rather than a fresh row plus an orphan.
    if (map[r.oldId]) {
      map[r.newId] = map[r.oldId]!;
      delete map[r.oldId];
    }
  }
  state.tasks = registry;
  saveState(statePath, state);
  saveSyncMap(statePath, map);
} finally {
  releaseLock(dirname(statePath));
}

console.log(`\nrenamed ${renames.length}. Run scripts/sync-ticktick.ts to push the new titles.`);
