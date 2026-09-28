import { describe, expect, it } from "vitest";
import { deriveLedgerTasks, POOL_LIST } from "./ledger-list.js";
import { applySyncOps, diffTickTickSync, summarize } from "./ticktick-sync.js";
import type { Commitment } from "./persona-v3.js";

const NOW = Date.parse("2026-08-22T12:00:00Z");
const ZONE = "Asia/Shanghai";

const assessed = (needs_leo: boolean, over: Partial<NonNullable<Commitment["assessment"]>> = {}) => ({
  assessment: { needs_leo, evidence: "please handle this", at: "2026-08-22T00:00:00Z", ...over },
});

const c = (over: Partial<Commitment>): Commitment => ({
  who: "me",
  what: "签署高通 NDA 并回传给李冰",
  status: "open",
  ...over,
});

// Every matter these tests name is live unless a test says otherwise.
const LIVE: ReadonlySet<string> = new Set(["m1", "m2", "antenna", "fcc", "order-3500"]);
const derive = (
  personas: Parameters<typeof deriveLedgerTasks>[0],
  zone = ZONE,
  now = NOW,
  live: ReadonlySet<string> = LIVE,
  closed: ReadonlySet<string> = new Set(),
) => deriveLedgerTasks(personas, zone, now, live, closed);

const persona = (commitments: Commitment[], key = "zech", display_name = "Zech Noiseux") => ({
  key,
  display_name,
  commitments,
});

// REVISED 2026-09-07 by owner ruling 「verdict说了算」. This block used to
// assert that only a LIVE matter promotes; that rule buried new work, so what
// it now pins is the half that survived — the FLOOR. See "the verdict promotes,
// the matter only files" below for the replacement rule.
describe("the floor: what a row falls to when nothing promotes it", () => {
  // 2026-08-24 clearance swept 163 matter-less rows by hand; ten days later the
  // ledger had minted 59 more. A cleanup is not a gate.
  it("sinks a matter-less commitment with NO verdict, deadline or not", () => {
    // The date does not promote it — only a verdict does. Undecided work waits
    // on the floor rather than claiming his day.
    const [row] = derive([persona([c({ due: "2026-08-23" })])]);
    expect(row!.payload.project).toBe(POOL_LIST);
    expect(row!.payload.priority).toBe(0);
  });

  it("sinks a commitment whose matter the owner has closed, verdict and all", () => {
    const [row] = derive(
      [persona([c({ matter_id: "maoming-trip", ...assessed(true) })])],
      ZONE,
      NOW,
      LIVE,
      new Set(["maoming-trip"]),
    );
    expect(row!.payload.project).toBe(POOL_LIST);
  });

  it("promotes a commitment in a live matter, keeping its deadline priority", () => {
    const [row] = derive([persona([c({ matter_id: "fcc", due: "2026-08-23", ...assessed(true) })])]);
    expect(row!.payload.project).toBeUndefined(); // the default working list
    expect(row!.payload.priority).toBe(5);
  });

  it("sinks — never drops: the row still exists and keeps its key", () => {
    // Same work, same identity, different shelf. The shelf is `project`;
    // sinking must never re-key, or the sync reads it as a new to-do.
    const live = derive([persona([c({ matter_id: "fcc", ...assessed(true) })])]);
    const sunk = derive([persona([c({ matter_id: "fcc", ...assessed(true) })])], ZONE, NOW, LIVE, new Set(["fcc"]));
    expect(sunk).toHaveLength(1);
    expect(sunk[0]!.payload.project).toBe(POOL_LIST);
    expect(live[0]!.payload.project).toBeUndefined();
    expect(sunk[0]!.unitKey).toBe(live[0]!.unitKey);
  });

  // REVISED 2026-09-27. This used to assert that FILING work under a matter
  // left its key alone. It no longer does, on purpose: a matter is the durable
  // identity a self-updating row needs, and wording is not.
  it("filed work keys by its MATTER, unfiled work by its wording", () => {
    const filed = derive([persona([c({ matter_id: "fcc", ...assessed(true) })])]);
    const unfiled = derive([persona([c({ ...assessed(true) })])]);
    expect(filed[0]!.unitKey).not.toBe(unfiled[0]!.unitKey);
  });

  it("an unreadable registry no longer silences judged work", () => {
    // REVISED with the ruling. This used to sink everything, so a wiring
    // mistake was loud. Under 「verdict说了算」 a missing registry cannot bury
    // work he must do — the failure direction moved from losing rows to
    // showing an unfiled one, which is the safer of the two.
    const [row] = derive([persona([c({ matter_id: "fcc", ...assessed(true) })])], ZONE, NOW, new Set());
    expect(row!.payload.project).toBeUndefined();
  });
});

describe("deriveLedgerTasks", () => {
  it("derives a row only from open + who=me + needs_leo", () => {
    const rows = derive(
      [
        persona([
          c({ ...assessed(true) }),
          c({ what: "done thing", status: "done", ...assessed(true) }),
          // Theirs, and the verdict says Leo is NOT waiting — the ordinary case
          // for a who=them entry. (A verdict that says he IS waiting mints a
          // chase row; that rule has its own describe block below.)
          c({ what: "their thing", who: "them", ...assessed(false, { blocked_on: "them" }) }),
          c({ what: "handed off", ...assessed(false, { blocked_on: "them" }) }),
          c({ what: "never assessed" }),
        ]),
      ],
      ZONE,
      NOW,
    );
    // REVISED 2026-09-06. The old rule was "a row exists only when needs_leo";
    // dormant entries vanished, and the sync read vanishing as finished. Now
    // every OPEN who=me entry has a row — the verdict decides the shelf, not
    // whether it exists. These fixtures carry no matter_id, so the promotion
    // gate puts all of them on the floor regardless.
    expect(rows.map((r) => r.payload.title).sort()).toEqual(
      ["handed off", "never assessed", "签署高通 NDA 并回传给李冰"].sort(),
    );
    // REVISED with the ruling: the judged one promotes even unfiled; the rest
    // are undecided and stay on the floor.
    const promoted = rows.filter((r) => !r.payload.project).map((r) => r.payload.title);
    expect(promoted).toEqual(["签署高通 NDA 并回传给李冰"]);
    // done stays out, and so does their commitment — only Leo's own open work.
    expect(rows.some((r) => r.payload.title === "done thing")).toBe(false);
    expect(rows.some((r) => r.payload.title === "their thing")).toBe(false);
  });

  it("renders the verdict's next_step as the checklist and the quote as the note", () => {
    const [row] = derive(
      [persona([c({ ...assessed(true, { next_step: "把签好的 NDA 扫描发回李冰" }) })])],
      ZONE,
      NOW,
    );
    expect(row!.payload.kind).toBe("CHECKLIST");
    expect(row!.payload.items).toEqual([{ title: "把签好的 NDA 扫描发回李冰", status: 0, sortOrder: 0 }]);
    expect(row!.payload.desc).toContain('依据: "please handle this"');
    expect(row!.payload.desc).toContain("Zech Noiseux");
  });

  it("renders TEXT when the verdict carries no next_step", () => {
    const [row] = derive([persona([c({ ...assessed(true) })])], ZONE, NOW);
    expect(row!.payload.kind).toBe("TEXT");
    expect(row!.payload.content).toContain("依据");
  });

  // Priority is mechanical, from the deadline alone. Never invented: an undated
  // commitment carries no flag, so TickTick's date views stay meaningful.
  it("prioritises by deadline proximity and never invents a date", () => {
    const rows = derive(
      [
        persona([
          // Each carries its OWN live matter: deadline priority is what a
          // promoted row gets, and one shared matter would collapse them into
          // a single chain row.
          c({ what: "imminent", due: "2026-08-23", matter_id: "p1", ...assessed(true) }),
          c({ what: "this week", due: "2026-08-27", matter_id: "p2", ...assessed(true) }),
          c({ what: "far off", due: "2026-10-01", matter_id: "p3", ...assessed(true) }),
          c({ what: "overdue", due: "2026-08-10", matter_id: "p4", ...assessed(true) }),
          c({ what: "undated", matter_id: "p5", ...assessed(true) }),
          c({ what: "free-text date", due: "before the Shenzhen trip", matter_id: "p6", ...assessed(true) }),
        ]),
      ],
      ZONE,
      NOW,
      new Set(["p1", "p2", "p3", "p4", "p5", "p6"]),
    );
    const by = (t: string) => rows.find((r) => r.payload.title === t)!.payload;
    expect(by("imminent").priority).toBe(5);
    expect(by("this week").priority).toBe(3);
    expect(by("far off").priority).toBe(0);
    expect(by("overdue").priority).toBe(5); // unpaid work is MORE urgent past its date
    expect(by("undated").dueDate).toBeUndefined();
    expect(by("free-text date").dueDate).toBeUndefined(); // never parsed into an invented date
    expect(by("imminent").timeZone).toBe(ZONE);
  });

  it("keys rows by persona and wording, stable across calls", () => {
    const twice = [0, 1].map(
      () => derive([persona([c({ ...assessed(true) })])], ZONE, NOW)[0]!.unitKey,
    );
    expect(twice[0]).toBe(twice[1]);
    expect(twice[0]).toMatch(/^ledger_zech_/);
  });

  // §7b: a matter is ONE row — its active who=me link — however many links it has.
  describe("matter chains", () => {
    const antenna = (over: Partial<Commitment>): Commitment =>
      c({ matter_id: "antenna-2026", ...over });

    it("collapses a matter into one row led by the active who=me link", () => {
      const rows = derive(
        [
          persona([
            antenna({ what: "找供应商采购天线", ...assessed(true, { next_step: "下单并付款" }) }),
            antenna({ what: "供应商发货给客户", who: "them", ...assessed(true, { next_step: "should not render" }) }),
          ]),
        ],
        ZONE,
        NOW,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload.title).toBe("找供应商采购天线");
      // the chain's next_steps ride the one row
      expect(rows[0]!.payload.items!.map((i) => i.title)).toContain("下单并付款");
    });

    // The owner's own adjudication of the antenna matter: fully handed off →
    // "不需要任何我做的事情，但是还是要算作一个commitment".
    it("derives nothing when the matter's open links all sit with others", () => {
      const rows = derive(
        [
          persona([
            antenna({ what: "找供应商采购天线", ...assessed(false, { blocked_on: "them" }) }),
            // The owner's own adjudication of this exact case: 「不需要任何我做
            // 的事情，但是还是要算作一个commitment」. The supplier getting on
            // with it is not something he is waiting on, so the verdict is
            // false and the matter owes no row — chasing is for what he is
            // actually left waiting for.
            antenna({ what: "供应商发货给客户", who: "them", ...assessed(false, { blocked_on: "them" }) }),
          ]),
        ],
        ZONE,
        NOW,
      );
      // REVISED 2026-09-06: the matter owes no WORKING row — Leo has nothing to
      // do on it — but his own link is still an open commitment, and the owner
      // was explicit that it stays one: 「不需要任何我做的事情，但是还是要算作一个
      // commitment」. So it sits on the floor, not nowhere.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload.project).toBe(POOL_LIST);
      expect(rows[0]!.payload.title).toBe("找供应商采购天线");
    });
  });
});

// 2026-09-04: the owner named 「中汽研第一阶段的款还没付」 as work he owns, and no
// strategy on the bench could find it — because nothing in the engine turned
// "they owe me and it is late" into an action of his. The type even said so:
// blocked_on them meant "no item, however much the thread looks like it wants
// chasing". A missed deadline is not a thread looking like it wants chasing.
describe("they owe me, and they are late", () => {
  // Seven days before NOW: a real miss, and recent enough to still be worth
  // chasing. (How recent is "recent" is pinned in its own block below.)
  const late = (over: Partial<Commitment> = {}): Commitment =>
    c({ who: "them", what: "Deliver the RT-Thread proposal", due: "2026-08-15", matter_id: "fcc", ...over });

  it("an overdue commitment of theirs becomes MY chase row", () => {
    const [row] = derive([persona([late()])]);
    expect(row!.payload.title).toContain("催");
    expect(row!.payload.title).toContain("RT-Thread");
    expect(row!.payload.priority).toBe(5); // past its date — overdue counts as urgent
  });

  // REVISED 2026-09-28 by owner ruling 「补上，沉到待办池，不升顶」. These three
  // used to assert SILENCE — no row at all. Silence was survivable only while a
  // row's key moved on its own; under a stable matter key, no row in `desired`
  // is exactly how the sync spells "finished", so a live matter completed its
  // own ticket. The 大众VW cascade matter did it that day with two links open.
  //
  // What the block still pins is the half that was always right: none of these
  // is a CHASE, and none of them earns a place in his day.
  const sunkNotChased = (rows: ReturnType<typeof deriveLedgerTasks>): void => {
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.project).toBe(POOL_LIST);
    expect(rows[0]!.payload.priority).toBe(0);
    expect(rows[0]!.payload.title).not.toContain("催");
    expect(rows[0]!.payload.title).toContain("等: ");
  };

  it("a commitment of theirs that is NOT yet due sinks, and is not chased", () => {
    sunkNotChased(derive([persona([late({ due: "2026-12-01" })])]));
  });

  it("an undated commitment of theirs sinks — lateness must be evidenced", () => {
    sunkNotChased(derive([persona([late({ due: undefined })])]));
  });

  it("a free-text due is not a deadline, so the row sinks instead of chasing", () => {
    sunkNotChased(derive([persona([late({ due: "end of weekend" })])]));
  });

  // The row exists so the matter does not auto-complete itself, and its note
  // has to say why it is parked — 「等: 」 alone reads like a task he is late on.
  it("says plainly that the move is theirs, not his", () => {
    const [row] = derive([persona([late({ due: undefined })])]);
    const note = String(row!.payload.desc ?? row!.payload.content ?? "");
    expect(note).toContain("眼下不用你动");
    expect(note).toContain("Zech Noiseux");
  });

  it("my own live link wins the matter — no chasing myself", () => {
    const rows = derive([
      persona([late(), c({ who: "me", what: "Review their proposal", matter_id: "fcc", ...assessed(true) })]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.title).toBe("Review their proposal");
  });

  it("a done commitment of theirs is never chased", () => {
    expect(derive([persona([late({ status: "done" })])])).toEqual([]);
  });
});

// The other half of the chase rule: 中汽研 carries no due date, so no date-based
// rule can reach it. What reaches it is the assess verdict the pass can finally
// give a who=them commitment (proc/persona-update.ts, 2026-09-05).
describe("they owe me, and the verdict says I am waiting", () => {
  const owed = (over: Partial<Commitment> = {}): Commitment =>
    c({ who: "them", what: "Arrange the 承兑汇票 payment", matter_id: "fcc", ...over });

  it("an assessed who=them commitment becomes a chase row, with no due date at all", () => {
    const [row] = derive([persona([owed({ ...assessed(true) })])]);
    expect(row!.payload.title).toBe("催: Arrange the 承兑汇票 payment");
  });

  it("needs_leo=false on their commitment sinks rather than chasing", () => {
    const [row] = derive([persona([owed({ ...assessed(false) })])]);
    expect(row!.payload.project).toBe(POOL_LIST);
    expect(row!.payload.title).toBe("等: Arrange the 承兑汇票 payment");
  });

  it("my own live link still wins the matter", () => {
    const rows = derive([
      persona([owed({ ...assessed(true) }), c({ who: "me", what: "Send the invoice", matter_id: "fcc", ...assessed(true) })]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.title).toBe("Send the invoice");
  });
});

// 2026-09-06: a sync would have closed three live to-dos because their
// verdicts said needs_leo=false. The owner's rule is the opposite:
// 「系统删待办这个概念不存在。如果这件事情的承诺已经履行了，那就结束了，如果还是
// 待办，但是优先级较低，那就往后排」. Only done/dropped ends a commitment;
// everything still open has a floor, and the floor is the pool.
describe("still open, just not now — the floor is the pool", () => {
  it("sinks a who=me commitment the verdict says he need not act on", () => {
    const [row] = derive([persona([c({ matter_id: "fcc", ...assessed(false, { blocked_on: "them" }) })])]);
    expect(row).toBeDefined();
    expect(row!.payload.project).toBe(POOL_LIST);
    expect(row!.payload.priority).toBe(0);
  });

  it("sinks one that has never been assessed at all", () => {
    const [row] = derive([persona([c({ matter_id: "fcc" })])]);
    expect(row!.payload.project).toBe(POOL_LIST);
  });

  it("a matter still shows at most ONCE when it sinks", () => {
    const rows = derive([
      persona([
        c({ what: "link one", matter_id: "fcc" }),
        c({ what: "link two", matter_id: "fcc", ...assessed(false, { blocked_on: "them" }) }),
      ]),
    ]);
    expect(rows).toHaveLength(1);
  });

  it("a live link still wins its matter and stays off the floor", () => {
    const rows = derive([
      persona([
        c({ what: "dormant", matter_id: "fcc" }),
        c({ what: "live", matter_id: "fcc", ...assessed(true) }),
      ]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.title).toBe("live");
    expect(rows[0]!.payload.project).toBeUndefined();
  });

  it("done and dropped are the only exits — neither sinks", () => {
    expect(
      derive([persona([c({ what: "finished", status: "done" }), c({ what: "abandoned", status: "dropped" })])]),
    ).toEqual([]);
  });
});

// 2026-09-06, from the owner's own screen: 「催: Prioritize the 4.5 board」 due
// Jul 27, 「催: Manually sign the NDA」 due Aug 10, 「催: Prepare for Thursday's
// OTA Plan meeting (Aug 27, 8–9am)」 — a meeting that had already happened.
// 「质量有非常非常明显的下降，这些新生成的催，基本都是过期的或者过分生成的」.
//
// The mint window was applied to EXTRACTION and not to the chase, so a deadline
// missed six weeks ago minted a fresh 催 today. A date that old is not someone
// running late, it is history — the owner's word for it is 「很久以前」.
describe("chasing has a memory, not an archive", () => {
  const NOW_MS = Date.parse("2026-09-06T12:00:00Z");
  const owed = (due: string): Commitment =>
    c({ who: "them", what: "Prioritize the 4.5 board on the production line", due, matter_id: "fcc" });

  it("chases a deadline missed inside the window", () => {
    const [row] = derive([persona([owed("2026-09-01")])], ZONE, NOW_MS);
    expect(row!.payload.title).toContain("催");
  });

  it("does NOT chase a deadline missed six weeks ago", () => {
    const rows = derive([persona([owed("2026-07-27")])], ZONE, NOW_MS);
    expect(rows.some((r) => r.payload.title.includes("催"))).toBe(false);
  });

  it("the stale one is not lost either — it sinks", () => {
    // Still their commitment, still open. It just stops shouting.
    const rows = derive([persona([owed("2026-07-27")])], ZONE, NOW_MS);
    expect(rows.every((r) => r.payload.project === POOL_LIST || rows.length === 0)).toBe(true);
  });

  it("still chases on a verdict even when the date is ancient", () => {
    // A verdict is the owner's own signal that he is waiting — 中汽研 has no
    // usable date at all, and that route must survive the window.
    const [row] = derive(
      [persona([owed("2026-07-27")], "zech", "Zech")].map((p) => ({
        ...p,
        commitments: [{ ...p.commitments[0]!, ...assessed(true) }],
      })),
      ZONE,
      NOW_MS,
    );
    expect(row!.payload.title).toContain("催");
  });
});

// OWNER RULING 2026-09-07: 「verdict说了算」. The promotion gate was buried
// genuinely new work — 10 commitments the pass had judged needs_leo sat in the
// pool solely because they mapped to no registered matter, among them 「订 500
// 个电源适配器」 and 「联系谢尔福德谈股份分配」. New work has no matter by
// definition, which is why the bench missed all seven items he named himself.
//
// A matter is how work is FILED. A verdict is how it is DECIDED. Filing does
// not outrank deciding — with one exception, below.
describe("the verdict promotes, the matter only files", () => {
  it("promotes needs_leo work that maps to no matter at all", () => {
    const [row] = derive([persona([c({ ...assessed(true) })])]);
    expect(row!.payload.project).toBeUndefined();
  });

  it("still promotes needs_leo work inside a live matter", () => {
    const [row] = derive([persona([c({ matter_id: "fcc", ...assessed(true) })])]);
    expect(row!.payload.project).toBeUndefined();
  });

  it("keeps sinking a matter the OWNER closed, verdict or not", () => {
    // His own ruling outranks a model verdict: a closed matter is him saying
    // the work is over. That is the one case where filing wins.
    const [row] = derive(
      [persona([c({ matter_id: "retired", ...assessed(true) })])],
      ZONE,
      NOW,
      LIVE,
      new Set(["retired"]),
    );
    expect(row!.payload.project).toBe(POOL_LIST);
  });

  it("an unregistered matter id is unfiled, not closed", () => {
    // The extraction prompt lets the model coin a new kebab-case id for a fresh
    // chain. That is filing in progress, not a decision that the work is done.
    const [row] = derive(
      [persona([c({ matter_id: "some-id-the-model-coined", ...assessed(true) })])],
      ZONE,
      NOW,
      LIVE,
      new Set(["retired"]),
    );
    expect(row!.payload.project).toBeUndefined();
  });

  it("no verdict still means the floor, matter or not", () => {
    expect(derive([persona([c({ matter_id: "fcc" })])])[0]!.payload.project).toBe(POOL_LIST);
    expect(derive([persona([c({})])])[0]!.payload.project).toBe(POOL_LIST);
  });
});

describe("a date-anchored occasion sinks once it is long past", () => {
  // 2026-09-13: the owner adjudicated all 91 open who=me commitments and struck
  // 78. The dominant shape was an OCCASION whose date had gone by — 「周四先去
  // 奇迹当面看一下」, 「Visit/meet Amlogic on Sept 1」 — not a deadline. Nothing
  // was retiring them, so they sat on his list forever.
  //
  // But priorityFor pushes a freshly overdue row to the TOP on purpose ("unpaid
  // work is MORE urgent past its date"), and no code can tell an invoice from an
  // appointment. So the rule waits out MINT_WINDOW_DAYS before sinking.
  const days = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  it("keeps a freshly overdue commitment loud, not sunk", () => {
    const row = derive([persona([c({ due: days(3), ...assessed(true) })])])[0]!;
    expect(row.payload.project).toBeUndefined();
    expect(row.payload.priority).toBe(5);
  });

  it("sinks it to the pool once its date is more than the window past", () => {
    const row = derive([persona([c({ due: days(20), ...assessed(true) })])])[0]!;
    expect(row.payload.project).toBe(POOL_LIST);
    expect(row.payload.priority).toBe(0);
  });

  it("sinks the lead of a LIVE matter too — the occasion passed either way", () => {
    const row = derive([persona([c({ matter_id: "m1", due: days(30), ...assessed(true) })])])[0]!;
    expect(row.payload.project).toBe(POOL_LIST);
  });

  it("never sinks on an unparseable due — prose is not a date", () => {
    const row = derive([persona([c({ due: "end of weekend", ...assessed(true) })])])[0]!;
    expect(row.payload.project).toBeUndefined();
  });

  it("leaves a commitment with no due exactly as the verdict decided", () => {
    expect(derive([persona([c({ ...assessed(true) })])])[0]!.payload.project).toBeUndefined();
    expect(derive([persona([c({ ...assessed(false) })])])[0]!.payload.project).toBe(POOL_LIST);
  });

  it("sinks but does NOT remove — a commitment still ends only by done or dropped", () => {
    const rows = derive([persona([c({ due: days(60), ...assessed(true) })])]);
    expect(rows).toHaveLength(1);
  });
});

// ── the self-updating row (owner, 2026-09-27) ───────────────────────────
//
// 「1. 后续有新的information更新，直接更新目前ticket的Description区域
//   2. 如果这个ticket后续information更新中已经被resolve了，那这个卡就可以自动
//      mark结束」 — and 「不要新卡顶替旧卡」.
//
// Measured that morning over the seven days since the resurrection fix: 169
// TickTick creates against 9 updates. Every new turn of a conversation minted
// a fresh card, because identity was the row's own wording. The sync has done
// create-or-update by unitKey all along; what it never got was a key that
// stays still.
describe("a matter's row updates in place instead of re-minting", () => {
  const link = (what: string, over: Partial<Commitment> = {}): Commitment =>
    c({ what, matter_id: "fcc", ...over });

  it("keeps ONE key while the conversation adds links", () => {
    const day1 = derive([persona([link("约 Alger 定本周 OH 时间", assessed(true))])]);
    const day2 = derive([
      persona([
        link("约 Alger 定本周 OH 时间", { status: "done" }),
        link("敲定周四下午与 Alger 的 OH 具体时间", assessed(true)),
      ]),
    ]);
    expect(day1).toHaveLength(1);
    expect(day2).toHaveLength(1);
    expect(day2[0]!.unitKey).toBe(day1[0]!.unitKey);
  });

  // The key holding still is only half of it — the note has to actually CHANGE,
  // or the hash gate reports "in sync" and the owner reads yesterday's ticket.
  it("re-renders the note, so the row's payload really is different", () => {
    const before = derive([persona([link("寄样品给客户", assessed(true))])]);
    const after = derive([
      persona([link("寄样品给客户", assessed(true)), link("等客户回测试报告", { who: "them" })]),
    ]);
    const note = (r: (typeof after)[number]): string =>
      String(r.payload.desc ?? r.payload.content ?? "");
    expect(note(after[0]!)).not.toBe(note(before[0]!));
    expect(note(after[0]!)).toContain("等客户回测试报告");
    expect(note(after[0]!)).toContain("进度: 共 2 项,已了结 0 项");
    // the lead is the TITLE, so the note lists what is left beside it
    expect(note(after[0]!)).not.toContain("我这边还有");
  });

  // 「我不是要不断叠加」 — settled links are a count, not an ever-growing list.
  // The ledger records no completion DATE, so listing them "most recent first"
  // would be array order wearing a chronology it does not have.
  it("counts settled links rather than listing them", () => {
    const [row] = derive([
      persona([
        link("第一步", { status: "done" }),
        link("第二步", { status: "done" }),
        link("第三步", assessed(true)),
      ]),
    ]);
    const note = String(row!.payload.desc ?? row!.payload.content ?? "");
    expect(note).toContain("进度: 共 3 项,已了结 2 项");
    expect(note).not.toContain("第一步");
    expect(note).not.toContain("第二步");
    // 第三步 is the lead, so it is the row's TITLE rather than a note line.
    expect(row!.payload.title).toBe("第三步");
  });

  // THE HOLE, closed 2026-09-28. A matter whose open links all sit with others
  // used to render nothing — and under a stable key, nothing is how the sync
  // spells "finished", so the ticket completed itself with the work still live.
  // Production proof: the 大众VW cascade matter, two links open, task closed.
  it("keeps a row while ANY link is open, even when none of them is mine", () => {
    const rows = derive([
      persona([
        link("金小奇确定级联商务报价", { who: "them" }),
        link("把 SoW+MSA 发给杜伟", { who: "them" }),
      ]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.project).toBe(POOL_LIST); // 「不升顶」
    expect(rows[0]!.payload.priority).toBe(0);
  });

  // ...and that row must survive the diff, or closing the hole achieved
  // nothing: the whole point is that the task is NOT completed.
  it("the surviving row stops the sync completing the ticket", () => {
    const live = derive([persona([link("等对方回价", { who: "them" })])]);
    const map = { [live[0]!.unitKey]: { ticktickId: "tt-1", projectId: "p", hash: "stale" } };
    const ops = diffTickTickSync(live, map);
    expect(ops.some((o) => o.kind === "complete")).toBe(false);
  });

  // Logic 2. Nothing open anywhere in the chain → no row → the sync's
  // ordinary complete path closes the task. Auto-close is the ABSENCE of a
  // row, which is why the key had to stop moving first: a row that re-keys
  // itself looks exactly like a row that finished.
  it("produces no row once every link is settled", () => {
    expect(
      derive([persona([link("寄样品给客户", { status: "done" }), link("等回执", { who: "them", status: "done" })])]),
    ).toEqual([]);
  });

  // 「归属判不准就新开一张」. Unfiled work has nothing durable to attach to, so
  // it keeps the wording key — a new card, which is the honest failure.
  it("unfiled work still re-keys when it is reworded", () => {
    const a = derive([persona([c({ what: "回复茉莉昨晚住哪", ...assessed(true) })])]);
    const b = derive([persona([c({ what: "回复茉莉昨晚住在哪（是否石家庄）", ...assessed(true) })])]);
    expect(b[0]!.unitKey).not.toBe(a[0]!.unitKey);
  });
});

// The end-to-end claim, because every piece above can be right while the thing
// the owner sees is still a second card. This runs the real diff over two days
// of one conversation.
describe("end to end: a day-2 message updates the day-1 task", () => {
  const link = (what: string, over: Partial<Commitment> = {}): Commitment =>
    c({ what, matter_id: "fcc", ...over });

  const sync = (rows: ReturnType<typeof deriveLedgerTasks>, map = {}) => {
    const ops = diffTickTickSync(rows, map);
    const results = Object.fromEntries(
      ops.filter((o) => o.kind !== "skip").map((o) => [o.unitKey, { ticktickId: "tt-1", projectId: "p" }]),
    );
    return { ops, map: applySyncOps(map, ops, results), counts: summarize(ops) };
  };

  it("creates once, then updates the SAME TickTick task", () => {
    const day1 = sync(derive([persona([link("约 Alger 定本周 OH 时间", assessed(true))])]));
    expect(day1.counts).toMatchObject({ create: 1, update: 0, complete: 0 });

    const day2 = sync(
      derive([
        persona([
          link("约 Alger 定本周 OH 时间", { status: "done" }),
          link("敲定周四下午与 Alger 的 OH 具体时间", assessed(true)),
        ]),
      ]),
      day1.map,
    );
    // The row that matters: ONE update, and nothing created or completed.
    expect(day2.counts).toMatchObject({ create: 0, update: 1, complete: 0 });
    const op = day2.ops.find((o) => o.kind === "update")!;
    expect(op).toMatchObject({ ticktickId: "tt-1" });
    expect(op.kind === "update" && op.payload.title).toBe("敲定周四下午与 Alger 的 OH 具体时间");

    // Day 3: the matter finishes. The task completes itself.
    const day3 = sync(
      derive([
        persona([
          link("约 Alger 定本周 OH 时间", { status: "done" }),
          link("敲定周四下午与 Alger 的 OH 具体时间", { status: "done" }),
        ]),
      ]),
      day2.map,
    );
    expect(day3.counts).toMatchObject({ create: 0, update: 0, complete: 1 });
    expect(day3.ops[0]).toMatchObject({ kind: "complete", ticktickId: "tt-1" });
  });
});
