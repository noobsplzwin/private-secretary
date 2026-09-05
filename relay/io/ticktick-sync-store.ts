// state/ticktick-sync.json — the unitKey → TickTick id map that makes the sync
// create-or-UPDATE instead of re-creating every to-do on every cycle
// (relay/core/ticktick-sync.ts explains why that matters).
//
// Load is TOTAL, like settings.ts and tools.ts: a missing or corrupt file falls
// back to an empty map and never throws. That fallback is not free — an empty
// map means the next cycle re-creates every task, duplicating whatever is
// already in TickTick — so a corrupt file is logged loudly rather than passed
// over in silence.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SyncMap, SyncRecord } from "../core/ticktick-sync.js";

// state/ lives beside the loop-state file, same convention as labels/shadow-log.
export function syncPathFor(statePath: string): string {
  return join(dirname(statePath), "ticktick-sync.json");
}

export function loadSyncMap(statePath: string): SyncMap {
  const path = syncPathFor(statePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    // ENOENT on first run is normal and silent; anything else means we are
    // about to duplicate every task in TickTick, which the operator must know.
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(
        `[ticktick] ${path} unreadable (${(e as Error).message}) — treating as EMPTY, ` +
          "which will re-create every task. Restore it before the next sync if that is wrong.",
      );
    }
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};

  const out: SyncMap = {};
  for (const [unitKey, raw] of Object.entries(parsed as Record<string, unknown>)) {
    const r = raw as Partial<SyncRecord> | null;
    if (!r || typeof r.ticktickId !== "string" || typeof r.hash !== "string") continue;
    out[unitKey] = {
      ticktickId: r.ticktickId,
      projectId: typeof r.projectId === "string" ? r.projectId : "",
      hash: r.hash,
      // `title` and `done` MUST survive the round trip. The loader used to
      // rebuild a record without them, so every tombstone written on a sync was
      // discarded on the next read: the same tasks were re-completed forever,
      // and the reopen-instead-of-create path — the entire reason tombstones
      // exist — could never fire. That path is what stops a re-listed to-do from
      // minting a twin, the failure that put one task in the calendar seven
      // times. Add a field to SyncRecord and you must add it here too.
      ...(typeof r.title === "string" ? { title: r.title } : {}),
      ...(typeof r.done === "number" ? { done: r.done } : {}),
      ...(Array.isArray(r.items)
        ? {
            items: r.items.filter(
              (i): i is { itemId: string; actionId: string } =>
                !!i && typeof i.itemId === "string" && typeof i.actionId === "string",
            ),
          }
        : {}),
    };
  }
  return out;
}

export function saveSyncMap(statePath: string, map: SyncMap): void {
  const path = syncPathFor(statePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(map, null, 2) + "\n");
}
