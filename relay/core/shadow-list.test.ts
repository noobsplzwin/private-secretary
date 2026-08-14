import { describe, expect, it } from "vitest";
import { deriveShadowList, diffShadow } from "./shadow-list.js";

const personas = [
  {
    key: "zech",
    commitments: [
      { who: "me" as const, what: "签署高通 NDA 并回传给李冰", status: "open" as const },
      { who: "me" as const, what: "Send Zech the VIN photo", status: "done" as const },
      { who: "them" as const, what: "Review the JD tonight", status: "open" as const },
    ],
  },
  { key: "empty" },
];

describe("deriveShadowList", () => {
  // The mechanical core of the owner's standard: my work, still open. A done
  // item and the other side's work can NOT appear, by construction — these are
  // the two failure classes he struck from the real list.
  it("keeps only who=me AND status=open", () => {
    expect(deriveShadowList(personas)).toEqual([
      { personaKey: "zech", what: "签署高通 NDA 并回传给李冰" },
    ]);
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
