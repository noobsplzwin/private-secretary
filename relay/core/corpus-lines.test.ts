import { describe, expect, it } from "vitest";
import { ageInDays, closedLater, indexCorpus, isHedged, lineOf } from "./corpus-lines.js";

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
