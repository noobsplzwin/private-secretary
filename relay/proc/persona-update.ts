// Persona-update pass (Phase B, specs/persona-v3.md): for each contact with an
// open card + a resolved persona, re-read the recent thread, extract NEW
// commitments, and merge them into the persona's Commitments Ledger via the R1
// write chokepoint (writePersonaFile actor="llm" — manual fields never touched,
// evidence required). This is the incremental update the roadmap calls Phase B;
// it is NOT the forbidden full bootstrap.

import type { ActionItem } from "../core/action-item.js";
import type { Persona } from "../core/types.js";
import type { Commitment } from "../core/persona-v3.js";
import { personaPath, readPersonaV3File, writePersonaFile } from "../io/persona-store.js";
import { clusterKey } from "../core/unit-key.js";
import { evidenceGrounded } from "../core/quote-check.js";
import { CallGate } from "../core/call-gate.js";
import {
  buildPersonaUpdateRequest,
  parseExtractedCommitments,
  parseExtractedUpdates,
  parseExtractedAssessments,
  type PersonaUpdateRequest,
} from "./persona-update-prompt.js";

export type PersonaUpdateJsonCaller = (req: PersonaUpdateRequest) => Promise<unknown>;

export interface PersonaUpdateDeps {
  json: PersonaUpdateJsonCaller;
  resolvePersona: (handle: string) => Persona | null;
  // The person's traffic across EVERY source their handles reach, not just the
  // rep card's conversation. This is what lets a commitment raised on Slack be
  // closed by a Gmail message — the engine drew exactly that conclusion once
  // ("PCB agreements signed & returned by Yang") and could not reach it, because
  // this pass only ever saw one thread. The run-notify implementation already
  // degrades per-slice (a failing source is skipped), so no second fallback here.
  fetchAllForPerson: (persona: Persona, rep: ActionItem) => Promise<string | null>;
  personaDir: string;
  maxPerTick?: number;
  ttlMs?: number;
  nowMs?: () => number;
  /** Dates the ASSESS verdicts. */
  now?: () => string;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

// Per-persona cooldown across ticks (module-level; resets on restart).
const lastUpdateMs = new Map<string, number>();

export interface PersonaUpdateResult {
  updated: Array<{ key: string; added: number; statusChanged: number; assessed: number }>;
  /** Extractions and verdicts thrown away because their quote is not in the corpus. */
  discarded: number;
  /** ASSESS verdicts written. The discard/assess ratio is how model invention is watched. */
  assessed: number;
}

export async function updatePersonaCommitments(
  openCards: Array<ActionItem & { sender_name?: string }>,
  deps: PersonaUpdateDeps,
): Promise<PersonaUpdateResult> {
  const ttl = deps.ttlMs ?? DEFAULT_TTL_MS;
  const nowMs = (deps.nowMs ?? (() => Date.now()))();
  const maxPerTick = deps.maxPerTick ?? 3;

  // One representative card per conversation (newest), that resolves to a persona.
  const byPersona = new Map<string, { rep: ActionItem; persona: Persona }>();
  for (const c of openCards) {
    const sender = c.context?.sender_handle;
    if (!sender) continue;
    const persona = deps.resolvePersona(sender);
    if (!persona) continue;
    const cur = byPersona.get(persona.key);
    if (!cur || c.created_at > cur.rep.created_at) byPersona.set(persona.key, { rep: c, persona });
  }

  const eligible = [...byPersona.entries()]
    .filter(([k]) => !lastUpdateMs.has(k) || nowMs - lastUpdateMs.get(k)! >= ttl)
    .sort(([a], [b]) => (lastUpdateMs.get(a) ?? 0) - (lastUpdateMs.get(b) ?? 0))
    .slice(0, maxPerTick);

  const updated: PersonaUpdateResult["updated"] = [];
  let discarded = 0;
  let assessed = 0;
  for (const [key, { rep, persona }] of eligible) {
    lastUpdateMs.set(key, nowMs); // claim the slot even on a no-op
    const thread = await deps.fetchAllForPerson(persona, rep);
    if (!thread) continue;

    const file = personaPath(deps.personaDir, key);
    const r = await extractCommitmentsOnce({
      file,
      displayName: persona.displayName,
      corpus: thread,
      json: deps.json,
      ...(deps.now ? { now: deps.now } : {}),
    });
    if (!r) continue;
    discarded += r.discarded;
    assessed += r.assessed;
    if (r.added > 0 || r.statusChanged > 0 || r.assessed > 0)
      updated.push({ key, added: r.added, statusChanged: r.statusChanged, assessed: r.assessed });
  }

  return { updated, discarded, assessed };
}

// Same conversation grouping key the rest of the daemon uses.
export { clusterKey };

// Test seam.
export function _resetPersonaUpdateTtl(): void {
  lastUpdateMs.clear();
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
// Identical corpus + identical tracked list = identical answer. Measured: 909
// real calls carried only 202 distinct inputs, so 78% of this pass re-asked a
// question it had already answered. See relay/core/call-gate.ts.
const extractGate = new CallGate();

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

  // Both of these ride the prompt, so both belong in the signature.
  const sig = CallGate.signature(opts.corpus, JSON.stringify(existing));
  if (extractGate.answered(opts.file, sig)) return { added: 0, statusChanged: 0, discarded: 0, assessed: 0 };

  let extracted;
  let transitions;
  let assessments;
  try {
    const raw = await opts.json(
      buildPersonaUpdateRequest({ name: opts.displayName, existing, thread: opts.corpus }),
    );
    extractGate.record(opts.file, sig); // only once the call RETURNED
    extracted = parseExtractedCommitments(raw);
    transitions = parseExtractedUpdates(raw, existing.length);
    assessments = parseExtractedAssessments(raw, existing.length);
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
    (assessments.length - okAssessments.length);

  const seen = new Set(existing.map((c) => norm(c.what)));
  const fresh = okExtracted.filter((e) => !seen.has(norm(e.what)));

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
  const at = (opts.now ?? (() => new Date().toISOString()))();
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

/** Test seam: forget which extractions have already been answered. */
export function _resetExtractGate(): void {
  extractGate.clear();
}
