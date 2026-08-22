import { describe, expect, it } from "vitest";
import { deriveLedgerTasks } from "./ledger-list.js";
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

const persona = (commitments: Commitment[], key = "zech", display_name = "Zech Noiseux") => ({
  key,
  display_name,
  commitments,
});

describe("deriveLedgerTasks", () => {
  it("derives a row only from open + who=me + needs_leo", () => {
    const rows = deriveLedgerTasks(
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
    const [row] = deriveLedgerTasks(
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
    const [row] = deriveLedgerTasks([persona([c({ ...assessed(true) })])], ZONE, NOW);
    expect(row!.payload.kind).toBe("TEXT");
    expect(row!.payload.content).toContain("依据");
  });

  // Priority is mechanical, from the deadline alone. Never invented: an undated
  // commitment carries no flag, so TickTick's date views stay meaningful.
  it("prioritises by deadline proximity and never invents a date", () => {
    const rows = deriveLedgerTasks(
      [
        persona([
          c({ what: "imminent", due: "2026-08-23", ...assessed(true) }),
          c({ what: "this week", due: "2026-08-27", ...assessed(true) }),
          c({ what: "far off", due: "2026-10-01", ...assessed(true) }),
          c({ what: "overdue", due: "2026-08-10", ...assessed(true) }),
          c({ what: "undated", ...assessed(true) }),
          c({ what: "free-text date", due: "before the Shenzhen trip", ...assessed(true) }),
        ]),
      ],
      ZONE,
      NOW,
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
      () => deriveLedgerTasks([persona([c({ ...assessed(true) })])], ZONE, NOW)[0]!.unitKey,
    );
    expect(twice[0]).toBe(twice[1]);
    expect(twice[0]).toMatch(/^ledger_zech_/);
  });

  // §7b: a matter is ONE row — its active who=me link — however many links it has.
  describe("matter chains", () => {
    const antenna = (over: Partial<Commitment>): Commitment =>
      c({ matter_id: "antenna-2026", ...over });

    it("collapses a matter into one row led by the active who=me link", () => {
      const rows = deriveLedgerTasks(
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
      const rows = deriveLedgerTasks(
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
