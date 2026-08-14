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
import { hasVerbatim } from "../core/quote-check.js";
import {
  buildPersonaUpdateRequest,
  parseExtractedCommitments,
  parseExtractedUpdates,
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
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

// Per-persona cooldown across ticks (module-level; resets on restart).
const lastUpdateMs = new Map<string, number>();

export interface PersonaUpdateResult {
  updated: Array<{ key: string; added: number; statusChanged: number }>;
  /** Extractions thrown away because their evidence quote is not in the corpus. */
  discarded: number;
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
  for (const [key, { rep, persona }] of eligible) {
    lastUpdateMs.set(key, nowMs); // claim the slot even on a no-op
    const thread = await deps.fetchAllForPerson(persona, rep);
    if (!thread) continue;

    const file = personaPath(deps.personaDir, key);
    let existing: Commitment[];
    try {
      existing = readPersonaV3File(file).commitments ?? [];
    } catch {
      continue; // no persona file / unreadable → skip
    }

    let extracted;
    let transitions;
    try {
      const raw = await deps.json(
        buildPersonaUpdateRequest({ name: persona.displayName, existing, thread }),
      );
      extracted = parseExtractedCommitments(raw);
      transitions = parseExtractedUpdates(raw, existing.length);
    } catch {
      continue; // a single contact's LLM failure must not sink the pass
    }

    // GROUNDING IS MECHANICAL. Every extraction must quote the corpus verbatim;
    // one that cannot is invented, and an invented "done" silently closes real
    // work (the reverse of the append-only bug). Both prompts have always ASKED
    // for the quote — this is the first time anything checks it. The discard
    // count is reported upward: a high rate is itself a finding about how much
    // the model creates.
    const grounded = <T extends { evidence?: string }>(xs: T[]): T[] =>
      xs.filter((x) => hasVerbatim(thread, x.evidence ?? ""));
    const okExtracted = grounded(extracted);
    const okTransitions = grounded(transitions);
    discarded += extracted.length - okExtracted.length + (transitions.length - okTransitions.length);
    transitions = okTransitions;

    const seen = new Set(existing.map((c) => norm(c.what)));
    const fresh = okExtracted.filter((e) => !seen.has(norm(e.what)));

    // Status transitions FIRST, on a copy. The ledger used to be append-only —
    // dedup-by-wording meant a conversation showing a tracked commitment
    // FINISHED had no way to say so, and two weeks later the engine re-derived
    // the finished work as fresh. Only apply a real change.
    const withStatus = existing.map((c) => ({ ...c }));
    let statusChanged = 0;
    for (const u of transitions) {
      if (withStatus[u.index]!.status === u.status) continue;
      withStatus[u.index]!.status = u.status;
      statusChanged++;
    }
    if (fresh.length === 0 && statusChanged === 0) continue;

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
      [...fresh.map((e) => e.evidence), ...transitions.map((u) => u.evidence)]
        .filter(Boolean)
        .join(" | ") || "extracted from recent conversation";
    try {
      const res = writePersonaFile(file, { set: { commitments: merged }, evidence: { commitments: evidence } }, "llm");
      if (res.applied.includes("commitments")) updated.push({ key, added: fresh.length, statusChanged });
    } catch {
      /* R1 / validation rejection — skip, non-fatal */
    }
  }

  return { updated, discarded };
}

// Same conversation grouping key the rest of the daemon uses.
export { clusterKey };

// Test seam.
export function _resetPersonaUpdateTtl(): void {
  lastUpdateMs.clear();
}
