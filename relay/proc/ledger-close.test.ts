import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markLedgerCommitmentsDone, markLedgerCommitmentsDropped } from "./ledger-close.js";
import { stableHash } from "../core/unit-key.js";

let dir: string;

const persona = (key: string, body: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${key}.yaml`), body, "utf8");
};

// Minimal persona the store will read back and re-emit.
const withCommitments = (key: string, rows: string): string => `key: ${key}
display_name: ${key}
handles: {}
identity:
  role: peer
  relationship: peer
relationship_meta: {}
communication:
  language: en
commitments:
${rows}
evidence:
  display_name: fixture
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-close-"));
});

describe("markLedgerCommitmentsDone", () => {
  // THE BUG: finishing a ledger row in TickTick settled nothing, because the
  // row is re-derived from the commitment every tick.
  it("marks the matching open commitment done", () => {
    const what = "Benchmark on OSYX side as well";
    persona("sandro", withCommitments("sandro", `  - who: me\n    what: ${what}\n    status: open\n`));
    const n = markLedgerCommitmentsDone([`ledger_sandro_${stableHash(what)}`], { personaDir: dir });
    expect(n).toBe(1);
    expect(readFileSync(join(dir, "sandro.yaml"), "utf8")).toContain("status: done");
  });

  // `dropped` was a decision the owner already made. Calling it done would
  // claim work happened that never did.
  it("never revives a dropped commitment", () => {
    const what = "Something he killed";
    persona("x", withCommitments("x", `  - who: me\n    what: ${what}\n    status: dropped\n`));
    const n = markLedgerCommitmentsDone([`ledger_x_${stableHash(what)}`], { personaDir: dir });
    expect(n).toBe(0);
    expect(readFileSync(join(dir, "x.yaml"), "utf8")).toContain("status: dropped");
  });

  // One persona can own several closed rows. Each write is a whole-file emit,
  // so per-row writes would let a later one clobber an earlier one's change.
  it("applies every hash for one persona in a single write", () => {
    const a = "First thing";
    const b = "Second thing";
    persona("multi", withCommitments("multi",
      `  - who: me\n    what: ${a}\n    status: open\n  - who: me\n    what: ${b}\n    status: open\n`));
    const n = markLedgerCommitmentsDone(
      [`ledger_multi_${stableHash(a)}`, `ledger_multi_${stableHash(b)}`],
      { personaDir: dir },
    );
    expect(n).toBe(2);
    const out = readFileSync(join(dir, "multi.yaml"), "utf8");
    expect(out.match(/status: done/g)).toHaveLength(2);
  });

  // A card row's closure travels on its ActionItems; there is no commitment.
  it("ignores card unitKeys", () => {
    expect(markLedgerCommitmentsDone(["__ungrouped_abc123"], { personaDir: dir })).toBe(0);
  });

  // A row can outlive a persona rewrite. A miss must never fail the tick.
  it("survives a missing persona and a hash that matches nothing", () => {
    persona("here", withCommitments("here", `  - who: me\n    what: Real\n    status: open\n`));
    const errs: string[] = [];
    const n = markLedgerCommitmentsDone(
      ["ledger_gone_deadbeef", "ledger_here_nomatch"],
      { personaDir: dir, onError: (k) => errs.push(k) },
    );
    expect(n).toBe(0);
    expect(errs).toEqual(["gone"]);
  });
});

// 🚫 on a LEDGER row (2026-09-29). Ledger rows never carried the dismiss line,
// so the only way off the list was 完成 — which marks the work DONE. Ticking 🚫
// must say the opposite: this was never his to do.
describe("markLedgerCommitmentsDropped", () => {
  it("drops the commitment behind the row — dropped, never done", () => {
    const what = "Drive Leo's suitcase over to 张江";
    persona("chen", withCommitments("chen", `  - who: them\n    what: ${what}\n    status: open\n`));
    const n = markLedgerCommitmentsDropped(
      [{ unitKey: `ledger_chen_${stableHash("chase:" + what)}`, title: `催: ${what}` }],
      { personaDir: dir },
    );
    expect(n).toBe(1);
    const body = readFileSync(join(dir, "chen.yaml"), "utf8");
    expect(body).toContain("status: dropped");
    expect(body).not.toContain("status: done");
  });

  // A matter row stands for a whole chain, and one 完成 on 2026-09-29 closed 24
  // links. 🚫 judges the ROW he saw — only the link its title shows drops.
  it("drops only the link the matter row SHOWED, not the whole chain", () => {
    persona(
      "jin",
      withCommitments(
        "jin",
        [
          `  - who: me\n    what: 出PPT技术方案\n    status: open\n    matter_id: venture`,
          `  - who: them\n    what: 约诚哥聊投资\n    status: open\n    matter_id: venture`,
          `  - who: me\n    what: 已经做完的\n    status: done\n    matter_id: venture`,
          `  - who: me\n    what: 别的事\n    status: open\n    matter_id: other`,
        ].join("\n") + "\n",
      ),
    );
    const n = markLedgerCommitmentsDropped(
      [{ unitKey: `ledger_jin_${stableHash("matter:venture")}`, title: "出PPT技术方案" }],
      { personaDir: dir },
    );
    expect(n).toBe(1);
    const body = readFileSync(join(dir, "jin.yaml"), "utf8");
    expect(body.match(/status: dropped/g)).toHaveLength(1);
    expect(body).toContain("status: done"); // settled work untouched
    expect(body.match(/status: open/g)).toHaveLength(2); // its sibling and the other matter untouched
  });

  // 2026-10-03: dismissing 「Talk to more customers & Renesas」 left its listed
  // sibling open, and it was queued as the next row.
  it("also drops the links the row LISTED as his, never the ones waiting on them", () => {
    persona(
      "david",
      withCommitments(
        "david",
        [
          `  - who: me\n    what: Talk to customers\n    status: open\n    matter_id: leap`,
          `  - who: me\n    what: Add options to the weekly agenda\n    status: open\n    matter_id: leap`,
          `  - who: them\n    what: Send the hypervisor build\n    status: open\n    matter_id: leap`,
          `  - who: me\n    what: Not shown on the row\n    status: open\n    matter_id: leap`,
        ].join("\n") + "\n",
      ),
    );
    const n = markLedgerCommitmentsDropped(
      [{ unitKey: `ledger_david_${stableHash("matter:leap")}`, title: "Talk to customers", shown: ["Add options to the weekly agenda"] }],
      { personaDir: dir },
    );
    expect(n).toBe(2);
    const body = readFileSync(join(dir, "david.yaml"), "utf8");
    expect(body.match(/status: dropped/g)).toHaveLength(2);
    expect(body.match(/status: open/g)).toHaveLength(2);
  });

  it("with no title to go by, drops NOTHING rather than guessing", () => {
    persona("jin", withCommitments("jin", `  - who: me\n    what: 出PPT技术方案\n    status: open\n    matter_id: venture\n`));
    const n = markLedgerCommitmentsDropped([{ unitKey: `ledger_jin_${stableHash("matter:venture")}` }], { personaDir: dir });
    expect(n).toBe(0);
  });
});
