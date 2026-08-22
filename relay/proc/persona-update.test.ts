import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify, parse } from "yaml";
import { updatePersonaCommitments, _resetExtractGate, type PersonaUpdateDeps } from "./persona-update.js";
import type { ActionItem } from "../core/action-item.js";
import type { Persona } from "../core/types.js";

const zech: Persona = {
  key: "zech-noiseux",
  displayName: "Zech Noiseux",
  relationship: "vp partnerships",
  handles: { slack: "U_ZECH", gmail: "zech@taiv.tv" },
  language: "en",
  register: "casual",
  toneNotes: "upbeat",
  context: "partnerships",
};

const card = (over: Partial<ActionItem> = {}): ActionItem => ({
  id: "c1",
  source_message_id: "slack:D1:1",
  action_type: "task",
  target: {},
  reason: "r",
  confidence: 0.9,
  params: {},
  status: "suggested",
  created_at: "2026-08-13T00:00:00Z",
  context: { sender_handle: "U_ZECH" },
  ...over,
});

// A minimal valid persona file with one OPEN commitment the tests transition.
function personaDirWith(commitments: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "persona-update-"));
  writeFileSync(
    join(dir, "zech-noiseux.yaml"),
    stringify({
      schema: "persona-v3",
      key: "zech-noiseux",
      display_name: "Zech Noiseux",
      handles: { slack: "U_ZECH", gmail: "zech@taiv.tv" },
      commitments,
      provenance: { commitments: "inferred" },
    }),
  );
  return dir;
}

// The pass now takes WHO to assess, not which cards are open.
const QUEUED = { personaKey: "zech-noiseux", trafficMs: 1 };

const OPEN = [{ who: "them", what: "Send the manufacturing agreement for signature", status: "open" }];

function deps(over: Partial<PersonaUpdateDeps> & { reply?: unknown }): PersonaUpdateDeps {
  return {
    json: async () => over.reply ?? { commitments: [], updates: [] },
    personaFor: (key) => (key === "zech-noiseux" ? zech : null),
    // The quote gate verifies evidence against THIS corpus — fixtures below
    // quote it verbatim on purpose.
    fetchCorpus: async () => "Yang: agreement signed and returned. me: please review the countersigned copy",
    personaDir: "",
    ...over,
  };
}

describe("updatePersonaCommitments — status transitions", () => {
  let dir: string;
  beforeEach(() => {
    dir = personaDirWith(OPEN);
    _resetExtractGate(); // module-level memo; would otherwise leak between cases
  });
  const ledger = () =>
    (parse(readFileSync(join(dir, "zech-noiseux.yaml"), "utf8")) as { commitments: Array<{ status: string }> })
      .commitments;

  // THE case: the engine concluded "PCB agreements signed & returned by Yang"
  // from a Gmail message on 07-30 while the ledger's entry stayed open — the
  // ledger was append-only, so a finished commitment had no way to finish.
  it("closes a tracked commitment the conversation shows done", async () => {
    const r = await updatePersonaCommitments(
      [QUEUED],
      deps({
        personaDir: dir,
        reply: { commitments: [], updates: [{ index: 0, status: "done", evidence: "signed and returned" }] },
      }),
    );
    expect(r.updated).toEqual([{ key: "zech-noiseux", added: 0, statusChanged: 1, assessed: 0 }]);
    expect(ledger()[0]!.status).toBe("done");
  });

  it("ignores an out-of-range index and a no-op transition", async () => {
    const r = await updatePersonaCommitments(
      [QUEUED],
      deps({
        personaDir: dir,
        reply: {
          commitments: [],
          updates: [
            { index: 5, status: "done", evidence: "q" },
            { index: 0, status: "open", evidence: "q" }, // already open
          ],
        },
      }),
    );
    expect(r.updated).toEqual([]);
    expect(ledger()[0]!.status).toBe("open");
  });

  it("applies a transition and an addition in one write", async () => {
    const r = await updatePersonaCommitments(
      [QUEUED],
      deps({
        personaDir: dir,
        reply: {
          commitments: [{ who: "me", what: "Review the countersigned copy", evidence: "please review" }],
          updates: [{ index: 0, status: "done", evidence: "signed and returned" }],
        },
      }),
    );
    expect(r.updated).toEqual([{ key: "zech-noiseux", added: 1, statusChanged: 1, assessed: 0 }]);
    expect(ledger()).toHaveLength(2);
    expect(ledger()[0]!.status).toBe("done");
  });
});

describe("updatePersonaCommitments — quote gate", () => {
  // Grounding is mechanical: an extraction whose evidence is not IN the corpus
  // is invented, and an invented "done" silently closes real work.
  it("discards a transition whose evidence is not in the corpus", async () => {
    const dir = personaDirWith(OPEN);
    const r = await updatePersonaCommitments(
      [QUEUED],
      deps({
        personaDir: dir,
        reply: {
          commitments: [],
          updates: [{ index: 0, status: "done", evidence: "the factory confirmed everything" }],
        },
      }),
    );
    expect(r.updated).toEqual([]);
    expect(r.discarded).toBe(1);
  });

  it("discards an invented new commitment the same way", async () => {
    const dir = personaDirWith(OPEN);
    const r = await updatePersonaCommitments(
      [QUEUED],
      deps({
        personaDir: dir,
        reply: {
          commitments: [{ who: "them", what: "Ship the V2 boards", evidence: "V2 boards next week" }],
          updates: [],
        },
      }),
    );
    expect(r.updated).toEqual([]);
    expect(r.discarded).toBe(1);
  });
});

describe("updatePersonaCommitments — cross-source retrieval", () => {
  it("hands the prompt every source the person is reachable on", async () => {
    const dir = personaDirWith(OPEN);
    let seenThread = "";
    await updatePersonaCommitments(
      [QUEUED],
      deps({
        personaDir: dir,
        fetchCorpus: async () => "=== slack ===\nraised here\n=== gmail ===\nsigned and returned",
        json: async (req) => {
          seenThread = req.userText;
          return { commitments: [], updates: [] };
        },
      }),
    );
    expect(seenThread).toContain("=== gmail ===");
    expect(seenThread).toContain("signed and returned");
  });

});

// Measured: 909 real calls of this pass carried only 202 distinct inputs, so 78%
// of them paid to re-answer a question already answered. Identical corpus +
// identical tracked list can only produce the identical result.
describe("persona-update call gate", () => {
  let dir: string;
  beforeEach(() => {
    dir = personaDirWith(OPEN);
    _resetExtractGate();
  });

  it("does not call the LLM twice for the same corpus and ledger", async () => {
    let calls = 0;
    const d = () =>
      deps({ personaDir: dir, json: async () => { calls++; return { commitments: [], updates: [] }; } });
    await updatePersonaCommitments([QUEUED], d());
    expect(calls).toBe(1);
    await updatePersonaCommitments([QUEUED], d());
    expect(calls).toBe(1);
  });

  it("calls again when the corpus moves on", async () => {
    let calls = 0;
    const d = (corpus: string) =>
      deps({
        personaDir: dir,
        fetchCorpus: async () => corpus,
        json: async () => { calls++; return { commitments: [], updates: [] }; },
      });
    await updatePersonaCommitments([QUEUED], d("Yang: agreement signed and returned."));
    await updatePersonaCommitments([QUEUED], d("Yang: agreement signed and returned.\nYang: one more thing"));
    expect(calls).toBe(2);
  });

  // A thrown call must stay retryable, not be memoized as handled.
  it("stays retryable when the call throws", async () => {
    let calls = 0;
    const d = (fail: boolean) =>
      deps({
        personaDir: dir,
        json: async () => { calls++; if (fail) throw new Error("timeout"); return { commitments: [], updates: [] }; },
      });
    await updatePersonaCommitments([QUEUED], d(true));
    await updatePersonaCommitments([QUEUED], d(false));
    expect(calls).toBe(2);
  });
});

// ASSESS (specs/person-first-consolidation.md §3.2). needs_leo is the one hard
// judgment the derived list rests on, so every guard around it is enforced in
// CODE — the prompt is asked, never trusted.
describe("assess verdicts", () => {
  const MINE = [{ who: "me", what: "Review the countersigned copy", status: "open" }];
  let dir: string;
  beforeEach(() => {
    dir = personaDirWith(MINE);
    _resetExtractGate();
  });
  const ledger = () =>
    (parse(readFileSync(join(dir, "zech-noiseux.yaml"), "utf8")) as {
      commitments: Array<{ who: string; assessment?: Record<string, unknown> }>;
    }).commitments;

  const reply = (a: Record<string, unknown>) => ({ commitments: [], updates: [], assessments: [a] });

  it("lands a grounded verdict on the commitment, dated", async () => {
    const r = await updatePersonaCommitments(
      [QUEUED],
      deps({
        personaDir: dir,
        now: () => "2026-08-22T12:00:00Z",
        reply: reply({
          index: 0,
          needs_leo: true,
          blocked_on: "leo",
          next_step: "Read the countersigned copy and confirm the terms",
          evidence: "please review the countersigned copy",
        }),
      }),
    );
    expect(r.assessed).toBe(1);
    expect(ledger()[0]!.assessment).toEqual({
      needs_leo: true,
      blocked_on: "leo",
      next_step: "Read the countersigned copy and confirm the terms",
      evidence: "please review the countersigned copy",
      at: "2026-08-22T12:00:00Z",
    });
  });

  // The failure mode the whole grounding design exists for: a verdict whose
  // quote is not in the corpus is invented, and an invented needs_leo puts work
  // on the owner's list that nobody ever asked of him.
  it("discards a verdict whose evidence is not in the corpus", async () => {
    const r = await updatePersonaCommitments(
      [QUEUED],
      deps({
        personaDir: dir,
        reply: reply({ index: 0, needs_leo: true, evidence: "Leo please send the revised contract today" }),
      }),
    );
    expect(r.assessed).toBe(0);
    expect(r.discarded).toBe(1);
    expect(ledger()[0]!.assessment).toBeUndefined();
  });

  it("ignores a verdict aimed at work the CONTACT owes", async () => {
    dir = personaDirWith([{ who: "them", what: "Send the manufacturing agreement", status: "open" }]);
    const r = await updatePersonaCommitments(
      [QUEUED],
      deps({
        personaDir: dir,
        reply: reply({ index: 0, needs_leo: true, evidence: "agreement signed and returned" }),
      }),
    );
    expect(r.assessed).toBe(0);
    expect(ledger()[0]!.assessment).toBeUndefined();
  });

  it("drops next_step when the verdict says Leo is not needed", async () => {
    await updatePersonaCommitments(
      [QUEUED],
      deps({
        personaDir: dir,
        reply: reply({
          index: 0,
          needs_leo: false,
          blocked_on: "them",
          next_step: "chase them about it",
          evidence: "agreement signed and returned",
        }),
      }),
    );
    const a = ledger()[0]!.assessment!;
    expect(a.needs_leo).toBe(false);
    expect(a.next_step).toBeUndefined();
  });

  // A verdict is a statement about NOW. Keeping the old one would be the
  // "finished work that will not leave the list" complaint, one layer down.
  it("replaces a stale verdict rather than keeping it", async () => {
    const run = (needs_leo: boolean, at: string, corpus: string) =>
      updatePersonaCommitments(
        [QUEUED],
        deps({
          personaDir: dir,
          now: () => at,
          fetchCorpus: async () => corpus,
          reply: reply({ index: 0, needs_leo, evidence: "review the countersigned copy" }),
        }),
      );
    await run(true, "2026-08-01T00:00:00Z", "me: please review the countersigned copy");
    await run(false, "2026-08-22T00:00:00Z", "me: please review the countersigned copy\nZech: handled it");
    const a = ledger()[0]!.assessment!;
    expect(a.needs_leo).toBe(false);
    expect(a.at).toBe("2026-08-22T00:00:00Z");
  });
});
