// Persona-update pass (Phase B, specs/persona-v3.md): for each contact with an
// open card + a resolved persona, re-read the recent thread, extract NEW
// commitments, and merge them into the persona's Commitments Ledger via the R1
// write chokepoint (writePersonaFile actor="llm" — manual fields never touched,
// evidence required). This is the incremental update the roadmap calls Phase B;
// it is NOT the forbidden full bootstrap.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Persona } from "../core/types.js";
import type { PersonQueueEntry } from "../core/person-queue.js";
import type { Commitment } from "../core/persona-v3.js";
import { personaPath, readPersonaV3File, writePersonaFile } from "../io/persona-store.js";
import { evidenceGrounded } from "../core/quote-check.js";
import { isLlmUnavailable } from "../core/inbox.js";
import { coveredByTicket, ticketBlock, ticketByHandle, type OwnerTicket } from "../core/owner-tickets.js";
import { findClosures, spokenFromCorpus, stampOf, type OpenItem } from "../core/closure-check.js";
import { findPlanProgress, planUpdate, type PlanUpdate } from "../core/plan-progress.js";
import { capCorpus, indexCorpus, lineOf, mintable, theirOwnMove } from "../core/corpus-lines.js";
import {
  buildPersonaUpdateRequest,
  parseExtractedCommitments,
  parseExtractedUpdates,
  parseExtractedAssessments,
  type PersonaUpdateRequest,
} from "./persona-update-prompt.js";

export type PersonaUpdateJsonCaller = (req: PersonaUpdateRequest) => Promise<unknown>;

/** A thrown-away extraction or verdict, with why (see extractCommitmentsOnce). */
export interface DiscardRecord {
  at: string;
  persona: string;
  kind: "commitment" | "transition" | "assessment";
  reason: "ungrounded" | "incoherent" | "their-own-move" | "same-utterance";
  evidence: string;
  index?: number;
}

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
  /** The owner's matter labels by id, so the model files by scope, not slug. */
  matterLabels?: () => Readonly<Record<string, string>>;
  /** His own TickTick tickets, read per call (core/owner-tickets.ts). */
  ownerTickets?: () => readonly OwnerTicket[];
  /** His decision profile — who does what — read per call so an edit applies next tick. */
  leoProfile?: () => string;
  /** Dates the ASSESS verdicts. */
  now?: () => string;
  /** Where a discarded extraction/verdict is recorded. See extractCommitmentsOnce. */
  onDiscard?: (rec: DiscardRecord) => void;
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

export interface PersonaUpdateResult {
  updated: Array<{ key: string; added: number; statusChanged: number; assessed: number }>;
  /** Extractions and verdicts thrown away because their quote is not in the corpus. */
  discarded: number;
  /** ASSESS verdicts written. The discard/assess ratio is how model invention is watched. */
  assessed: number;
  /** Everyone the pass finished with — judged, or unreadable. Cursors advance for these. */
  attempted: PersonQueueEntry[];
  /**
   * Everyone whose LLM call FAILED (timeout, auth, unparseable reply). Their
   * cursor must NOT advance: it used to, silently, so the traffic that queued
   * them was never looked at again — Trey's 9/30 「总算完事了」, the BC company
   * filed and paid, left the ticket saying 「Handle BC company registration」
   * two days later. The caller retries them, up to a limit.
   */
  failed: PersonQueueEntry[];
  /**
   * Everyone whose call failed because the LLM itself is UNAVAILABLE (logged
   * out, refused). Held like `failed` but never counted toward giving up —
   * core/inbox.ts isLlmUnavailable.
   */
  unavailable: PersonQueueEntry[];
  /**
   * Keys whose corpus came back empty — no handles, or every source failed.
   * Reported rather than silently skipped (spec §6.2): a person reachable on no
   * mapped handle is invisible to their own pass, and that is a data bug worth
   * seeing. Their cursor still advances, so one unreachable contact cannot
   * occupy the oldest-first slot every tick and starve everyone behind them;
   * their next message re-queues them.
   */
  unreadable: string[];
  /** Listed commitments the conversation showed DONE (core/closure-check.ts). */
  closedDone: number;
  /** Changes to his plan tickets this pass found (core/plan-progress.ts); the caller writes them. */
  planUpdates: PlanUpdate[];
}

export async function updatePersonaCommitments(
  /** Who to assess — already selected and capped by core/person-queue. */
  queue: ReadonlyArray<PersonQueueEntry>,
  deps: PersonaUpdateDeps,
): Promise<PersonaUpdateResult> {
  const updated: PersonaUpdateResult["updated"] = [];
  const attempted: PersonQueueEntry[] = [];
  const failed: PersonQueueEntry[] = [];
  const unavailable: PersonQueueEntry[] = [];
  const unreadable: string[] = [];
  // The call's error is swallowed inside extractCommitmentsOnce; keep the last
  // one so an auth outage can be told from a bad reply.
  let lastError: string | undefined;
  const json: PersonaUpdateJsonCaller = async (req) => {
    try {
      return await deps.json(req);
    } catch (e) {
      lastError = (e as Error)?.message ?? String(e);
      throw e;
    }
  };
  let discarded = 0;
  let assessed = 0;
  let closedDone = 0;
  const planUpdates: PlanUpdate[] = [];
  // Which corpus lines already minted a commitment, and for whom — so a group
  // line read in several members' corpora mints once (source_line).
  const claimed = claimedLines(deps.personaDir);

  for (const entry of queue) {
    lastError = undefined; // a previous contact's error must not classify this one
    const persona = deps.personaFor(entry.personaKey);
    if (!persona) {
      unreadable.push(entry.personaKey);
      attempted.push(entry);
      continue;
    }
    const corpus = await deps.fetchCorpus(persona);
    // A persona FILE that cannot be read is not a failed call — retrying will
    // not help — so it is reported and advanced like a missing corpus. Checked
    // here because extractCommitmentsOnce answers null for both, and only the
    // LLM failure deserves a retry.
    let fileOk = true;
    try {
      readPersonaV3File(personaPath(deps.personaDir, entry.personaKey));
    } catch {
      fileOk = false;
    }
    if (!corpus || !fileOk) {
      unreadable.push(entry.personaKey);
      attempted.push(entry);
      continue;
    }

    const r = await extractCommitmentsOnce({
      file: personaPath(deps.personaDir, entry.personaKey),
      displayName: persona.displayName,
      corpus,
      json,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.onDiscard ? { onDiscard: deps.onDiscard } : {}),
      ...(deps.matterLabels ? { matterLabels: deps.matterLabels() } : {}),
      ...(deps.ownerTickets ? { ownerTickets: deps.ownerTickets() } : {}),
      ...(deps.leoProfile ? { leoProfile: deps.leoProfile() } : {}),
      personaKey: entry.personaKey,
      claimedLines: claimed,
    });
    if (!r) {
      (isLlmUnavailable(lastError) ? unavailable : failed).push(entry);
      lastError = undefined;
      continue;
    }
    attempted.push(entry);
    discarded += r.discarded;
    assessed += r.assessed;
    // Capped like the assess call: an uncapped corpus is the 400k-character
    // timeout capCorpus exists to prevent.
    closedDone += await closeDoneCommitments(personaPath(deps.personaDir, entry.personaKey), persona.displayName, capCorpus(corpus), json);
    planUpdates.push(...r.newSteps);
    // His plans, from what is NEW since this person was last assessed. No
    // cursor yet → nothing: the first pass must not replay all of history.
    const tickets = deps.ownerTickets?.() ?? [];
    if (tickets.length > 0 && entry.sinceMs) {
      const since = localStamp(entry.sinceMs);
      const fresh = spokenFromCorpus(corpus).filter((s) => s.stamp !== undefined && s.stamp > since);
      planUpdates.push(...(await findPlanProgress(persona.displayName, tickets, fresh, json, localStamp(Date.now()))));
    }
    if (r.added > 0 || r.statusChanged > 0 || r.assessed > 0)
      updated.push({
        key: entry.personaKey,
        added: r.added,
        statusChanged: r.statusChanged,
        assessed: r.assessed,
      });
  }

  return { updated, discarded, assessed, attempted, failed, unavailable, unreadable, closedDone, planUpdates };
}

/** "YYYY-MM-DD HH:MM" in the machine's zone — the stamp corpus lines carry. */
function localStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Close the LISTED commitments this corpus shows done (core/closure-check.ts).
 * Only rows on his list are asked about — a live verdict, not covered — and
 * only from lines later than the one the verdict stood on, so the request
 * cannot close itself. Returns how many closed; any failure closes nothing.
 */
async function closeDoneCommitments(
  file: string,
  name: string,
  corpus: string,
  json: PersonaUpdateJsonCaller,
): Promise<number> {
  let commitments: Commitment[];
  try {
    commitments = readPersonaV3File(file).commitments ?? [];
  } catch {
    return 0;
  }
  const lines = indexCorpus(corpus);
  const items: Array<OpenItem & { index: number }> = [];
  commitments.forEach((c, index) => {
    if (c.status !== "open" || c.covered_by || c.assessment?.needs_leo !== true) return;
    const from = lineOf(lines, c.assessment.evidence ?? "")?.text ?? c.source_line;
    const after = from ? stampOf(from) : undefined;
    if (!after) return; // nothing to order against — never guess which lines are "later"
    items.push({ index, handle: `R${items.length + 1}`, what: c.what, side: c.who === "me" ? "me" : "them", after });
  });
  if (items.length === 0) return 0;
  const found = await findClosures(name, items, spokenFromCorpus(corpus), json);
  if (found.length === 0) return 0;
  const next = commitments.map((c) => ({ ...c }));
  for (const f of found) next[(f.item as OpenItem & { index: number }).index]!.status = "done";
  try {
    const res = writePersonaFile(
      file,
      { set: { commitments: next }, evidence: { commitments: found.map((f) => `closure: ${f.evidence}`).join(" | ") } },
      "llm",
    );
    return res.applied.includes("commitments") ? found.length : 0;
  } catch {
    return 0;
  }
}

/** source_line → persona key, over every OPEN commitment on file. Total: unreadable files are skipped. */
function claimedLines(personaDir: string): Map<string, string> {
  const out = new Map<string, string>();
  let files: string[] = [];
  try {
    files = readdirSync(personaDir).filter((f) => f.endsWith(".yaml"));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const p = readPersonaV3File(join(personaDir, f));
      for (const c of p.commitments ?? []) {
        if (c.status === "open" && c.source_line) out.set(c.source_line, p.key);
      }
    } catch {
      // one broken file must not stop the pass
    }
  }
  return out;
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
  matterLabels?: Readonly<Record<string, string>>;
  /** His own tickets; a commitment the model places in one is covered, not listed. */
  ownerTickets?: readonly OwnerTicket[];
  /** His decision profile (who does what) — see buildPersonaUpdateRequest. */
  leoProfile?: string;
  /**
   * Lines that already minted a commitment, by persona — updated in place as
   * this call mints. With `personaKey`, a line another persona already holds
   * mints nothing here. Absent = no cross-persona check (one-off scripts).
   */
  claimedLines?: Map<string, string>;
  personaKey?: string;
  /** Dates each verdict, so a stale needs_leo cannot keep an item alive. */
  now?: () => string;
  /**
   * Where a DISCARDED verdict goes. The draft path learned this the hard way
   * and keeps llm-draft-raw.jsonl; this pass — the one the whole list is
   * derived from — kept nothing, and on 2026-09-12 the console showed six
   * verdicts accepted against forty-seven discarded with no way to see even one
   * of them. A discard rate is a number; a discarded quote is a diagnosis.
   * Absent = no logging (tests, one-off scripts).
   */
  onDiscard?: (rec: DiscardRecord) => void;
}): Promise<{ added: number; statusChanged: number; discarded: number; assessed: number; newSteps: PlanUpdate[] } | null> {
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
  // A chatty contact's corpus is enormous and the call simply never returns:
  // measured 2026-09-13, 385k and 427k characters both hit the 180s `claude -p`
  // ceiling, and those were the two contacts with the MOST open commitments.
  // Capped HERE rather than in the corpus builders because there are several of
  // them (the daemon's, the audit script's) and one timeout ceiling.
  const corpus = capCorpus(opts.corpus);
  try {
    const raw = await opts.json(
      buildPersonaUpdateRequest({
        name: opts.displayName,
        existing,
        thread: corpus,
        ...(opts.matterLabels ? { matterLabels: opts.matterLabels } : {}),
        ...(opts.ownerTickets?.length ? { ownerTickets: ticketBlock(opts.ownerTickets) } : {}),
        ...(opts.leoProfile?.trim() ? { leoProfile: opts.leoProfile } : {}),
      }),
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
  } catch (e) {
    // SAY WHY. This was a bare `catch { return null }`: once the caller stopped
    // advancing failed cursors (2026-10-01) the log said 「assessment FAILED for
    // wechat-trey」 and nothing about the cause, so the one thing needed to fix
    // it — timeout? auth? an unparseable reply? — was thrown away right here.
    const msg = (e as Error)?.message ?? String(e);
    console.error(
      `[persona] ${opts.displayName}: assessment call failed (corpus ${corpus.length} chars, ${existing.length} tracked) — ${msg.replace(/\s+/g, " ").slice(0, 240)}`,
    );
    return null;
  }

  // GROUNDING IS MECHANICAL. Every extraction must quote the corpus verbatim;
  // one that cannot is invented, and an invented "done" silently closes real
  // work (the reverse of the append-only bug). The discard count is reported
  // upward: a high rate is itself a finding about how much the model creates.
  const nowIso = (opts.now ?? (() => new Date().toISOString()))();
  const note = (
    kind: "commitment" | "transition" | "assessment",
    reason: DiscardRecord["reason"],
    evidence: string,
    index?: number,
  ): void =>
    opts.onDiscard?.({ at: nowIso, persona: opts.file, kind, reason, evidence, ...(index !== undefined ? { index } : {}) });

  const grounded = <T extends { evidence?: string; index?: number; unseen?: boolean }>(
    xs: T[],
    kind: "commitment" | "transition" | "assessment",
  ): T[] =>
    xs.filter((x) => {
      // A verdict that says "this conversation never mentions it" has nothing to
      // quote, and holding it to the quote gate is what silently produced 39
      // never-judged commitments: the model answered honestly in prose and the
      // gate read that prose as invention. See CommitmentAssessment.unseen.
      if (x.unseen === true) return true;
      if (evidenceGrounded(corpus, x.evidence ?? "")) return true;
      note(kind, "ungrounded", x.evidence ?? "", x.index);
      return false;
    });
  const okExtracted = grounded(extracted, "commitment");
  const okTransitions = grounded(transitions, "transition");
  // COHERENCE, mechanically. "Leo does not need to act on this, and the work
  // sits with Leo" cannot both be true, and the derive step drops a row that
  // needs nobody — so a self-contradicting verdict silently CLOSES a live
  // to-do. The 2026-09-06 backfill produced three, each quoting the contact
  // complaining about being busy ("This week is a bit crazy", "This xEV
  // project is killing me") as grounds for the owner being off the hook.
  // A verdict like this is discarded whole: the commitment keeps whatever it
  // had, which is the safe direction.
  const corpusLines = indexCorpus(corpus);
  const okAssessments = grounded(assessments, "assessment")
    .filter((a) => {
      if (!(a.needs_leo === false && a.blocked_on === "leo")) return true;
      note("assessment", "incoherent", a.evidence ?? "", a.index);
      return false;
    })
    // THEIR OWN MOVE IS NOT HIS TO-DO. 2026-10-03 the owner dismissed 15 rows;
    // six stood on the contact announcing their OWN next step — 「Let me talk
    // with more customers and Renesas」, 「I can try」, 「我再和他argue一下」,
    // 「我们下周去和临港汇报一下」. The quote is the verdict's whole case, and it
    // says the other side is moving. Kept as a verdict, turned the right way
    // round: open, tracked, sitting with them.
    .map((a) => {
      if (!a.needs_leo || !theirOwnMove(corpusLines, a.evidence ?? "")) return a;
      note("assessment", "their-own-move", a.evidence ?? "", a.index);
      const { next_step: _drop, ...rest } = a;
      return { ...rest, needs_leo: false, blocked_on: "them" as const };
    });
  const discarded =
    extracted.length -
    okExtracted.length +
    (transitions.length - okTransitions.length) +
    (assessments.length - okAssessments.length) +
    parseDropped;

  const at = nowIso;
  const seen = new Set(existing.map((c) => norm(c.what)));

  // STRUCTURAL GATES — core/corpus-lines.ts `mintable`, the ONE implementation
  // the bench also runs, so what ships here is what the scorecard measures.
  const lines = corpusLines;
  const nowMs = Date.parse(at);
  let gated = 0;
  const fresh = okExtracted.filter((e) => !seen.has(norm(e.what))).filter((e) => {
    if (mintable(lines, e, nowMs)) return true;
    gated++;
    return false;
  });
  // ONE LINE, ONE COMMITMENT. Only a dated, attributed line counts — a Gmail
  // body line or a stitched quote resolves to nothing and is never deduped.
  const sourceOf = (e: { evidence?: string }): string | undefined => {
    const line = lineOf(lines, e.evidence ?? "");
    return line && line.speaker !== "unknown" ? line.text.trim() : undefined;
  };
  const minted = fresh.filter((e) => {
    const src = sourceOf(e);
    const holder = src ? opts.claimedLines?.get(src) : undefined;
    if (!holder || holder === opts.personaKey) return true;
    note("commitment", "same-utterance", e.evidence ?? "");
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
    // BOTH sides now. Restricting verdicts to who=me left 107 open commitments —
    // over half the ledger — permanently unjudged, and 「中汽研第一阶段的款还没
    // 付」 with no route to the list. What needs_leo MEANS is unchanged: does
    // this need Leo's own time. On a commitment they owe, the answer is yes
    // exactly when the chase is his (prompt: WHO=THEM).
    if (target.status !== "open") continue;
    // In one of HIS tickets → tracked there; never listed again from here. The
    // handle is checked against the real tickets, so an invented one is inert.
    const ticket = ticketByHandle(opts.ownerTickets ?? [], a.covered_by_ticket);
    if (ticket) {
      target.covered_by = coveredByTicket(ticket);
      target.assessment = { needs_leo: false, evidence: a.unseen ? "" : a.evidence, at };
      assessed++;
      continue;
    }
    target.assessment = {
      needs_leo: a.needs_leo,
      ...(a.blocked_on ? { blocked_on: a.blocked_on } : {}),
      ...(a.needs_leo && a.next_step?.trim() ? { next_step: a.next_step.trim() } : {}),
      // Marked, not blended: "the thread is silent about this" and "I read the
      // thread and he is off the hook" both set needs_leo=false, and only one of
      // them is evidence of anything.
      ...(a.unseen ? { unseen: true } : {}),
      evidence: a.unseen ? "" : a.evidence,
      at,
    };
    assessed++;
  }

  if (minted.length === 0 && statusChanged === 0 && assessed === 0)
    return { added: 0, statusChanged: 0, discarded, assessed: 0, newSteps: [] };

  const ticketOf = (e: { covered_by_ticket?: string }) => ticketByHandle(opts.ownerTickets ?? [], e.covered_by_ticket);
  const merged: Commitment[] = [
    ...withStatus,
    ...minted.map((e) => ({
      who: e.who,
      what: e.what,
      status: e.status ?? "open",
      ...(e.due ? { due: e.due } : {}),
      ...(e.matter_id ? { matter_id: e.matter_id.trim() } : {}),
      ...((t) => (t ? { covered_by: coveredByTicket(t) } : {}))(ticketOf(e)),
      ...((src) => (src ? { source_line: src } : {}))(sourceOf(e)),
    })),
  ];
  const evidence =
    [
    ...minted.map((e) => e.evidence),
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
    if (!res.applied.includes("commitments")) return { added: 0, statusChanged: 0, discarded, assessed: 0, newSteps: [] };
  } catch {
    return { added: 0, statusChanged: 0, discarded, assessed: 0, newSteps: [] };
  }
  // Claimed only once written, so a later persona in this pass sees it.
  if (opts.claimedLines && opts.personaKey) {
    for (const e of minted) {
      const src = sourceOf(e);
      if (src) opts.claimedLines.set(src, opts.personaKey);
    }
  }
  // Work of his that belongs to one of his plans but is not a step there yet
  // becomes one (core/plan-progress.ts ADDED_PREFIX). Only his own work, and
  // only once it is written.
  const newSteps: PlanUpdate[] = minted.flatMap((e) => {
    const t = ticketOf(e);
    return t && e.who === "me" && e.ticket_step === undefined ? [planUpdate(t.id, [e.what.trim()])] : [];
  });
  return { added: minted.length, statusChanged, discarded, assessed, newSteps };
}
