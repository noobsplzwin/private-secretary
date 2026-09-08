import { describe, expect, it } from "vitest";
import { s0Current } from "./s0-current.js";
import type { EvalInput } from "../l2a.js";

// 2026-09-04 → 09-06: this strategy used to re-implement the pipeline. The copy
// is why a run reported precision unchanged after three gates shipped, and why
// the promotion gate, the chase rule and the two-sided assess all went
// unmeasured — until a regression reached the owner's screen instead of a
// scorecard. These tests pin the strategy to PRODUCTION behaviour: if a rule
// ships in core and the bench stops seeing it, one of these fails.
const person = (over: Partial<EvalInput["persons"][number]> = {}) => ({
  personaKey: "zech-noiseux",
  displayName: "Zech Noiseux",
  corpus: "[2026-08-22 10:00] me: I'll send Cody the Rev5 docs today",
  ledger: [],
  ...over,
});

const input = (over: Partial<EvalInput> = {}): EvalInput => ({
  frozenAt: "2026-08-23T12:00:00Z",
  matters: ["fcc"],
  persons: [person()],
  ...over,
});

describe("S0 renders the list production would render", () => {
  // The contrast pair: identical input, only the matter differs. Live → the row
  // is proposed (see 依据 test below); dead → the promotion gate sinks it and
  // nothing is proposed. A strategy that skipped the derive would propose both.
  const assessedRow = (matterId: string, closed: string[] = []) =>
    s0Current(async () => ({
      commitments: [],
      updates: [],
      assessments: [
        {
          index: 0,
          needs_leo: true,
          next_step: "Send Cody the Rev5 capture-card docs",
          evidence: "I'll send Cody the Rev5 docs today",
        },
      ],
    })).propose(
      input({
        closedMatters: closed,
        persons: [
          person({
            ledger: [{ who: "me", what: "Send Cody the Rev5 docs", status: "open", matter_id: matterId }],
          }),
        ],
      }),
    );

  it("proposes the row when its matter is live", async () => {
    expect((await assessedRow("fcc")).map((p) => p.title)).toEqual(["Send Cody the Rev5 docs"]);
  });

  // REVISED 2026-09-07 by owner ruling 「verdict说了算」: an unregistered id is
  // unfiled work and still promotes. Only a matter he CLOSED sinks a judged row.
  it("proposes nothing when the owner has closed that matter", async () => {
    expect(await assessedRow("retired-matter", ["retired-matter"])).toEqual([]);
  });

  it("still proposes when the matter id is merely unregistered", async () => {
    const props = await assessedRow("an-id-the-model-coined");
    expect(props.map((p) => p.title)).toEqual(["Send Cody the Rev5 docs"]);
  });

  it("a fresh commitment with no verdict is not working-list work", async () => {
    // needs_leo is what promotes. Without it the row sinks, and a sunk row is
    // not something the owner is being told to do today.
    const props = await s0Current(async () => ({
      commitments: [
        {
          who: "me",
          what: "Send Cody the Rev5 docs",
          status: "open",
          matter_id: "fcc",
          evidence: "I'll send Cody the Rev5 docs today",
        },
      ],
      updates: [],
      assessments: [],
    })).propose(input());
    // It IS tracked — it just sits on the floor, and the floor is not a
    // proposal. Production would put it in 待办池, not in front of him.
    expect(props).toEqual([]);
  });

  it("carries the row's own 依据 through as evidence", async () => {
    const props = await s0Current(async () => ({
      commitments: [],
      updates: [],
      assessments: [
        {
          index: 0,
          needs_leo: true,
          next_step: "Send Cody the Rev5 capture-card docs",
          evidence: "I'll send Cody the Rev5 docs today",
        },
      ],
    })).propose(
      input({
        persons: [
          person({
            ledger: [
              { who: "me", what: "Send Cody the Rev5 docs", status: "open", matter_id: "fcc" },
            ],
          }),
        ],
      }),
    );
    expect(props).toHaveLength(1);
    expect(props[0]!.personaKey).toBe("zech-noiseux");
    expect(props[0]!.evidence).toEqual(["I'll send Cody the Rev5 docs today"]);
  });

  // The property the 2026-09-07 run lacked: work FOUND this round must still be
  // renderable. A fresh commitment has no verdict, and needs_leo is what
  // promotes — so one pass proposes nothing it just discovered, and that run
  // missed all seven real items while proposing only stale ledger rows.
  it("assesses in a second pass what the first pass extracted", async () => {
    let call = 0;
    const props = await s0Current(async () => {
      call++;
      return call === 1
        ? {
            commitments: [
              {
                who: "me",
                what: "Send Cody the Rev5 docs",
                status: "open",
                matter_id: "fcc",
                evidence: "I'll send Cody the Rev5 docs today",
              },
            ],
            updates: [],
            assessments: [],
          }
        : {
            commitments: [],
            updates: [],
            assessments: [
              {
                index: 0,
                needs_leo: true,
                next_step: "Send Cody the Rev5 capture-card docs",
                evidence: "I'll send Cody the Rev5 docs today",
              },
            ],
          };
    }).propose(input());
    expect(call).toBe(2);
    expect(props.map((p) => p.title)).toEqual(["Send Cody the Rev5 docs"]);
  });

  it("an LLM failure costs that person, not the run", async () => {
    const props = await s0Current(async () => {
      throw new Error("claude -p timed out");
    }).propose(input());
    expect(props).toEqual([]);
  });
});
