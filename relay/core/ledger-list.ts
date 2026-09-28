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
// WHAT EARNS A ROW ITS PLACE (owner, 2026-09-07: 「verdict说了算」):
//
//   the VERDICT promotes. needs_leo means he must act, and that reaches the
//   working list whether or not the work has been filed under a matter.
//   Everything else sinks to 待办池 at no priority, never dropped —
//   系统删待办这个概念不存在。
//
//   the one exception is a matter the OWNER CLOSED. That is him saying the work
//   is over, and his ruling outranks a model verdict. An UNREGISTERED matter id
//   is not this case — the extraction prompt lets the model coin one for a
//   fresh chain, which is filing in progress.
//
// This replaces the 2026-09-03 rule, which required a live matter to promote.
// That rule buried genuinely new work: 10 commitments judged needs_leo sat in
// the pool solely for mapping to no registered matter — 「订 500 个电源适配器」,
// 「联系谢尔福德谈股份分配」 — and the bench missed all seven items the owner
// had named himself, because new work has no matter by definition. A matter is
// how work is FILED; a verdict is how it is DECIDED.

import { stableHash } from "./unit-key.js";
import { dueFields } from "./ticktick-plan.js";
import { MINT_WINDOW_DAYS } from "./corpus-lines.js";
import type { TickTickTaskPayload } from "./ticktick.js";
import type { Commitment } from "./persona-v3.js";
import type { DesiredTask } from "./ticktick-sync.js";

export interface LedgerPersona {
  key: string;
  display_name?: string;
  commitments?: Commitment[];
}

/** How a row reads — see itemFor's `mode`. */
type RowMode = "own" | "chase" | "waiting";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Where sunk rows go. The list must exist in TickTick — the io layer resolves
 * a name and throws rather than inventing a list. */
export const POOL_LIST = "待办池";

/**
 * Namespace for a MATTER row's hash, so it cannot be confused with a
 * commitment's. Both live in the same `ledger_<persona>_<hash>` key shape —
 * one key format, one parser, and ledger-close tells them apart by asking the
 * commitment (commitmentMatchesHash) rather than by re-parsing the string.
 */
const MATTER_TAG = "matter:";

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

/**
 * Did the OTHER side miss a deadline RECENTLY enough that chasing is the move?
 *
 * Two bounds, and the second one cost the owner a screen full of noise:
 *
 *   - only a parseable date counts. 「end of weekend」 is a promise, not a
 *     deadline; 8 of the ledger's 27 dated who=them entries read like that, and
 *     treating them as dates would invent lateness nobody stated.
 *   - the miss must be INSIDE the mint window. 2026-09-06: a deadline from
 *     Jul 27 minted a fresh 催 six weeks later, alongside a 催 to prepare for a
 *     meeting that had already happened. 「基本都是过期的或者过分生成的」. A date
 *     that old is not someone running late, it is history, and the owner's
 *     word for history is 「很久以前」.
 *
 * A stale miss is not lost — it falls through to the floor like any other
 * dormant commitment. It just stops shouting.
 */
function recentlyOverdue(due: string | undefined, nowMs: number): boolean {
  if (!due) return false;
  const t = Date.parse(due);
  if (Number.isNaN(t)) return false;
  return t < nowMs && nowMs - t <= MINT_WINDOW_DAYS * DAY_MS;
}

/**
 * A who=me commitment whose own stated date is LONG past.
 *
 * Not "past" — long past. priorityFor deliberately pushes a freshly overdue row
 * to the TOP ("unpaid work is MORE urgent past its date"), and that is right:
 * an unpaid invoice does not get less urgent on the 3rd of the month. So this
 * cannot fire the moment a date slips, or it would bury exactly the rows the
 * owner most needs.
 *
 * What it fires on is a date that went by TWO WEEKS ago and still has nothing
 * behind it. Measured 2026-09-13, when the owner adjudicated his whole ledger:
 * 78 of 91 open commitments were dead, and the dominant shape was a
 * DATE-ANCHORED OCCASION rather than a deadline — 「周四先去奇迹当面看一下」,
 * 「周一(8/24)向瑞萨试探」, 「Visit/meet Amlogic on Sept 1」. The occasion passed,
 * so the work is moot; nothing in the text distinguishes it from an invoice,
 * and no code can tell them apart. Two weeks is the compromise: a real deadline
 * gets a fortnight at the top of his list before it sinks, and a dead
 * appointment stops occupying the list forever.
 *
 * SINKING IS NOT DELETION. The row moves to the pool with priority 0 — the
 * owner's own rule, 「如果还是待办，但是优先级较低，那就往后排」. A commitment
 * only ends by being done or dropped, and neither happens here.
 *
 * Same window and same parse rule as recentlyOverdue above, which governs the
 * mirror case on the other side (chasing what THEY owe). One horizon, both
 * directions.
 */
function longOverdue(due: string | undefined, nowMs: number): boolean {
  if (!due) return false;
  const t = Date.parse(due);
  if (Number.isNaN(t)) return false;
  return nowMs - t > MINT_WINDOW_DAYS * DAY_MS;
}

function itemFor(
  personaKey: string,
  displayName: string | undefined,
  lead: Commitment,
  chain: readonly Commitment[],
  zone: string,
  nowMs: number,
  sunk: boolean,
  /**
   * Whose move it is, which decides how the row READS.
   *
   *   own     — Leo's work. The title is the commitment.
   *   chase   — they are late, or the verdict says he is the one waiting, so
   *             his to-do is the phone call: 「催: …」.
   *   waiting — the matter is live but nothing is his right now. Neither of the
   *             above is honest: it is not his task, and nobody is late.
   *
   * A boolean could not tell the last two apart, and conflating them is how a
   * parked matter would start shouting 催 at him.
   */
  mode: RowMode = "own",
  /**
   * Set when this row stands for a whole MATTER rather than one commitment.
   * `all` is every link the matter has ever had, open and settled, so the note
   * can state progress.
   */
  matter?: { id: string; all: readonly Commitment[] },
): DesiredTask {
  const steps = chain
    .map((c) => c.assessment?.next_step?.trim())
    .filter((s): s is string => !!s);
  const due = lead.due ? dueFields(lead.due, zone) : null;
  // The evidence is the row's provenance — the reader can see WHY this is on
  // the list without opening the conversation. Source language is preserved
  // because the quote is verbatim by construction.
  const who = displayName ?? personaKey;
  const noteLines = [
    mode === "chase"
      ? `${who} 欠这件事` +
        (recentlyOverdue(lead.due, nowMs) ? `,${lead.due} 已过期。` : ",你在等它。")
      : mode === "waiting"
        ? `这件事还没完,但眼下不用你动——在等 ${who}。`
        : "",
    matter ? matterProgress(matter.all, lead, displayName ?? personaKey) : "",
    lead.assessment?.evidence ? `依据: "${lead.assessment.evidence}"` : "",
    displayName ? `— ${displayName}` : `— ${personaKey}`,
  ].filter(Boolean);
  const note = noteLines.join("\n");

  const payload: TickTickTaskPayload = {
    // The owner's action on someone else's missed deadline is to chase it. The
    // row names that action, not their work — his to-do is the phone call.
    title:
      mode === "chase" ? `催: ${lead.what}` : mode === "waiting" ? `等: ${lead.what}` : lead.what,
    kind: steps.length > 0 ? "CHECKLIST" : "TEXT",
    // A sunk row carries no urgency by construction — priority is what pulls a
    // row into the owner's day, and nothing outside a live matter may do that.
    priority: sunk ? 0 : priorityFor(due, nowMs),
    ...(sunk ? { project: POOL_LIST } : {}),
    // BOTH note fields and `items`, ALWAYS — the rule card rows already follow
    // (core/ticktick-plan.ts), which this path never did. update_task is a
    // PARTIAL patch: a field we omit keeps whatever TickTick already holds. Once
    // matter rows started re-rendering their note, a row that flipped between
    // TEXT and CHECKLIST wrote the fresh note into the field TickTick was NOT
    // showing and left the old one visible. Seen 2026-09-28 on the WiFi-patch
    // row: `content` carried the new 「进度: 共 3 项」 note, `desc` — the one a
    // checklist task displays — still carried the week-old quote. The
    // self-updating description was updating somewhere he could not see.
    desc: steps.length > 0 ? note : "",
    content: steps.length > 0 ? "" : note,
    items: steps.map((title, i) => ({ title, status: 0 as const, sortOrder: i })),
    tags: ["secretary"],
    ...(due ? { ...due, timeZone: zone } : {}),
  };
  return {
    // A MATTER keys by the matter, an unfiled commitment by its own wording.
    //
    // WHY THE DIFFERENCE MATTERS: wording is not identity. The model rewords a
    // commitment as the conversation sharpens it, and a matter's LEAD moves
    // from link to link as the work advances — either one mints a new key,
    // which the sync reads as a new to-do. Measured 2026-09-27 over the seven
    // days after the resurrection fix: 169 creates against 9 updates, with
    // 「约Alger定本周OH3时间」→「约 Alger 定周四下午OH具体时间」→「敲定周四下午与
    // Alger的OH时间」 sitting in the map as three separate rows for one job.
    // 「不要新卡顶替旧卡」 (owner, 2026-09-27).
    //
    // matter_id is the identity the ledger already has: the model assigns it
    // behind the same quote gate as everything else, and it does not move when
    // the chain grows. A commitment with NO matter_id keeps the old wording key
    // — unfiled work has nothing to attach to, and inventing an attachment is
    // how one contact's card ends up swallowing everything they ever said
    // (core/unit-key.ts). 「归属判不准就新开一张」.
    unitKey: matter
      ? `ledger_${personaKey}_${stableHash(MATTER_TAG + matter.id.trim())}`
      : `ledger_${personaKey}_${stableHash((mode === "chase" ? "chase:" : "") + lead.what.trim())}`,
    payload,
  };
}

/**
 * Where a matter stands right now, for the row's note.
 *
 * THIS IS THE SELF-UPDATING PART. The row's key no longer moves, so every new
 * link the conversation adds — and every link that closes — re-renders this
 * block and the sync writes it over the SAME TickTick task. 「后续有新的
 * information更新，直接更新目前ticket的Description区域」 (owner, 2026-09-27).
 *
 * It re-renders rather than appends: 「我不是要不断叠加」. Settled links are a
 * COUNT, not a list — the ledger records no completion date, so any "recently
 * finished" ordering would be array order dressed up as chronology.
 */
function matterProgress(all: readonly Commitment[], lead: Commitment, them: string): string {
  const open = all.filter((c) => c.status === "open");
  const settled = all.length - open.length;
  // The LEAD is already the row's title; repeating it here just made the note
  // open with the sentence above it.
  const rest = open.filter((c) => c !== lead);
  const mine = rest.filter((c) => c.who === "me").map((c) => c.what.trim());
  const theirs = rest.filter((c) => c.who !== "me").map((c) => c.what.trim());
  return [
    `进度: 共 ${all.length} 项,已了结 ${settled} 项。`,
    mine.length > 0 ? `我这边还有:\n${mine.map((w) => `  · ${w}`).join("\n")}` : "",
    theirs.length > 0 ? `等 ${them}:\n${theirs.map((w) => `  · ${w}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
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
  /** Matters the owner CLOSED. Work inside one sinks whatever the verdict says. */
  closedMatters: ReadonlySet<string> = new Set(),
): DesiredTask[] {
  const out: DesiredTask[] = [];
  for (const p of personas) {
    const open = (p.commitments ?? []).filter((c) => c.status === "open");

    // Matters first: all open links sharing a matter_id are one unit of work.
    // `all` carries the SETTLED links too — they are not rows, but they are how
    // the note states progress, and progress is what makes the row worth
    // re-reading a week later.
    const inMatter = new Set<Commitment>();
    const matters = new Map<string, Commitment[]>();
    const allByMatter = new Map<string, Commitment[]>();
    for (const c of p.commitments ?? []) {
      if (!c.matter_id) continue;
      const a = allByMatter.get(c.matter_id) ?? [];
      a.push(c);
      allByMatter.set(c.matter_id, a);
    }
    for (const c of open) {
      if (!c.matter_id) continue;
      inMatter.add(c);
      const m = matters.get(c.matter_id) ?? [];
      m.push(c);
      matters.set(c.matter_id, m);
    }
    for (const [matterId, chain] of matters) {
      const all = allByMatter.get(matterId) ?? chain;
      const as = { id: matterId, all };
      // The ACTIVE link is the one where the work sits with Leo.
      const closed = closedMatters.has(matterId);
      const lead = chain.find((c) => c.who === "me" && c.assessment?.needs_leo);
      if (lead) {
        out.push(itemFor(p.key, p.display_name, lead, chain, zone, nowMs, closed || longOverdue(lead.due, nowMs), "own", as));
        continue;
      }
      const sunk = closed || !activeMatters.has(matterId);
      // Nothing on my side is live — but the waiting can still be mine, either
      // because they are past a date they gave me, or because the assess pass
      // judged that I am the one left waiting (中汽研's payment carries no date
      // at all, which is why the verdict route has to exist beside the dates).
      const late = chain.find(
        (c) => c.who === "them" && (recentlyOverdue(c.due, nowMs) || c.assessment?.needs_leo),
      );
      if (late) {
        out.push(itemFor(p.key, p.display_name, late, chain, zone, nowMs, sunk, "chase", as));
        continue;
      }
      // Still open, just not now. The owner's rule is that only done or dropped
      // ends a commitment — 「如果还是待办，但是优先级较低，那就往后排」 — so a
      // matter with nothing live sinks to the floor instead of vanishing.
      // Vanishing is what the sync reads as "finished", and on 2026-09-06 that
      // was one push away from closing three live to-dos.
      //
      // ANY open link holds the floor — not just a who=me one (owner,
      // 2026-09-28: 「补上，沉到待办池，不升顶」).
      //
      // The old rule asked for a dormant commitment of MINE and rendered
      // NOTHING when it found none, which was survivable only while a row's key
      // moved on its own. Under a stable matter key, no row in `desired` is
      // exactly how the sync spells "finished", so a live matter auto-completed
      // its own ticket. Both halves were measured on the real account the same
      // week: 金小奇's equity matter — twelve links, six open, the whole 股权变更
      // inside it — produced zero rows on 2026-09-27; and on 2026-09-28 the
      // 大众VW cascade matter had its ticket completed with two links still
      // open, because the chase window expired and nothing else held it.
      //
      // ALWAYS SUNK, never promoted. The floor is the whole point: 「不升顶」.
      // What reaches the top of the list is unchanged — a verdict promotes, and
      // nothing here fakes one.
      const dormant = chain.find((c) => c.who === "me");
      if (dormant) out.push(itemFor(p.key, p.display_name, dormant, chain, zone, nowMs, true, "own", as));
      else if (chain[0]) out.push(itemFor(p.key, p.display_name, chain[0], chain, zone, nowMs, true, "waiting", as));
    }

    for (const c of open) {
      if (inMatter.has(c)) continue;
      if (c.who === "them" && (recentlyOverdue(c.due, nowMs) || c.assessment?.needs_leo)) {
        out.push(itemFor(p.key, p.display_name, c, [c], zone, nowMs, true, "chase"));
        continue;
      }
      if (c.who !== "me") continue;
      // No matter_id at all — unfiled, not closed. The verdict decides, and a
      // date that went by a fortnight ago overrides a stale yes: see longOverdue.
      out.push(
        itemFor(p.key, p.display_name, c, [c], zone, nowMs, !c.assessment?.needs_leo || longOverdue(c.due, nowMs)),
      );
    }
  }
  return out;
}

// ── the inverse, for read-back ──────────────────────────────────────────
//
// A ledger row carries NO ActionItem, so when the owner finished one in
// TickTick there was nothing to mark done: the commitment stayed `open`, the
// next tick re-derived the row, and the diff reopened the task. Measured on the
// real account, 50-70 rows resurrected every single tick — which is why the
// owner kept re-closing the same work and said the list "keeps updating itself".
//
// Lives here, beside the unitKey it decodes, so the two cannot drift apart.

const LEDGER_PREFIX = "ledger_";

export function parseLedgerUnitKey(unitKey: string): { personaKey: string; hash: string } | null {
  if (!unitKey.startsWith(LEDGER_PREFIX)) return null;
  const cut = unitKey.lastIndexOf("_");
  if (cut < LEDGER_PREFIX.length) return null;
  const personaKey = unitKey.slice(LEDGER_PREFIX.length, cut);
  const hash = unitKey.slice(cut + 1);
  // A personaKey may itself contain "_", which is why the LAST "_" splits.
  return personaKey !== "" && hash !== "" ? { personaKey, hash } : null;
}

/**
 * Does this commitment sit behind that row?
 *
 * Three spellings, because one key shape serves three kinds of row: its own
 * wording, its "chase:"-prefixed wording, and — for a MATTER row — its
 * matter_id. The matter case is why this takes the commitment rather than the
 * `what` string: finishing a matter's row means the MATTER is finished, so
 * every open link in it closes, not just whichever one happened to be the
 * lead when the owner ticked it.
 */
export function commitmentMatchesHash(
  c: { what: string; matter_id?: string },
  hash: string,
): boolean {
  const w = c.what.trim();
  if (stableHash(w) === hash || stableHash("chase:" + w) === hash) return true;
  const m = c.matter_id?.trim();
  return m !== undefined && m !== "" && stableHash(MATTER_TAG + m) === hash;
}
