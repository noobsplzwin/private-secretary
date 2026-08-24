import { describe, expect, it } from "vitest";
import { assembleProposals, indexCorpus, lineOf, type Utterance } from "./s1-cfa.js";

const FROZEN = "2026-08-23T12:00:00Z";
const CORPUS = [
  "=== wechat ===",
  "[2026-08-20 10:00] 张工: 帮我把BOM发给温总",
  "[2026-08-20 10:05] me: 好的我今天发你",
  "[2026-08-21 09:00] me: 发你了",
  "[2026-08-21 09:10] 张工: 收到",
  "[2026-08-22 11:00] 张工: U2B-E24的板子什么时候能到?",
  "[2026-06-01 08:00] 张工: 老黄历:帮我订去年的展位",
  "[2026-08-22 12:00] me: 我看看周末有没有空弄官网",
].join("\n");

const u = (over: Partial<Utterance>): Utterance => ({
  quote: "好的我今天发你",
  act: "commissive",
  strength: "strong",
  addressee: "them",
  gloss: "把BOM发给温总",
  ...over,
});

describe("indexCorpus / lineOf", () => {
  it("reads speaker and date from the line prefix — never from the model", () => {
    const lines = indexCorpus(CORPUS);
    const mine = lineOf(lines, "好的我今天发你");
    expect(mine?.speaker).toBe("me");
    expect(mine?.date).toBe("2026-08-20");
    const theirs = lineOf(lines, "帮我把BOM发给温总");
    expect(theirs?.speaker).toBe("them");
  });

  it("rejects a quote that sits in no single line", () => {
    expect(lineOf(indexCorpus(CORPUS), "好的我今天发你了张工收到")).toBeNull();
  });
});

describe("assembleProposals — the CfA table in code", () => {
  it("closure kills a promise the owner later reported done", () => {
    // 我承诺发BOM → 我后来说「发你了」→ 不该出待办(G8 in embryo)
    const props = assembleProposals(
      "zhang",
      [
        u({}),
        u({ quote: "发你了", act: "assertive", gloss: undefined }),
      ],
      CORPUS,
      FROZEN,
    );
    expect(props).toEqual([]);
  });

  it("an unanswered directive at me becomes a 回应 todo", () => {
    const props = assembleProposals(
      "zhang",
      [u({ quote: "U2B-E24的板子什么时候能到?", act: "directive", addressee: "me", gloss: "答复U2B-E24板子的到货时间" })],
      CORPUS,
      FROZEN,
    );
    expect(props).toHaveLength(1);
    expect(props[0]!.title).toContain("回应");
    expect(props[0]!.title).toContain("U2B-E24");
  });

  // The two mechanical guards that S0 lacked, each on its own:
  it("a promise in THEIR line can never become my todo, whatever the model claims", () => {
    const props = assembleProposals(
      "zhang",
      [u({ quote: "帮我把BOM发给温总", act: "commissive", gloss: "发BOM" })],
      CORPUS,
      FROZEN,
    );
    expect(props).toEqual([]); // line speaker=them → commissive-by-me rule can't fire
  });

  it("old lines lose minting power (G5)", () => {
    const props = assembleProposals(
      "zhang",
      [u({ quote: "老黄历:帮我订去年的展位", act: "directive", addressee: "me", gloss: "订展位" })],
      CORPUS,
      FROZEN,
    );
    expect(props).toEqual([]); // 2026-06-01 is outside the 14-day window
  });

  it("hedged commitments never mint (「我看看」≠答应)", () => {
    const props = assembleProposals(
      "zhang",
      [u({ quote: "我看看周末有没有空弄官网", strength: "hedged", gloss: "弄官网" })],
      CORPUS,
      FROZEN,
    );
    expect(props).toEqual([]);
  });
});
