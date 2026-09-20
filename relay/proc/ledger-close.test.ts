import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markLedgerCommitmentsDone } from "./ledger-close.js";
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
