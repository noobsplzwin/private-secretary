// Persona-update pass (Phase B, specs/persona-v3.md): for each contact with an
// open card + a resolved persona, re-read the recent thread, extract NEW
// commitments, and merge them into the persona's Commitments Ledger via the R1
// write chokepoint (writePersonaFile actor="llm" — manual fields never touched,
// evidence required). This is the incremental update the roadmap calls Phase B;
// it is NOT the forbidden full bootstrap.

import type { Persona } from "../core/types.js";
import type { PersonQueueEntry } from "../core/person-queue.js";
import type { Commitment } from "../core/persona-v3.js";
import { personaPath, readPersonaV3File, writePersonaFile } from "../io/persona-store.js";
import { evidenceGrounded } from "../core/quote-check.js";
import { indexCorpus, mintable } from "../core/corpus-lines.js";
import {
  buildPersonaUpdateRequest,
  type ExtractedCommitment,
  parseExtractedCommitments,
  parseExtractedUpdates,
  parseExtractedAssessments,
  type PersonaUpdateRequest,
} from "./persona-update-prompt.js";

export type PersonaUpdateJsonCaller = (req: PersonaUpdateRequest) => Promise<unknown>;

export interface PersonaUpdateDeps {
  json: PersonaUpdateJsonCaller;
  /** The queue carries persona KEYS, so resolution is by key — no card, no handle. */
  personaFor: (key: string) => Persona | null;
  // The person's traffic across EVERY source their handles reach. This is what
  // lets a commitment raised on Slack be closed by a Gmail message — the engine
  // drew exactly that conclusion once ("PCB agreements signed & returned") and
  // could not reach it, because this pass only ever saw one thread.
  //
  // No card parameter. It used to take a representative ActionItem, which made
  // an OPEN CARD the precondition for a person being looked at: anyone who
  // talked without producing a card was invisible to the ledger. The card is now
  // at most an extra slice the implementation adds when one happens to exist.
  fetchCorpus: (persona: Persona) => Promise<string | null>;
  personaDir: string;
  /** Dates the ASSESS verdicts. */
  now?: () => string;
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

export interface PersonaUpdateResult {
  updated: Array<{ key: string; added: number; statusChanged: number; assessed: number }>;
  /** Extractions and verdicts thrown away because their quote is not in the corpus. */
  discarded: number;
  /** ASSESS verdicts written. The discard/assess ratio is how model invention is watched. */
  assessed: number;
  /** Everyone the pass took off the queue. Cursors advance for all of these. */
  attempted: PersonQueueEntry[];
  /**
   * Keys whose corpus came back empty — no handles, or every source failed.
   * Reported rather than silently skipped (spec §6.2): a person reachable on no
   * mapped handle is invisible to their own pass, and that is a data bug worth
   * seeing. Their cursor still advances, so one unreachable contact cannot
   * occupy the oldest-first slot every tick and starve everyone behind them;
   * their next message re-queues them.
   */
  unreadable: string[];
}

export async function updatePersonaCommitments(
  /** Who to assess — already selected and capped by core/person-queue. */
  queue: ReadonlyArray<PersonQueueEntry>,
  deps: PersonaUpdateDeps,
): Promise<PersonaUpdateResult> {
  const updated: PersonaUpdateResult["updated"] = [];
  const attempted: PersonQueueEntry[] = [];
  const unreadable: string[] = [];
  let discarded = 0;
  let assessed = 0;

  for (const entry of queue) {
    const persona = deps.personaFor(entry.personaKey);
    if (!persona) {
      unreadable.push(entry.personaKey);
      attempted.push(entry);
      continue;
    }
    attempted.push(entry);

    const corpus = await deps.fetchCorpus(persona);
    if (!corpus) {
      unreadable.push(entry.personaKey);
      continue;
    }

    const r = await extractCommitmentsOnce({
      file: personaPath(deps.personaDir, entry.personaKey),
      displayName: persona.displayName,
      corpus,
      json: deps.json,
      ...(deps.now ? { now: deps.now } : {}),
    });
    if (!r) continue;
    discarded += r.discarded;
    assessed += r.assessed;
    if (r.added > 0 || r.statusChanged > 0 || r.assessed > 0)
      updated.push({
        key: entry.personaKey,
        added: r.added,
        statusChanged: r.statusChanged,
        assessed: r.assessed,
      });
  }

  return { updated, discarded, assessed, attempted, unreadable };
}


/**
 * Extract-and-merge for ONE persona: new commitments + status transitions from
 * a corpus, quote-gated, written through the R1 chokepoint. Shared by the tick
 * pass above and the one-off seeding/audit scripts, so the merge rules cannot
 * drift between them.
 *
 * Returns null when the persona file is unreadable or the LLM call failed —
 * a single contact's failure must not sink a batch.
 */
export async function extractCommitmentsOnce(opts: {
  file: string;
  displayName: string;
  corpus: string;
  json: PersonaUpdateJsonCaller;
  /** Dates each verdict, so a stale needs_leo cannot keep an item alive. */
  now?: () => string;
}): Promise<{ added: number; statusChanged: number; discarded: number; assessed: number } | null> {
  let existing: Commitment[];
  try {
    existing = readPersonaV3File(opts.file).commitments ?? [];
  } catch {
    return null;
  }

  let extracted;
  let transitions;
  let assessments;
  let parseDropped = 0;
  try {
    const raw = await opts.json(
      buildPersonaUpdateRequest({ name: opts.displayName, existing, thread: opts.corpus }),
    );
    extracted = parseExtractedCommitments(raw);
    transitions = parseExtractedUpdates(raw, existing.length);
    assessments = parseExtractedAssessments(raw, existing.length);
    // A verdict the parser rejected (bad index, non-boolean needs_leo, missing
    // quote) must COUNT, or it vanishes without trace — the seed run reported
    // "assessed 0, discarded 0" for contacts whose reply carried verdicts, and
    // nothing anywhere said why.
    const rawAssess = (raw as { assessments?: unknown[] } | null)?.assessments;
    parseDropped = (Array.isArray(rawAssess) ? rawAssess.length : 0) - assessments.length;
  } catch {
    return null;
  }

  // GROUNDING IS MECHANICAL. Every extraction must quote the corpus verbatim;
  // one that cannot is invented, and an invented "done" silently closes real
  // work (the reverse of the append-only bug). The discard count is reported
  // upward: a high rate is itself a finding about how much the model creates.
  const grounded = <T extends { evidence?: string }>(xs: T[]): T[] =>
    xs.filter((x) => evidenceGrounded(opts.corpus, x.evidence ?? ""));
  const okExtracted = grounded(extracted);
  const okTransitions = grounded(transitions);
  const okAssessments = grounded(assessments);
  const discarded =
    extracted.length -
    okExtracted.length +
    (transitions.length - okTransitions.length) +
    (assessments.length - okAssessments.length) +
    parseDropped;

  const at = (opts.now ?? (() => new Date().toISOString()))();
  const seen = new Set(existing.map((c) => norm(c.what)));

  // STRUCTURAL GATES — core/corpus-lines.ts `mintable`, the ONE implementation
  // the bench also runs, so what ships here is what the scorecard measures.
  const lines = indexCorpus(opts.corpus);
  const nowMs = Date.parse(at);
  let gated = 0;
  const fresh = okExtracted.filter((e) => !seen.has(norm(e.what))).filter((e) => {
    if (mintable(lines, e, nowMs)) return true;
    gated++;
    return false;
  });

  // Status transitions FIRST, on a copy. The ledger used to be append-only —
  // dedup-by-wording meant a conversation showing a tracked commitment FINISHED
  // had no way to say so. Only apply a real change.
  const withStatus = existing.map((c) => ({ ...c }));
  let statusChanged = 0;
  for (const u of okTransitions) {
    if (withStatus[u.index]!.status === u.status) continue;
    withStatus[u.index]!.status = u.status;
    statusChanged++;
  }
  // ASSESS verdicts land on the commitments they judge. Structural rules are
  // enforced HERE, not trusted to the prompt: only an OPEN commitment Leo owns
  // can carry a verdict, and next_step is meaningless without needs_leo. A fresh
  // verdict REPLACES a stale one — that is what dating them is for.
  let assessed = 0;
  for (const a of okAssessments) {
    const target = withStatus[a.index]!;
    if (target.who !== "me" || target.status !== "open") continue;
    target.assessment = {
      needs_leo: a.needs_leo,
      ...(a.blocked_on ? { blocked_on: a.blocked_on } : {}),
      ...(a.needs_leo && a.next_step?.trim() ? { next_step: a.next_step.trim() } : {}),
      evidence: a.evidence,
      at,
    };
    assessed++;
  }

  if (fresh.length === 0 && statusChanged === 0 && assessed === 0)
    return { added: 0, statusChanged: 0, discarded, assessed: 0 };

  const merged: Commitment[] = [
    ...withStatus,
    ...fresh.map((e) => ({
      who: e.who,
      what: e.what,
      status: e.status ?? "open",
      ...(e.due ? { due: e.due } : {}),
      ...(e.matter_id ? { matter_id: e.matter_id.trim() } : {}),
    })),
  ];
  const evidence =
    [
    ...fresh.map((e) => e.evidence),
    ...okTransitions.map((u) => u.evidence),
    ...okAssessments.map((a) => a.evidence),
  ]
      .filter(Boolean)
      .join(" | ") || "extracted from recent conversation";
  try {
    const res = writePersonaFile(
      opts.file,
      { set: { commitments: merged }, evidence: { commitments: evidence } },
      "llm",
    );
    if (!res.applied.includes("commitments")) return { added: 0, statusChanged: 0, discarded, assessed: 0 };
  } catch {
    return { added: 0, statusChanged: 0, discarded, assessed: 0 };
  }
  return { added: fresh.length, statusChanged, discarded, assessed };
}
