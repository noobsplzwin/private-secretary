// The owner finished a LEDGER row — mark the commitment behind it done.
//
// WHY THIS EXISTS: a ledger row is derived fresh from a persona commitment on
// every tick and carries no ActionItem, so finishing it in TickTick settled
// nothing. The commitment stayed `open`, the next tick re-derived the row, the
// diff saw a tombstone and REOPENED the task. Measured on the real account:
// 50-70 rows resurrected every tick, all work the owner had already closed —
// which is what he was describing when he said the list "keeps updating
// itself". `audit-ledger` found 0 `done` commitments across 29 personas for the
// same reason: nothing in the engine could ever write one.
//
// actor "human": this is the owner's own gesture in his to-do list, not a model
// inference, so it is not subject to the R1 llm restrictions.

import { personaPath, readPersonaV3File, writePersonaFile } from "../io/persona-store.js";
import { parseLedgerUnitKey, commitmentMatchesHash } from "../core/ledger-list.js";
import type { Commitment } from "../core/persona-v3.js";

export interface LedgerCloseDeps {
  personaDir: string;
  /** Injected so the caller can log/ignore per-persona failures. */
  onError?: (personaKey: string, err: unknown) => void;
}

/**
 * Returns how many commitments were marked done. A key that matches no
 * commitment is skipped silently: the row may predate a persona rewrite, and a
 * miss must never be worth failing the tick over.
 */
export function markLedgerCommitmentsDone(
  closedUnitKeys: readonly string[],
  deps: LedgerCloseDeps,
): number {
  // Group first: one persona can own several closed rows, and each write is a
  // whole-file emit, so writing per row would rewrite the same file N times
  // and let a later write clobber an earlier one's change.
  const byPersona = new Map<string, string[]>();
  for (const key of closedUnitKeys) {
    const parsed = parseLedgerUnitKey(key);
    if (!parsed) continue; // a card row — its ActionItems carry the closure
    const list = byPersona.get(parsed.personaKey) ?? [];
    list.push(parsed.hash);
    byPersona.set(parsed.personaKey, list);
  }

  let marked = 0;
  for (const [personaKey, hashes] of byPersona) {
    try {
      const file = personaPath(deps.personaDir, personaKey);
      const persona = readPersonaV3File(file);
      const commitments = persona.commitments ?? [];
      let hit = 0;
      const next: Commitment[] = commitments.map((c) => {
        // Only an OPEN commitment can be finished. `dropped` was a decision the
        // owner already made, and overwriting it with `done` would claim work
        // happened that never did.
        if (c.status !== "open") return c;
        if (!hashes.some((h) => commitmentMatchesHash(c.what, h))) return c;
        hit++;
        return { ...c, status: "done" as const };
      });
      if (hit === 0) continue;
      const res = writePersonaFile(file, { set: { commitments: next } }, "human");
      if (res.applied.includes("commitments")) marked += hit;
    } catch (e) {
      deps.onError?.(personaKey, e);
    }
  }
  return marked;
}
