// The to-do list, derived from the commitment ledger. Pure core, no I/O.
//
// specs/person-first-consolidation.md §3.4: an item exists iff
//
//     who == "me"  AND  status == "open"  AND  assessment.needs_leo
//
// No model authors a row. The title is the commitment's own `what`, the
// checklist is the verdict's grounded `next_step`, the note is the verdict's
// verbatim evidence quote. This replaces the message → card → cluster → rank
// pipeline as the list's source (§7 phase 4): the owner's own review of that
// pipeline's output struck 7 of 19 rows as already finished or never his, and
// every one of those failures traces to authoring rows from conversations
// instead of deriving them from what is actually owed.
//
// Stability falls out of the source: a ledger entry does not flap the way a
// re-ranked tier does, so this needs no hysteresis, no ranking call, and no
// A/B boundary. needs_leo — made expensive to say in the assess prompt — is
// the only gate.
//
// §7b matter chains, minimal form: commitments sharing a matter_id are ONE
// real-world matter, so they produce at most ONE row — the active link where
// the work sits with Leo. A matter whose only open links sit with others
// produces nothing, however many entries it has.
//
// PROMOTION GATE (owner, 2026-09-03): a matter is the owner's own answer to
// "what am I actually working on", so belonging to a LIVE one is what earns a
// row its place on the working list. A commitment with no matter, or one whose
// matter the owner has closed, still gets a row — it sinks to the 待办池 list
// at no priority. It is never dropped: 系统删待办这个概念不存在。
//
// This is the gate the 2026-08-24 clearance did by hand. Ten days later the
// ledger had minted 59 fresh matter-less rows, because a one-off cleanup is
// not a gate. Prompt rules die; code gates live.

import { stableHash } from "./unit-key.js";
import { dueFields } from "./ticktick-plan.js";
import type { TickTickTaskPayload } from "./ticktick.js";
import type { Commitment } from "./persona-v3.js";
import type { DesiredTask } from "./ticktick-sync.js";

export interface LedgerPersona {
  key: string;
  display_name?: string;
  commitments?: Commitment[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Where sunk rows go. The list must exist in TickTick — the io layer resolves
 * a name and throws rather than inventing a list. */
export const POOL_LIST = "待办池";

// Priority is MECHANICAL, from the deadline alone — the ranking pass that used
// to assign tiers is retired. Overdue or imminent work is high; dated work is
// medium; undated work carries no flag, matching the house rule that TickTick's
// date-driven views must never be polluted by invented urgency.
function priorityFor(due: { dueDate: string } | null, nowMs: number): 0 | 3 | 5 {
  if (!due) return 0;
  const t = Date.parse(due.dueDate);
  if (Number.isNaN(t)) return 0;
  if (t < nowMs + 2 * DAY_MS) return 5; // overdue counts: unpaid work is MORE urgent past its date
  if (t < nowMs + 7 * DAY_MS) return 3;
  return 0;
}

function itemFor(
  personaKey: string,
  displayName: string | undefined,
  lead: Commitment,
  chain: readonly Commitment[],
  zone: string,
  nowMs: number,
  sunk: boolean,
): DesiredTask {
  const steps = chain
    .map((c) => c.assessment?.next_step?.trim())
    .filter((s): s is string => !!s);
  const due = lead.due ? dueFields(lead.due, zone) : null;
  // The evidence is the row's provenance — the reader can see WHY this is on
  // the list without opening the conversation. Source language is preserved
  // because the quote is verbatim by construction.
  const noteLines = [
    lead.assessment?.evidence ? `依据: "${lead.assessment.evidence}"` : "",
    displayName ? `— ${displayName}` : `— ${personaKey}`,
  ].filter(Boolean);
  const note = noteLines.join("\n");

  const payload: TickTickTaskPayload = {
    title: lead.what,
    kind: steps.length > 0 ? "CHECKLIST" : "TEXT",
    // A sunk row carries no urgency by construction — priority is what pulls a
    // row into the owner's day, and nothing outside a live matter may do that.
    priority: sunk ? 0 : priorityFor(due, nowMs),
    ...(sunk ? { project: POOL_LIST } : {}),
    ...(steps.length > 0
      ? { desc: note, items: steps.map((title, i) => ({ title, status: 0 as const, sortOrder: i })) }
      : { content: note }),
    tags: ["secretary"],
    ...(due ? { ...due, timeZone: zone } : {}),
  };
  return {
    // Keyed by persona + the commitment's own wording. A reworded `what` mints
    // a new key, and the sync's title-match adoption then updates the same
    // TickTick task in place instead of creating a twin.
    unitKey: `ledger_${personaKey}_${stableHash(lead.what.trim())}`,
    payload,
  };
}

/**
 * Every row the ledger owes the list right now.
 *
 * `activeMatters` is the owner's live registry (io/matters.ts). It is required,
 * not optional: a caller that forgets it would silently reopen the leak this
 * gate exists to close.
 */
export function deriveLedgerTasks(
  personas: ReadonlyArray<LedgerPersona>,
  zone: string,
  nowMs: number,
  activeMatters: ReadonlySet<string>,
): DesiredTask[] {
  const out: DesiredTask[] = [];
  for (const p of personas) {
    const open = (p.commitments ?? []).filter((c) => c.status === "open");

    // Matters first: all open links sharing a matter_id are one unit of work.
    const inMatter = new Set<Commitment>();
    const matters = new Map<string, Commitment[]>();
    for (const c of open) {
      if (!c.matter_id) continue;
      inMatter.add(c);
      const m = matters.get(c.matter_id) ?? [];
      m.push(c);
      matters.set(c.matter_id, m);
    }
    for (const [matterId, chain] of matters) {
      // The ACTIVE link is the one where the work sits with Leo. A chain whose
      // open links all sit with others is tracked but owes no row — exactly how
      // the owner adjudicated the antenna matter by hand.
      const lead = chain.find((c) => c.who === "me" && c.assessment?.needs_leo);
      if (!lead) continue;
      out.push(itemFor(p.key, p.display_name, lead, chain, zone, nowMs, !activeMatters.has(matterId)));
    }

    for (const c of open) {
      if (inMatter.has(c)) continue;
      if (c.who !== "me" || !c.assessment?.needs_leo) continue;
      out.push(itemFor(p.key, p.display_name, c, [c], zone, nowMs, true));
    }
  }
  return out;
}
