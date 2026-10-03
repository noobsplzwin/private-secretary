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
//   Everything else sinks — priority 0, never dropped (it went to 待办池
//   until 2026-09-28; see ONE LIST below) —
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
import { dueFields, DISMISS_LINE } from "./ticktick-plan.js";
import { MINT_WINDOW_DAYS } from "./corpus-lines.js";
import type { TickTickTaskPayload } from "./ticktick.js";
import type { Commitment } from "./persona-v3.js";
import type { DesiredTask, SyncMap } from "./ticktick-sync.js";

export interface LedgerPersona {
  key: string;
  display_name?: string;
  commitments?: Commitment[];
}

/** How a row reads — see itemFor's `mode`. */
type RowMode = "own" | "chase";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What may put a row on the list at all (owner, 2026-09-29: 「全都是错的」 about
 * the batch that reached Work when the lists merged):
 *
 *   a live VERDICT that it is his move (「verdict说了算」, 2026-09-07), or
 *   an ACTIVE matter in his registry (specs/commitment-brain.md G7, §5 L2).
 *
 * NOT a date on its own. The brain's L1/L2 admit by `due`, but only a due that
 * passed G6 — re-derived from a verbatim quote against the MESSAGE timestamp.
 * This ledger's `due` never went through G6, and what it holds is mostly a
 * date-anchored OCCASION: 「今天下午3:40到楼下接Leo」, 「Join tomorrow's 9am
 * call」, 「把李处汇报会改约到周四」. Admitting by date put 16 such rows on the
 * list, every one of them in the batch he struck; the same shape was the
 * dominant dead commitment when he adjudicated the whole ledger on 9/13.
 *
 * Everything else stays in the ledger, OPEN. Not listing is not removing: the
 * commitment is untouched and returns the moment a verdict makes it his move.
 */

// ONE LIST (owner, 2026-09-28: 「取消待办池，全进 Work」). Sunk rows used to go
// to a second list, 待办池, and that split was the root of two of the worst
// bugs this engine shipped: the readback read only Work, so every sunk row read
// as finished (94 commitments closed behind his back), and orphan cleanup read
// only Work, so 159 strays piled up in the pool. It also never worked as
// designed — the writer cannot move a task, so a row stayed in whichever list
// it was BORN in, and the week's most important row sat in the pool. A list is
// sticky; priority and date update in place. So weight now lives there:
//
//   5  a real deadline within two days, or already past
//   3  his move — a live verdict, or a chase
//   0  light: nothing of his right now (what the pool used to hold)

/**
 * The review clock for a row with NO real deadline (owner, 2026-09-28: every
 * row should carry a date, 「回看日」). A review date is NOT a deadline and the
 * note says so in words — this is what keeps the 2026-08-13 rule honest:
 * 「给每条都编一个『今天到期』，一周之内 Today 就没有意义了」. Nothing here claims
 * a deadline nobody stated; it says when to look again.
 *
 *   his move — the day the verdict said he must act (else the last time the
 *              person spoke), +3
 *
 * A LIGHT row whose review or deadline has passed rolls forward every
 * ROLL_DAYS instead of sitting overdue in Today.
 *
 * There is NO waiting clock. Rows for work sitting with the other side were
 * added 2026-09-28 and struck the next day — 52 「等:」 rows the owner called
 * 「全都是错的」 — because the brain already says so: WAITING occupies no level
 * of the list (specs/commitment-brain.md §5). Nor does a quiet week turn into a
 * 催 on its own; 该催了 is a nudge somebody set, not a timer.
 */
const OWN_REVIEW_DAYS = 3;
const ROLL_DAYS = 7;

function localDate(ms: number, zone: string): string {
  // en-CA formats as YYYY-MM-DD, which dueFields reads as an all-day date.
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(ms),
  );
}

function md(ms: number, zone: string): string {
  const [, m, d] = localDate(ms, zone).split("-");
  return `${Number(m)}/${Number(d)}`;
}

/** Who a row belongs to, plus the one fact about them the review clock needs. */
interface RowOwner {
  key: string;
  name?: string;
  /** When this person last spoke (state.personTraffic) — epoch ms. */
  spokeMs?: number;
}

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
 * SINKING IS NOT DELETION. The row drops to priority 0 — the
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
  owner: RowOwner,
  lead: Commitment,
  chain: readonly Commitment[],
  zone: string,
  nowMs: number,
  sunk: boolean,
  /**
   * Whose move it is, which decides how the row READS.
   *
   *   own   — Leo's work. The title is the commitment.
   *   chase — they are late, or the verdict says he is the one waiting, so
   *           his to-do is the phone call: 「催: …」.
   */
  modeIn: RowMode = "own",
  /**
   * Set when this row stands for a whole MATTER rather than one commitment.
   * `all` is every link the matter has ever had, open and settled, so the note
   * can state progress.
   */
  matter?: { id: string; all: readonly Commitment[] },
): DesiredTask {
  const personaKey = owner.key;
  const displayName = owner.name;
  const steps = chain
    .map((c) => c.assessment?.next_step?.trim())
    .filter((s): s is string => !!s);
  const due = lead.due ? dueFields(lead.due, zone) : null;
  const who = displayName ?? personaKey;

  // ── the date. A real deadline wins; otherwise a REVIEW date, said as one.
  const mode = modeIn;
  const light = sunk;
  let dateLine = "";
  let reviewMs: number | undefined;
  if (!due) {
    const at = Date.parse(lead.assessment?.at ?? "");
    const verdictMs = Number.isNaN(at) ? undefined : at;
    const base = verdictMs ?? owner.spokeMs;
    const baseLabel = verdictMs !== undefined ? "判定要你动手" : `${who} 最后一次说话`;
    if (base === undefined) {
      dateLine = "没有可用的回看基准(从没判定过,近期也没对话),暂不挂日期。";
    } else {
      const first = base + OWN_REVIEW_DAYS * DAY_MS;
      if (light && first <= nowMs) {
        // A LIGHT row whose review passed rolls to its next one instead of
        // sitting overdue — overdue light rows are exactly how Today fills with
        // things nobody has to do. His own live work does NOT roll: overdue is
        // the signal there.
        const k = Math.floor((nowMs - first) / (ROLL_DAYS * DAY_MS)) + 1;
        reviewMs = first + k * ROLL_DAYS * DAY_MS;
        dateLine = `每 ${ROLL_DAYS} 天回看一次,下次 ${md(reviewMs, zone)}(回看日,不是截止)。`;
      } else {
        reviewMs = first;
        dateLine = `回看日 ${md(first, zone)}(${baseLabel} ${md(base, zone)} +${OWN_REVIEW_DAYS} 天),不是截止。`;
      }
    }
  }
  // A LIGHT row whose REAL deadline is past rolls the same way. That date is
  // theirs or history — 「等: Run diagnostics on Rev5」 was carrying 8/18 six
  // weeks later — and 18 such rows would otherwise sit in Today as overdue.
  // The deadline is kept, in the note and in `deadline`; only the date that
  // decides where the row SHOWS moves. His own live work keeps its overdue date.
  if (due && light) {
    const dueMs = Date.parse(due.dueDate);
    if (!Number.isNaN(dueMs) && dueMs + DAY_MS <= nowMs) {
      const k = Math.floor((nowMs - dueMs) / (ROLL_DAYS * DAY_MS)) + 1;
      reviewMs = dueMs + k * ROLL_DAYS * DAY_MS;
      dateLine = `原定截止 ${md(dueMs, zone)} 已过;每 ${ROLL_DAYS} 天回看一次,下次 ${md(reviewMs, zone)}。`;
    }
  }
  const shown = reviewMs !== undefined ? dueFields(localDate(reviewMs, zone), zone) : null;
  const dated = shown ?? due;

  // The evidence is the row's provenance — the reader can see WHY this is on
  // the list without opening the conversation. Source language is preserved
  // because the quote is verbatim by construction.
  const noteLines = [
    mode === "chase"
      ? `${who} 欠这件事` +
        (recentlyOverdue(lead.due, nowMs) ? `,${lead.due} 已过期。` : ",你在等它。")
      : "",
    dateLine,
    matter ? matterProgress(matter.all, lead, displayName ?? personaKey) : "",
    lead.assessment?.evidence ? `依据: "${lead.assessment.evidence}"` : "",
    displayName ? `— ${displayName}` : `— ${personaKey}`,
  ].filter(Boolean);
  const note = noteLines.join("\n");

  const payload: TickTickTaskPayload = {
    // The owner's action on someone else's missed deadline is to chase it. The
    // row names that action, not their work — his to-do is the phone call.
    title: mode === "chase" ? `催: ${lead.what}` : lead.what,
    // Always a checklist: DISMISS_LINE rides on every row.
    kind: "CHECKLIST",
    // Weight, now that there is one list (see the header of ONE LIST above).
    // Only a REAL deadline can reach 5; a review date never raises priority.
    priority: light ? 0 : Math.max(3, priorityFor(due, nowMs)) as 3 | 5,
    // BOTH note fields and `items`, ALWAYS — the rule card rows already follow
    // (core/ticktick-plan.ts), which this path never did. update_task is a
    // PARTIAL patch: a field we omit keeps whatever TickTick already holds. Once
    // matter rows started re-rendering their note, a row that flipped between
    // TEXT and CHECKLIST wrote the fresh note into the field TickTick was NOT
    // showing and left the old one visible. Seen 2026-09-28 on the WiFi-patch
    // row: `content` carried the new 「进度: 共 3 项」 note, `desc` — the one a
    // checklist task displays — still carried the week-old quote. The
    // self-updating description was updating somewhere he could not see.
    desc: note,
    content: "",
    // 🚫 LAST, on every ledger row. The ledger never carried it — only card
    // rows did — so when the lists merged on 2026-09-28, 110 rows reached the
    // owner's Work list with no way to say "this should not be here" except
    // 完成, which closes the commitment as DONE: the exact false-close this
    // engine spent a week undoing. Ticking it drops the commitment instead
    // (proc/ledger-close.ts markLedgerCommitmentsDropped).
    items: [...steps, DISMISS_LINE].map((title, i) => ({ title, status: 0 as const, sortOrder: i })),
    tags: ["secretary"],
    // startDate rides with dueDate (see TickTickTaskPayload.startDate).
    ...(dated ? { ...dated, startDate: dated.dueDate, timeZone: zone } : {}),
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
    ...(due ? { deadline: due.dueDate } : {}),
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
  /** When each persona last spoke (state.personTraffic) — the waiting clock. */
  lastSpoke: Readonly<Record<string, number>> = {},
): DesiredTask[] {
  const out: DesiredTask[] = [];
  for (const p of personas) {
    const owner: RowOwner = {
      key: p.key,
      ...(p.display_name ? { name: p.display_name } : {}),
      ...(lastSpoke[p.key] !== undefined ? { spokeMs: lastSpoke[p.key] } : {}),
    };
    // covered_by: tracked inside another ticket, so no row of its own.
    const open = (p.commitments ?? []).filter((c) => c.status === "open" && !c.covered_by);

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
      // A matter the OWNER CLOSED is over — his ruling outranks any verdict.
      // Its links stay open in the ledger; none of them is listed.
      if (closedMatters.has(matterId)) continue;
      const matterActive = activeMatters.has(matterId);
      const lead = chain.find((c) => c.who === "me" && c.assessment?.needs_leo);
      if (lead) {
        const sunkLead = longOverdue(lead.due, nowMs);
        if (!sunkLead || matterActive) out.push(itemFor(owner, lead, chain, zone, nowMs, sunkLead, "own", as));
        continue;
      }
      const sunk = !matterActive;
      // Nothing on my side is live — but the waiting can still be mine, either
      // because they are past a date they gave me, or because the assess pass
      // judged that I am the one left waiting (中汽研's payment carries no date
      // at all, which is why the verdict route has to exist beside the dates).
      // A chase needs the same footing as any row: a verdict that the waiting is
      // his, or lateness inside a matter he registered. Lateness alone was how
      // 「催: Drive Leo's suitcase over to 张江」 reached the list.
      const late = chain.find(
        (c) => c.who === "them" && (c.assessment?.needs_leo || (matterActive && recentlyOverdue(c.due, nowMs))),
      );
      if (late) {
        out.push(itemFor(owner, late, chain, zone, nowMs, sunk, "chase", as));
        continue;
      }
      // A dormant link of HIS, with no live verdict: listed only when the brain
      // admits it (admitsLight). A matter whose open links all sit with OTHERS
      // renders nothing — WAITING occupies no level (brain §5). Under the stable
      // matter key that means the sync completes its ticket, which is harmless:
      // a sync-side complete never touches the commitments (only the readback's
      // closes do), so the chain stays open and the row returns the moment one
      // of its links becomes his move.
      const dormant = chain.find((c) => c.who === "me");
      if (dormant && matterActive)
        out.push(itemFor(owner, dormant, chain, zone, nowMs, true, "own", as));
    }

    for (const c of open) {
      if (inMatter.has(c)) continue;
      // Unfiled: no registered matter to lend lateness any weight, so only a
      // verdict makes the waiting his.
      if (c.who === "them" && c.assessment?.needs_leo) {
        out.push(itemFor(owner, c, [c], zone, nowMs, true, "chase"));
        continue;
      }
      if (c.who !== "me") continue;
      // No matter_id at all — unfiled, not closed. The verdict decides, and a
      // date that went by a fortnight ago overrides a stale yes: see longOverdue.
      // Unfiled and no live verdict → not listed (see the admission note above).
      if (c.assessment?.needs_leo && !longOverdue(c.due, nowMs)) out.push(itemFor(owner, c, [c], zone, nowMs, false));
    }
  }
  return out;
}

/**
 * Rows the OWNER closed stay closed until the person says something new
 * (specs/commitment-brain.md G12: a terminal state comes back only on evidence
 * newer than the close).
 *
 * 2026-10-01: he completed Trey's BC-company ticket at 13:10, among nine he
 * cleared at once. At 14:25 a re-assessment read Trey's 9/30 messages — a day
 * OLDER than his close — judged the payroll decision still his, and the sync
 * reopened the task he had just finished. A row the sync closed itself (its
 * matter went quiet) is not held: that close was never his ruling.
 */
export function heldClosedByOwner(
  rows: readonly DesiredTask[],
  map: SyncMap,
  lastSpoke: Readonly<Record<string, number>>,
): DesiredTask[] {
  return rows.filter((r) => {
    const rec = map[r.unitKey];
    if (!rec?.done || rec.closedBy !== "owner") return true;
    const p = parseLedgerUnitKey(r.unitKey);
    if (!p) return true;
    const spoke = lastSpoke[p.personaKey];
    return spoke !== undefined && spoke > rec.done;
  });
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
