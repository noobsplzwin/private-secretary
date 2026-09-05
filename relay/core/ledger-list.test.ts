import { describe, expect, it } from "vitest";
import { deriveLedgerTasks, POOL_LIST } from "./ledger-list.js";
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
) => deriveLedgerTasks(personas, zone, now, live);

const persona = (commitments: Commitment[], key = "zech", display_name = "Zech Noiseux") => ({
  key,
  display_name,
  commitments,
});

describe("the promotion gate — a matter is what earns a row its slot", () => {
  // 2026-08-24 clearance swept 163 matter-less rows by hand; ten days later the
  // ledger had minted 59 more. A cleanup is not a gate.
  it("sinks a matter-less commitment to the pool at no priority", () => {
    const [row] = derive([persona([c({ due: "2026-08-23", ...assessed(true) })])]);
    expect(row!.payload.project).toBe(POOL_LIST);
    expect(row!.payload.priority).toBe(0); // imminent, but nothing outside a live matter may claim the day
  });

  it("sinks a commitment whose matter the owner has closed", () => {
    const [row] = derive([persona([c({ matter_id: "maoming-trip", ...assessed(true) })])]);
    expect(row!.payload.project).toBe(POOL_LIST);
  });

  it("promotes a commitment in a live matter, keeping its deadline priority", () => {
    const [row] = derive([persona([c({ matter_id: "fcc", due: "2026-08-23", ...assessed(true) })])]);
    expect(row!.payload.project).toBeUndefined(); // the default working list
    expect(row!.payload.priority).toBe(5);
  });

  it("sinks — never drops: the row still exists and keeps its key", () => {
    const sunk = derive([persona([c({ ...assessed(true) })])]);
    const live = derive([persona([c({ matter_id: "fcc", ...assessed(true) })])]);
    expect(sunk).toHaveLength(1);
    expect(sunk[0]!.unitKey).toBe(live[0]!.unitKey); // same work, same identity, different shelf
  });

  it("an empty registry sinks everything rather than promoting silently", () => {
    const [row] = derive([persona([c({ matter_id: "fcc", ...assessed(true) })])], ZONE, NOW, new Set());
    expect(row!.payload.project).toBe(POOL_LIST);
  });
});

describe("deriveLedgerTasks", () => {
  it("derives a row only from open + who=me + needs_leo", () => {
    const rows = derive(
      [
        persona([
          c({ ...assessed(true) }),
          c({ what: "done thing", status: "done", ...assessed(true) }),
          c({ what: "their thing", who: "them", ...assessed(true) }),
          c({ what: "handed off", ...assessed(false, { blocked_on: "them" }) }),
          c({ what: "never assessed" }),
        ]),
      ],
      ZONE,
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.title).toBe("签署高通 NDA 并回传给李冰");
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
            antenna({ what: "供应商发货给客户", who: "them", ...assessed(true) }),
          ]),
        ],
        ZONE,
        NOW,
      );
      expect(rows).toEqual([]);
    });
  });
});

// 2026-09-04: the owner named 「中汽研第一阶段的款还没付」 as work he owns, and no
// strategy on the bench could find it — because nothing in the engine turned
// "they owe me and it is late" into an action of his. The type even said so:
// blocked_on them meant "no item, however much the thread looks like it wants
// chasing". A missed deadline is not a thread looking like it wants chasing.
describe("they owe me, and they are late", () => {
  const late = (over: Partial<Commitment> = {}): Commitment =>
    c({ who: "them", what: "Deliver the RT-Thread proposal", due: "2026-08-01", matter_id: "fcc", ...over });

  it("an overdue commitment of theirs becomes MY chase row", () => {
    const [row] = derive([persona([late()])]);
    expect(row!.payload.title).toContain("催");
    expect(row!.payload.title).toContain("RT-Thread");
    expect(row!.payload.priority).toBe(5); // past its date — overdue counts as urgent
  });

  it("a commitment of theirs that is NOT yet due stays silent", () => {
    expect(derive([persona([late({ due: "2026-12-01" })])])).toEqual([]);
  });

  it("an undated commitment of theirs stays silent — lateness must be evidenced", () => {
    expect(derive([persona([late({ due: undefined })])])).toEqual([]);
  });

  it("a free-text due is not a deadline and mints nothing", () => {
    expect(derive([persona([late({ due: "end of weekend" })])])).toEqual([]);
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
