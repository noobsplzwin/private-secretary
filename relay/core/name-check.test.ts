import { describe, expect, it } from "vitest";
import { findUnverifiedNames, rosterAliases } from "./name-check.js";

const roster = [
  { key: "cody-taiv", displayName: "Cody Chen", handles: { slack: "U0165SDQ4RJ", gmail: "cody@taiv.tv" } },
  { key: "michael-dobosz", displayName: "Michael Dobosz", handles: { gmail: "michael@taiv.tv" } },
];
const aliases = rosterAliases(roster);

describe("findUnverifiedNames", () => {
  // THE case: the model wrote this on a card whose sender was Cody. There is no
  // Fabian persona and the word is nowhere in the thread.
  it("flags a name that is in neither the thread nor the roster", () => {
    expect(
      findUnverifiedNames(["回 Fabian：4 点须列为 hard must-have"], {
        threadText: "Cody: JD 改完了，你看一下",
        aliases,
      }),
    ).toEqual(["Fabian"]);
  });

  it("accepts a name the thread actually used", () => {
    expect(
      findUnverifiedNames(["回 Darren 说 Ihor 主导排查"], {
        threadText: "Darren: 我休假前想把 build server 交接掉",
        aliases: [],
      }),
    ).toEqual([]);
  });

  // Someone on the roster is nameable even when this thread never says it.
  it("accepts a roster name absent from the thread", () => {
    expect(findUnverifiedNames(["同步 Michael 最新进度"], { threadText: "", aliases })).toEqual([]);
    expect(findUnverifiedNames(["催 Cody 回复"], { threadText: "", aliases })).toEqual([]);
  });

  it("catches the English addressing forms too", () => {
    const out = findUnverifiedNames(
      ["Ping Rajat about the partnership page", "assign to Graham", "follow up with Sara Lee"],
      { threadText: "", aliases },
    );
    expect(out).toEqual(["Rajat", "Graham", "Sara Lee"]);
  });

  // A noisy warning is one people learn to ignore, so the common
  // verb-then-thing shapes must stay quiet.
  it("does not treat a thing after the verb as a person", () => {
    expect(
      findUnverifiedNames(
        ["回复报价", "同步进度给团队", "确认地址", "notify the team", "ask him again", "回复邮件"],
        { threadText: "", aliases },
      ),
    ).toEqual([]);
  });

  // REGRESSION, from real output: capturing 2-3 CJK characters after a Chinese
  // verb fired on 5 of 15 freshly drafted cards and was wrong every time. Only
  // a LATIN name is captured after a Chinese verb now.
  it("does not mistake a Chinese sentence fragment for a name", () => {
    expect(
      findUnverifiedNames(
        [
          "找负责该问题的同事确认",
          "问清哪几处需要改",
          "通报与客户的进展",
          "联系三家是否都到位",
          "同步现场设备状态",
        ],
        { threadText: "", aliases },
      ),
    ).toEqual([]);
  });

  // A Latin name after a Chinese verb is still caught — that is the Fabian shape.
  it("still catches a Latin name after a Chinese verb", () => {
    expect(findUnverifiedNames(["找 Rajat 确认"], { threadText: "", aliases })).toEqual(["Rajat"]);
  });

  it("ignores a lowercase word after an English verb", () => {
    expect(findUnverifiedNames(["ask around for a quote"], { threadText: "", aliases })).toEqual([]);
  });

  it("reports each unknown name once", () => {
    const out = findUnverifiedNames(["回 Fabian 确认", "催 Fabian 回复"], { threadText: "", aliases });
    expect(out).toEqual(["Fabian"]);
  });

  it("strips trailing punctuation from the captured name", () => {
    expect(findUnverifiedNames(["回 Fabian，明天给答复"], { threadText: "", aliases })).toEqual([
      "Fabian",
    ]);
  });

  it("is quiet on text with no addressing at all", () => {
    expect(
      findUnverifiedNames(["清点并刷好 1-2 台 Rev4.5 整机", "Review Jira TAIV-6462"], {
        threadText: "",
        aliases,
      }),
    ).toEqual([]);
  });
});

describe("rosterAliases", () => {
  it("includes key, display name, first name and handles", () => {
    expect(rosterAliases([roster[0]!])).toEqual([
      "cody-taiv",
      "Cody Chen",
      "Cody",
      "U0165SDQ4RJ",
      "cody@taiv.tv",
    ]);
  });
});
