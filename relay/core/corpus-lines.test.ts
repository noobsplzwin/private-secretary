import { describe, expect, it } from "vitest";
import { ageInDays, capCorpus, closedLater, indexCorpus, isHedged, lineOf, mintable } from "./corpus-lines.js";

const NOW = Date.parse("2026-08-23T12:00:00Z");
const CORPUS = [
  "=== wechat ===",
  "[2026-08-20 10:00] 张工: 帮我把BOM发给温总",
  "[2026-08-20 10:05] me: 好的我今天发你",
  "[2026-08-21 09:00] me: 发你了",
  "[2026-08-22 11:00] 张工: U2B-E24的板子什么时候能到?",
  "[2026-06-01 08:00] 张工: 老黄历:帮我订去年的展位",
  "[2026-08-22 12:00] me: 我看看周末有没有空弄官网",
  "=== gmail (leo@taiv.tv) ===",
  "[2026-08-22] From Michael <m@x.com>:",
  "I will send the enclosure drawings tomorrow.",
  "=== slack DM ===",
  "[2026-08-22] me: I'll book the lab slot",
  "[2026-08-22] UPHG4T8R1: can you confirm the FCC dates?",
];
const LINES = indexCorpus(CORPUS.join("\n"));

describe("indexCorpus", () => {
  it("reads the speaker off the line, across all three dialects", () => {
    expect(lineOf(LINES, "好的我今天发你")?.speaker).toBe("me");
    expect(lineOf(LINES, "帮我把BOM发给温总")?.speaker).toBe("them");
    expect(lineOf(LINES, "I'll book the lab slot")?.speaker).toBe("me");
    expect(lineOf(LINES, "can you confirm the FCC dates")?.speaker).toBe("them");
  });

  it("a Gmail BODY line is attributable to nobody", () => {
    // The From header carries the speaker; the body below it does not. Guessing
    // here is what would turn someone else's promise into the owner's to-do.
    expect(lineOf(LINES, "I will send the enclosure drawings tomorrow")?.speaker).toBe("unknown");
  });

  it("refuses a quote stitched across lines", () => {
    expect(lineOf(LINES, "好的我今天发你了张工")).toBeNull();
  });
});

describe("isHedged", () => {
  it("treats Chinese softeners as refusals, not agreements", () => {
    expect(isHedged("我看看周末有没有空弄官网")).toBe(true);
    expect(isHedged("这就是考虑一下")).toBe(true);
    expect(isHedged("好的我今天发你")).toBe(false);
  });

  it("catches the English equivalents", () => {
    expect(isHedged("Maybe I can look at it")).toBe(true);
    expect(isHedged("I'll send it today")).toBe(false);
  });
});

describe("closedLater", () => {
  it("a later 发你了 by the same speaker closes the promise", () => {
    const commit = lineOf(LINES, "好的我今天发你")!;
    expect(closedLater(LINES, commit, "把BOM发给温总")).toBe(true);
  });

  it("the other side's completion word does NOT close my promise", () => {
    const theirs = indexCorpus(
      ["[2026-08-20] me: 我今天发你BOM", "[2026-08-21] 张工: 我发你了"].join("\n"),
    );
    expect(closedLater(theirs, theirs[0]!, "发BOM")).toBe(false);
  });

  it("an EARLIER completion word does not close a later promise", () => {
    const rev = indexCorpus(
      ["[2026-08-01] me: 发你了", "[2026-08-20] me: 我今天发你BOM"].join("\n"),
    );
    expect(closedLater(rev, rev[1]!, "发BOM")).toBe(false);
  });
});

describe("ageInDays", () => {
  it("dates the line, and treats an undated line as unusable", () => {
    expect(ageInDays(lineOf(LINES, "老黄历")!, NOW)).toBeGreaterThan(80);
    expect(ageInDays(lineOf(LINES, "好的我今天发你")!, NOW)).toBeLessThan(4);
    expect(ageInDays(LINES[0]!, NOW)).toBe(Infinity);
  });
});

// `mintable` is deliberately the ONE implementation: production's extraction
// and the bench's S0 strategy both call it. When the gates lived only on the
// production orchestrator, the 2026-09-04 bench re-run scored the ungated path
// and reported that shipping them had changed nothing.
describe("mintable", () => {
  const NOW_MS = Date.parse("2026-08-23T12:00:00Z");
  const m = (who: string, evidence: string) => mintable(LINES, { who, evidence }, NOW_MS);

  it("refuses a who=me promise sitting in THEIR line", () => {
    expect(m("me", "帮我把BOM发给温总")).toBe(false);
  });

  it("allows THEIR commitment recorded as theirs", () => {
    expect(m("them", "帮我把BOM发给温总")).toBe(true);
  });

  it("refuses a line past the mint window, whoever spoke", () => {
    expect(m("them", "老黄历:帮我订去年的展位")).toBe(false);
  });

  it("refuses a hedge in my own line", () => {
    expect(m("me", "我看看周末有没有空弄官网")).toBe(false);
  });

  it("allows a fresh, unhedged promise in my own line", () => {
    expect(m("me", "好的我今天发你")).toBe(true);
  });

  it("allows evidence that resolves to no single line", () => {
    expect(m("me", "好的我今天发你了张工")).toBe(true);
  });

  it("allows a Gmail body line — unknown speaker is not a verdict", () => {
    expect(m("me", "I will send the enclosure drawings tomorrow")).toBe(true);
  });
});

describe("capCorpus (a 385k corpus timed out the assess pass entirely)", () => {
  const section = (name: string, n: number, tag: string) =>
    [`=== ${name} ===`, ...Array.from({ length: n }, (_, i) => `[2026-09-${String((i % 28) + 1).padStart(2, "0")}] ${tag}${i}: hello`)].join("\n");

  it("returns a corpus that already fits, untouched", () => {
    const small = section("wechat", 3, "a");
    expect(capCorpus(small, 10_000)).toBe(small);
  });

  // The corpus is slices joined together, so slicing the whole STRING would
  // delete whole sources instead of old messages — the Slack half of a
  // Slack+WeChat contact would simply vanish.
  it("keeps every source alive rather than dropping the earliest ones", () => {
    const corpus = [section("slack DM", 400, "s"), section("wechat", 400, "w")].join("\n\n");
    const capped = capCorpus(corpus, 4_000);
    expect(capped).toContain("=== slack DM ===");
    expect(capped).toContain("=== wechat ===");
    expect(capped.length).toBeLessThanOrEqual(corpus.length);
  });

  it("keeps the NEWEST lines of each source, not the oldest", () => {
    const capped = capCorpus(section("wechat", 400, "w"), 2_000);
    expect(capped).toContain("w399");
    expect(capped).not.toContain("w0:");
  });

  it("marks the elision so silence is not mistaken for the whole story", () => {
    expect(capCorpus(section("wechat", 400, "w"), 2_000)).toContain("…(earlier messages omitted)");
  });

  it("never splits a line in half", () => {
    const capped = capCorpus(section("wechat", 400, "w"), 2_000);
    for (const line of capped.split("\n")) {
      if (line.startsWith("===") || line.startsWith("…") || line === "") continue;
      expect(line).toMatch(/^\[2026-09-\d\d\] w\d+: hello$/);
    }
  });

  it("degrades to a plain tail when there are no section headers at all", () => {
    const plain = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const capped = capCorpus(plain, 1_000);
    expect(capped.length).toBeLessThanOrEqual(1_000 + 40);
    expect(capped).toContain("line 499");
  });
});
