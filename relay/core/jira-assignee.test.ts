import { describe, expect, it } from "vitest";
import { resolveJiraAssignee, type JiraAccountCandidate, displayNameForKey } from "./jira-assignee.js";

const human = (displayName: string, accountId: string): JiraAccountCandidate => ({
  accountId,
  displayName,
  accountType: "atlassian",
});
const bot = (displayName: string, accountId: string): JiraAccountCandidate => ({
  accountId,
  displayName,
  accountType: "app",
});

describe("resolveJiraAssignee (ASK-not-GUESS)", () => {
  it("resolves on an exact, unambiguous human match", () => {
    const candidates = [human("Alice Chen", "acc-1"), human("Bob Lee", "acc-2")];
    expect(resolveJiraAssignee("Alice Chen", candidates)).toEqual({
      status: "resolved",
      accountId: "acc-1",
    });
  });

  it("is case- and whitespace-insensitive", () => {
    const candidates = [human("Alice Chen", "acc-1")];
    expect(resolveJiraAssignee("  alice chen ", candidates)).toEqual({
      status: "resolved",
      accountId: "acc-1",
    });
  });

  it("no match → unresolved no-match, never guesses", () => {
    const candidates = [human("Bob Lee", "acc-2")];
    expect(resolveJiraAssignee("Alice Chen", candidates)).toEqual({
      status: "unresolved",
      reason: "no-match",
    });
  });

  it("two humans with the same display name → unresolved ambiguous", () => {
    const candidates = [human("Alice Chen", "acc-1"), human("Alice Chen", "acc-3")];
    expect(resolveJiraAssignee("Alice Chen", candidates)).toEqual({
      status: "unresolved",
      reason: "ambiguous",
    });
  });

  it("excludes bot/app accounts even on an exact name match", () => {
    const candidates = [bot("Automation for Jira", "bot-1")];
    expect(resolveJiraAssignee("Automation for Jira", candidates)).toEqual({
      status: "unresolved",
      reason: "no-match",
    });
  });

  it("a bot with the same name as a human does not create ambiguity", () => {
    const candidates = [human("Alice Chen", "acc-1"), bot("Alice Chen", "bot-1")];
    expect(resolveJiraAssignee("Alice Chen", candidates)).toEqual({
      status: "resolved",
      accountId: "acc-1",
    });
  });
});

// 2026-09-11: the drafter wrote `ihor-kachura` as the assignee. That is the
// persona key it sees throughout its own context, and it is precisely what
// resolveJiraAssignee cannot resolve — Jira matches on display name, so the
// ticket would have shipped unassigned with nothing reporting why.
describe("displayNameForKey", () => {
  const roster = [
    { key: "ihor-kachura", displayName: "Ihor Kachura" },
    { key: "zack-louttit", displayName: "Zack Louttit" },
  ];

  it("converts a persona key to the name Jira matches on", () => {
    expect(displayNameForKey("ihor-kachura", roster)).toBe("Ihor Kachura");
    // Whatever case the drafter used — the key is an identifier, not prose.
    expect(displayNameForKey("Ihor-Kachura", roster)).toBe("Ihor Kachura");
  });

  it("leaves a real display name alone", () => {
    expect(displayNameForKey("Ihor Kachura", roster)).toBe("Ihor Kachura");
  });

  it("passes an unknown name through, so ASK-not-GUESS still decides", () => {
    // No fuzzy matching on people, ever. 「Ihor」 alone is not a key and must
    // NOT be bent into one — that is the Echo mis-binding.
    expect(displayNameForKey("Ihor", roster)).toBe("Ihor");
    expect(displayNameForKey("someone-not-on-the-team", roster)).toBe("someone-not-on-the-team");
  });

  it("resolves after conversion, and refuses before it", () => {
    const accounts = [
      { accountId: "acc-ihor", displayName: "Ihor Kachura", accountType: "atlassian" },
    ];
    expect(resolveJiraAssignee("ihor-kachura", accounts).status).toBe("unresolved");
    expect(resolveJiraAssignee(displayNameForKey("ihor-kachura", roster), accounts)).toEqual({
      status: "resolved",
      accountId: "acc-ihor",
    });
  });
});
