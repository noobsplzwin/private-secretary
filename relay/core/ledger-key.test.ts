import { describe, expect, it } from "vitest";
import { parseLedgerUnitKey, commitmentMatchesHash } from "./ledger-list.js";
import { stableHash } from "./unit-key.js";

describe("ledger unitKey round-trip", () => {
  // REGRESSION: the owner finishing a ledger row did nothing, so the commitment
  // stayed open and the row came back on the next tick, forever.
  it("decodes a key back to its persona and hash", () => {
    const what = "Benchmark on OSYX side as well";
    const key = `ledger_wechat-sandro-pinto_${stableHash(what)}`;
    const p = parseLedgerUnitKey(key);
    expect(p).toEqual({ personaKey: "wechat-sandro-pinto", hash: stableHash(what) });
    expect(commitmentMatchesHash(what, p!.hash)).toBe(true);
    expect(commitmentMatchesHash("something else", p!.hash)).toBe(false);
  });

  it("matches a chase row, whose text is hashed with its prefix", () => {
    const what = "Arrange the payment";
    const key = `ledger_hua-miao_${stableHash("chase:" + what)}`;
    expect(commitmentMatchesHash(what, parseLedgerUnitKey(key)!.hash)).toBe(true);
  });

  // A personaKey can contain "_", so the LAST separator is the split point.
  it("splits on the last separator", () => {
    expect(parseLedgerUnitKey("ledger_a_b_c_deadbeef")).toEqual({ personaKey: "a_b_c", hash: "deadbeef" });
  });

  it("ignores a card unitKey", () => {
    expect(parseLedgerUnitKey("__ungrouped_71382537")).toBeNull();
  });
});
