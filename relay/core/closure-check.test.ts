import { describe, expect, it } from "vitest";
import { closureProven, findClosures, spokenFromBatch, spokenFromCorpus, stampOf, type OpenItem } from "./closure-check.js";

// 2026-10-02, Slack DM: Michael asks, Leo answers that morning.
const CORPUS = [
  "[2026-10-02 00:03] Michael Dobosz: I need your input",
  "[2026-10-02 00:03] Michael Dobosz: should we hire ohm + another?",
  "[2026-10-02 11:39] me: I'd love to talk with him",
  "[2026-10-02 11:51] me: I do think one more eng between Zack and Ihor would be super valuable",
].join("\n");
const MINE: OpenItem = { handle: "R1", what: "Give Michael input on hiring Ohm", side: "me", after: "2026-10-02 00:03" };

describe("closureProven — the gate", () => {
  const spoken = spokenFromCorpus(CORPUS);
  it("accepts his own later line", () => {
    expect(closureProven(spoken, MINE, "one more eng between Zack and Ihor would be super valuable")).toBe(true);
  });
  it("refuses the other side's line from where the row began — their ask is not its answer", () => {
    expect(closureProven(spoken, MINE, "should we hire ohm")).toBe(false);
  });
  // 2026-10-18 「结合我们之后的聊天记录，自动判断完成」: 「收到了」 from the other
  // side finishes a delivery as surely as his own 「发你了」.
  it("accepts the other side's LATER line, and a fresh one with no stamp", () => {
    expect(closureProven(spoken, { ...MINE, side: "them" }, "I'd love to talk with him")).toBe(true);
    const batch = spokenFromBatch([
      { id: "m", platform: "wechat", senderHandle: "Dawn", timestampMs: 1, text: "收到电池图片了，谢谢", threadContext: "Dawn: 发我电池图片\n我: 好的" } as never,
    ]);
    const item: OpenItem = { handle: "R1", what: "发电池产品图片给Dawn", side: "me" };
    expect(closureProven(batch, item, "收到电池图片了")).toBe(true);
    // Their older context line never closes it.
    expect(closureProven(batch, item, "发我电池图片")).toBe(false);
  });
  it("refuses a line that is not later than where the row began", () => {
    expect(closureProven(spoken, { ...MINE, after: "2026-10-02 12:00" }, "I'd love to talk with him")).toBe(false);
  });
  it("refuses words that are not in the conversation, a line of the row's own origin, and a scrap", () => {
    expect(closureProven(spoken, MINE, "I already gave my input")).toBe(false);
    expect(closureProven(spoken, { ...MINE, origin: ["I'd love to talk with him"] }, "I'd love to talk with him")).toBe(false);
    expect(closureProven(spoken, MINE, "him")).toBe(false);
  });
  it("reads the stamp off a corpus line", () => {
    expect(stampOf("[2026-10-02 11:39] me: x")).toBe("2026-10-02 11:39");
    expect(stampOf("no stamp")).toBeUndefined();
  });
});

describe("spokenFromBatch", () => {
  it("marks 我 lines in the thread context as Leo's, everything else as theirs", () => {
    const s = spokenFromBatch([
      { id: "m", platform: "wechat", senderHandle: "李冰Bezos", timestampMs: 1, text: "这个黑色logo是android的吗", threadContext: "我: 录了个视频\n李冰Bezos: [表情]" } as never,
    ]);
    expect(s).toEqual([
      { speaker: "me", text: "我: 录了个视频" },
      { speaker: "them", text: "李冰Bezos: [表情]" },
      { speaker: "them", text: "这个黑色logo是android的吗", fresh: true },
    ]);
  });

  it("an ownerOnly message's own text is Leo's, so his line can close his card", () => {
    const s = spokenFromBatch([
      { id: "m", platform: "wechat", senderHandle: "程敏", timestampMs: 1, text: "[文件] 脱敏材料.pdf", ownerOnly: true, threadContext: "程敏: 材料发我一下" } as never,
    ]);
    expect(s).toEqual([
      { speaker: "them", text: "程敏: 材料发我一下" },
      { speaker: "me", text: "[文件] 脱敏材料.pdf", fresh: true },
    ]);
    expect(closureProven(s, { handle: "R1", what: "发脱敏材料给程敏", side: "me" }, "脱敏材料.pdf")).toBe(true);
  });
});

describe("findClosures", () => {
  const spoken = spokenFromCorpus(CORPUS);
  it("asks nothing when no line could close any item", async () => {
    let asked = false;
    const r = await findClosures("Michael", [{ ...MINE, after: "2026-10-03 00:00" }], spoken, async () => ((asked = true), {}));
    expect(asked).toBe(false);
    expect(r).toEqual([]);
  });
  it("keeps only proven closures, by handle", async () => {
    const r = await findClosures("Michael", [MINE], spoken, async () => ({
      closed: [
        { item: "R1", evidence: "I'd love to talk with him" },
        { item: "R9", evidence: "I'd love to talk with him" },
      ],
    }));
    expect(r.map((x) => x.item.handle)).toEqual(["R1"]);
  });
  it("a failed call closes nothing", async () => {
    expect(await findClosures("Michael", [MINE], spoken, async () => { throw new Error("down"); })).toEqual([]);
  });
});
