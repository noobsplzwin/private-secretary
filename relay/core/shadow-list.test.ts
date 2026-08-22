import { describe, expect, it } from "vitest";
import { deriveShadowList, diffShadow } from "./shadow-list.js";

const assessed = (needs_leo: boolean, over: Record<string, unknown> = {}) => ({
  assessment: { needs_leo, evidence: "q", at: "2026-08-22T00:00:00Z", ...over },
});

const personas = [
  {
    key: "zech",
    commitments: [
      { who: "me" as const, what: "签署高通 NDA 并回传给李冰", status: "open" as const, ...assessed(true) },
      { who: "me" as const, what: "Send Zech the VIN photo", status: "done" as const, ...assessed(true) },
      { who: "them" as const, what: "Review the JD tonight", status: "open" as const, ...assessed(true) },
    ],
  },
  { key: "empty" },
];

describe("deriveShadowList", () => {
  // The mechanical core of the owner's standard: my work, still open, and judged
  // to need me. A done item and the other side's work can NOT appear, by
  // construction — these are the two failure classes he struck from the real
  // list — and neither can work that is merely outstanding.
  it("keeps only who=me AND status=open AND needs_leo", () => {
    expect(deriveShadowList(personas)).toEqual([
      { personaKey: "zech", what: "签署高通 NDA 并回传给李冰" },
    ]);
  });

  // The rule this file existed without. Missing it is why the first diff read
  // "89 derived | 10 real | 0 matched" — every open commitment became an item.
  it("drops an open commitment the verdict says Leo does not need to touch", () => {
    const out = deriveShadowList([
      {
        key: "supplier",
        commitments: [
          {
            who: "me" as const,
            what: "找供应商采购天线并直发给客户",
            status: "open" as const,
            ...assessed(false, { blocked_on: "them" }),
          },
        ],
      },
    ]);
    expect(out).toEqual([]);
  });

  // Silence must not promote itself. A commitment nothing has judged is not a
  // to-do, or every un-assessed corpse in the ledger walks straight onto the list.
  it("drops an unassessed commitment", () => {
    const out = deriveShadowList([
      { key: "x", commitments: [{ who: "me" as const, what: "something old", status: "open" as const }] },
    ]);
    expect(out).toEqual([]);
  });

  it("carries next_step through as the sub-item", () => {
    const out = deriveShadowList([
      {
        key: "x",
        commitments: [
          {
            who: "me" as const,
            what: "香港出差",
            status: "open" as const,
            ...assessed(true, { next_step: "订 9/3 往返机票" }),
          },
        ],
      },
    ]);
    expect(out[0]!.next_step).toBe("订 9/3 往返机票");
  });
});

describe("diffShadow", () => {
  it("matches the same work under minor wording drift", () => {
    const d = diffShadow(
      "t",
      [{ personaKey: "s", what: "Book a house cleaner before the Sept 1 move-in" }],
      ["Book house cleaner before Sept 1 move-in"],
    );
    expect(d.matched).toHaveLength(1);
    expect(d.realOnly).toEqual([]);
    expect(d.shadowOnly).toEqual([]);
  });

  // Same real-world work, lexically far apart ("签署高通 NDA 并回传给李冰" vs
  // "签回 NDA 以释放芯片产品资料") is REPORTED AS A MISMATCH on purpose: the
  // reviewer resolves it. A matcher smart enough to join these would also be
  // smart enough to hide a genuine coverage gap.
  it("reports lexically-distant same-work pairs for human review", () => {
    const d = diffShadow(
      "t",
      [{ personaKey: "zech", what: "签署高通 NDA 并回传给李冰" }],
      ["签回 NDA 以释放芯片产品资料 · 李冰Bezos"],
    );
    expect(d.matched).toEqual([]);
    expect(d.realOnly).toHaveLength(1);
    expect(d.shadowOnly).toHaveLength(1);
  });

  // A fuzzy matcher would hide exactly the gaps this diff exists to expose.
  it("reports unrelated titles on both sides rather than stretching a match", () => {
    const d = diffShadow(
      "t",
      [{ personaKey: "zech", what: "Book flights to Shenzhen" }],
      ["核实并处理信用卡连续可疑授权"],
    );
    expect(d.matched).toEqual([]);
    expect(d.realOnly).toEqual(["核实并处理信用卡连续可疑授权"]);
    expect(d.shadowOnly).toHaveLength(1);
  });

  it("never reuses one shadow item for two real rows", () => {
    const d = diffShadow(
      "t",
      [{ personaKey: "z", what: "Send the FCC samples to CTL" }],
      ["Send the FCC samples to CTL", "FCC samples: send to CTL lab"],
    );
    expect(d.matched).toHaveLength(1);
    expect(d.realOnly).toHaveLength(1);
  });
});
