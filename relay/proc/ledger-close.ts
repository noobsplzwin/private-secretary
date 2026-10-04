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
 *
 * ONE ROW MAY CLOSE SEVERAL COMMITMENTS. A matter's row stands for the whole
 * chain (core/ledger-list.ts), so finishing it closes every open link in that
 * matter — which is what the owner means by ticking it. Settled links are left
 * alone by the `status !== "open"` guard below, so a `dropped` decision he
 * already made is never overwritten with `done`.
 */
export function markLedgerCommitmentsDone(
  closedUnitKeys: readonly string[],
  deps: LedgerCloseDeps,
): number {
  return settleLedgerCommitments(closedUnitKeys, "done", deps);
}

/**
 * The owner ticked 「🚫 这条不该出现」 on a ledger row: the work behind it
 * should never have been listed. That is `dropped`, never `done` — marking it
 * done would claim the work happened, which is the false-close this engine
 * spent a week undoing (94 commitments, 2026-09-27). Recorded in the persona
 * file with its reason, not in labels.jsonl: that ledger scores the CARD judge,
 * and a ledger row is not a card.
 *
 * ONLY THE COMMITMENT HE WAS SHOWN. A matter row stands for a whole chain, and
 * finishing one closes every link — so on 2026-09-29 a single 完成 marked 24
 * commitments done. 🚫 is a verdict on the ROW, 「this one should not be
 * here」, not on everything else filed beside it, so it drops the link whose
 * `what` the row's title shows. No title, or none that matches, drops nothing:
 * guessing which link he meant is the one thing this must never do.
 *
 * …AND THE LINKS THE ROW LISTED AS HIS. The description shows 「我这边还有」
 * under the title; he read those too when he ticked 🚫. Dropping only the
 * title left them open, and the next tick listed the first of them as a NEW
 * row — 2026-10-03 he dismissed 「Talk to more customers & Renesas」 and its
 * sibling 「Add Leap next-steps to the weekly agenda」 was queued to replace it.
 * Exact text from the row he saw, so still no guessing. Links listed as
 * waiting on the other side stay open — they were never his to dismiss.
 */
export function markLedgerCommitmentsDropped(
  dismissed: ReadonlyArray<{ unitKey: string; title?: string; shown?: readonly string[] }>,
  deps: LedgerCloseDeps,
): number {
  const shown = new Map(
    dismissed.map((d) => {
      const title = (d.title ?? "").replace(/^催: /, "").trim();
      return [d.unitKey, new Set([...(title ? [title] : []), ...(d.shown ?? [])])];
    }),
  );
  return settleLedgerCommitments(
    dismissed.map((d) => d.unitKey),
    "dropped",
    deps,
    (key, c) => shown.get(key)?.has(c.what.trim()) ?? false,
  );
}

function settleLedgerCommitments(
  closedUnitKeys: readonly string[],
  to: "done" | "dropped",
  deps: LedgerCloseDeps,
  /** Narrows which matching commitments settle; absent = all of them. */
  only?: (unitKey: string, c: Commitment) => boolean,
): number {
  // Group first: one persona can own several closed rows, and each write is a
  // whole-file emit, so writing per row would rewrite the same file N times
  // and let a later write clobber an earlier one's change.
  const byPersona = new Map<string, Array<{ key: string; hash: string }>>();
  for (const key of closedUnitKeys) {
    const parsed = parseLedgerUnitKey(key);
    if (!parsed) continue; // a card row — its ActionItems carry the closure
    const list = byPersona.get(parsed.personaKey) ?? [];
    list.push({ key, hash: parsed.hash });
    byPersona.set(parsed.personaKey, list);
  }

  let marked = 0;
  for (const [personaKey, rows] of byPersona) {
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
        if (!rows.some((r) => commitmentMatchesHash(c, r.hash) && (!only || only(r.key, c)))) return c;
        hit++;
        return { ...c, status: to };
      });
      if (hit === 0) continue;
      const res = writePersonaFile(
        file,
        {
          set: { commitments: next },
          ...(to === "dropped" ? { evidence: { commitments: "owner ticked 🚫 这条不该出现 in TickTick" } } : {}),
        },
        "human",
      );
      if (res.applied.includes("commitments")) marked += hit;
    } catch (e) {
      deps.onError?.(personaKey, e);
    }
  }
  return marked;
}
