import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify, parse } from "yaml";
import { updatePersonaCommitments, type PersonaUpdateDeps } from "./persona-update.js";
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

const OPEN = [{ who: "them", what: "Send the manufacturing agreement for signature", status: "open" }];

function deps(over: Partial<PersonaUpdateDeps> & { reply?: unknown }): PersonaUpdateDeps {
  return {
    json: async () => over.reply ?? { commitments: [], updates: [] },
    resolvePersona: (h) => (h === "U_ZECH" ? zech : null),
    // The quote gate verifies evidence against THIS corpus — fixtures below
    // quote it verbatim on purpose.
    fetchAllForPerson: async () => "Yang: agreement signed and returned. me: please review the countersigned copy",
    personaDir: "",
    ttlMs: 0,
    nowMs: () => 1,
    ...over,
  };
}

describe("updatePersonaCommitments — status transitions", () => {
  let dir: string;
  beforeEach(() => {
    dir = personaDirWith(OPEN);
  });
  const ledger = () =>
    (parse(readFileSync(join(dir, "zech-noiseux.yaml"), "utf8")) as { commitments: Array<{ status: string }> })
      .commitments;

  // THE case: the engine concluded "PCB agreements signed & returned by Yang"
  // from a Gmail message on 07-30 while the ledger's entry stayed open — the
  // ledger was append-only, so a finished commitment had no way to finish.
  it("closes a tracked commitment the conversation shows done", async () => {
    const r = await updatePersonaCommitments(
      [card()],
      deps({
        personaDir: dir,
        reply: { commitments: [], updates: [{ index: 0, status: "done", evidence: "signed and returned" }] },
      }),
    );
    expect(r.updated).toEqual([{ key: "zech-noiseux", added: 0, statusChanged: 1 }]);
    expect(ledger()[0]!.status).toBe("done");
  });

  it("ignores an out-of-range index and a no-op transition", async () => {
    const r = await updatePersonaCommitments(
      [card()],
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
      [card()],
      deps({
        personaDir: dir,
        reply: {
          commitments: [{ who: "me", what: "Review the countersigned copy", evidence: "please review" }],
          updates: [{ index: 0, status: "done", evidence: "signed and returned" }],
        },
      }),
    );
    expect(r.updated).toEqual([{ key: "zech-noiseux", added: 1, statusChanged: 1 }]);
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
      [card()],
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
      [card()],
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
  it("prefers fetchAllForPerson and hands the prompt every source", async () => {
    const dir = personaDirWith(OPEN);
    let seenThread = "";
    await updatePersonaCommitments(
      [card()],
      deps({
        personaDir: dir,
        fetchAllForPerson: async () => "=== slack ===\nraised here\n=== gmail ===\nsigned and returned",
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
