// state/owner-notes.jsonl — what he wrote after 「🚫 这条不该出现」, kept the
// moment the readback sees it. The richest verdict this engine gets, and the
// task line it lives on can be dismissed, completed or re-rendered, so it is
// written down at once. Append-only, one record per (row, note) the first time
// it appears.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface OwnerNote {
  unitKey: string;
  note: string;
  dismissed: boolean;
  title?: string;
}

/** Append the notes not already on file. Returns how many were new. Throws on I/O failure. */
export function recordOwnerNotes(statePath: string, notes: readonly OwnerNote[]): number {
  const file = join(dirname(statePath), "owner-notes.jsonl");
  const key = (n: { unitKey: string; note: string }): string => `${n.unitKey}\u0000${n.note}`;
  const seen = new Set(
    existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => key(JSON.parse(l) as { unitKey: string; note: string }))
      : [],
  );
  const fresh = notes.filter((n) => !seen.has(key(n)));
  if (fresh.length > 0) {
    appendFileSync(file, fresh.map((n) => JSON.stringify({ at: new Date().toISOString(), ...n })).join("\n") + "\n");
  }
  return fresh.length;
}
