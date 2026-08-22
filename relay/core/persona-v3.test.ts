import { describe, it, expect } from "vitest";
import {
  applyLlmUpdates,
  evidenceFor,
  leafPaths,
  mergeContacts,
  mergeStagedIntoLive,
  migrateMechanical,
  provenanceFor,
  validatePersonaV3,
  type PersonaV3,
} from "./persona-v3.js";

const base: PersonaV3 = {
  key: "michael-dobosz",
  display_name: "Michael Dobosz",
  identity: {
    role: "Embedded Systems Team Lead (hardware & firmware)",
    org: "Taiv",
    relationship: "Leo's direct lead",
  },
  relationship_meta: { power: "serves-them", decision_authority: true },
  handles: { slack: "UR36HT3HV", gmail: "michael@taiv.tv", wechat: null },
  communication: { language: "en", register: "casual", tone_notes: "brief" },
  open_threads: "power-supply sizing",
  provenance: {
    "identity.*": "manual",
    "communication.*": "manual",
    open_threads: "manual",
    "relationship_meta.*": "inferred",
  },
  evidence: { "relationship_meta.*": "derived from relationship field (migrated)" },
  style_profile_meta: { last_built_at: null },
};

describe("provenanceFor / evidenceFor (wildcards)", () => {
  it("exact entry wins over wildcard", () => {
    const prov = { "identity.*": "manual", "identity.org": "inferred" } as const;
    expect(provenanceFor("identity.org", prov)).toBe("inferred");
    expect(provenanceFor("identity.role", prov)).toBe("manual");
  });
  it("no entry defaults to inferred (manual protection is explicit)", () => {
    expect(provenanceFor("behavior.reliability", base.provenance)).toBe("inferred");
  });
  it("evidence resolves through wildcards", () => {
    expect(evidenceFor("relationship_meta.power", base.evidence)).toMatch(/migrated/);
    expect(evidenceFor("personal.family", base.evidence)).toBeUndefined();
  });
});

// MANDATORY REGRESSION (specs/persona-v3.md R1) — never delete: manual fields
// survive any LLM rebuild/update, exact paths and wildcard-covered paths alike.
describe("R1: manual fields survive any LLM update (regression — never delete)", () => {
  it("blocks llm writes to wildcard-manual and exact-manual paths", () => {
    const res = applyLlmUpdates(base, {
      set: {
        "identity.role": "Janitor", // covered by identity.*: manual
        open_threads: "rewritten", // exact manual
        "behavior.reliability": "high", // unprotected -> allowed
      },
      evidence: {
        "identity.role": "msg 1",
        open_threads: "msg 2",
        "behavior.reliability": "slack:D123:1781.0 'always ships'",
      },
    });
    expect(res.blockedByR1.sort()).toEqual(["identity.role", "open_threads"]);
    expect(res.applied).toEqual(["behavior.reliability"]);
    expect(res.persona.identity?.role).toBe(base.identity?.role);
    expect(res.persona.open_threads).toBe("power-supply sizing");
    expect(res.persona.behavior?.reliability).toBe("high");
    expect(res.persona.provenance?.["behavior.reliability"]).toBe("inferred");
    expect(res.persona.evidence?.["behavior.reliability"]).toContain("always ships");
  });

  it("a forced full rebuild via staged merge keeps live manual fields", () => {
    const staged: PersonaV3 = {
      key: "michael-dobosz",
      display_name: "Mike D",
      identity: { role: "Rebuilt Role", org: "Rebuilt Org", relationship: "rebuilt" },
      behavior: { reliability: "ships fast" },
      provenance: { "identity.*": "inferred", "behavior.*": "inferred" },
      evidence: { "identity.*": "msgs", "behavior.*": "msgs" },
    };
    const { merged, keptManual } = mergeStagedIntoLive(base, staged);
    expect(merged.identity).toEqual(base.identity); // manual wins
    expect(keptManual).toEqual(
      expect.arrayContaining(["identity.role", "identity.org", "identity.relationship"]),
    );
    expect(merged.behavior?.reliability).toBe("ships fast"); // inferred lands
    expect(merged.display_name).toBe("Mike D"); // unprotected scalar updates
  });
});

describe("applyLlmUpdates rejections", () => {
  it("rejects updates without evidence (anti-fabrication: traceable or nothing)", () => {
    const res = applyLlmUpdates(base, { set: { "personal.family": "married" } });
    expect(res.missingEvidence).toEqual(["personal.family"]);
    expect(res.persona.personal).toBeUndefined();
  });
  it("rejects key/provenance/evidence and unknown roots", () => {
    const res = applyLlmUpdates(base, {
      set: { key: "other", "provenance.open_threads": "inferred", "bogus.x": 1 },
      evidence: { key: "e", "provenance.open_threads": "e", "bogus.x": "e" },
    });
    expect(res.invalid.sort()).toEqual(["bogus.x", "key", "provenance.open_threads"]);
    expect(res.applied).toEqual([]);
  });
  it("null value removes a field (with evidence) — fact corrections can retract", () => {
    const withFamily = applyLlmUpdates(base, {
      set: { "personal.family": "married" },
      evidence: { "personal.family": "msg a" },
    }).persona;
    const res = applyLlmUpdates(withFamily, {
      set: { "personal.family": null },
      evidence: { "personal.family": "msg b: corrected" },
    });
    expect(res.applied).toEqual(["personal.family"]);
    expect(res.persona.personal?.family).toBeUndefined();
  });
});

describe("mergeContacts (R3, after user approval)", () => {
  const wechatTwin: PersonaV3 = {
    key: "wang-wechat",
    display_name: "王总 (WeChat)",
    handles: { wechat: "wxid_wz8821" },
    communication: { language: "zh", register: "formal", tone_notes: "short voice notes" },
    personal: { interests: ["golf"] },
    provenance: { "communication.tone_notes": "manual", "personal.*": "inferred" },
    evidence: { "personal.*": "wechat history" },
  };
  const primary: PersonaV3 = {
    key: "wang-acme",
    display_name: "王总",
    handles: { gmail: "wang@acme-example.com" },
    communication: { language: "zh", register: "formal", tone_notes: "concise" },
    provenance: {},
  };

  it("unions handles and adopts fields the primary lacks", () => {
    const { merged, adopted } = mergeContacts(primary, wechatTwin);
    expect(merged.handles).toEqual({
      gmail: "wang@acme-example.com",
      wechat: "wxid_wz8821",
    });
    expect(merged.personal?.interests).toEqual(["golf"]);
    expect(adopted).toContain("handles.wechat");
  });

  it("secondary manual beats primary inferred; both-inferred keeps primary + reports", () => {
    const { merged, conflicts } = mergeContacts(primary, wechatTwin);
    // tone_notes conflict: secondary is manual, primary unprotected -> secondary wins
    expect(merged.communication?.tone_notes).toBe("short voice notes");
    expect(merged.provenance?.["communication.tone_notes"]).toBe("manual");
    expect(conflicts.map((c) => c.path)).toContain("communication.tone_notes");
  });

  it("primary manual always survives", () => {
    const protectedPrimary: PersonaV3 = {
      ...primary,
      provenance: { "communication.*": "manual" },
    };
    const { merged, conflicts } = mergeContacts(protectedPrimary, wechatTwin);
    expect(merged.communication?.tone_notes).toBe("concise");
    expect(conflicts.find((c) => c.path === "communication.tone_notes")?.dropped).toBe(
      "short voice notes",
    );
  });
});

describe("validatePersonaV3", () => {
  it("inferred provenance without evidence is an error", () => {
    const errors = validatePersonaV3({
      key: "x",
      display_name: "X",
      provenance: { "behavior.reliability": "inferred" },
    });
    expect(errors.some((e) => e.includes("no evidence"))).toBe(true);
  });
  it("strictCoverage demands provenance for every content leaf (bootstrap output)", () => {
    const errors = validatePersonaV3(
      { key: "x", display_name: "X", behavior: { reliability: "high" } },
      { strictCoverage: true },
    );
    expect(errors).toContain('no provenance entry covers "behavior.reliability"');
  });
  it("a sparse but covered persona passes strict validation", () => {
    const errors = validatePersonaV3(
      {
        key: "x",
        display_name: "X",
        communication: { language: "en", register: "casual" },
        provenance: { "communication.*": "inferred" },
        evidence: { "communication.*": "slack:D1:1.0" },
      },
      { strictCoverage: true },
    );
    expect(errors).toEqual([]);
  });
  it("rejects bad enums", () => {
    const errors = validatePersonaV3({
      key: "x",
      display_name: "X",
      communication: { language: "fr" as never },
      relationship_meta: { power: "boss" as never },
    });
    expect(errors.length).toBe(2);
  });
});

describe("migrateMechanical (spec §3, mechanical part)", () => {
  it("maps v2 fields to v3 paths, all migrated content provenance=manual", () => {
    const scaffold = migrateMechanical({
      key: "michael-dobosz",
      display_name: "Michael Dobosz",
      relationship: "Embedded Systems Team Lead",
      handles: { slack: "UR36HT3HV", gmail: "michael@taiv.tv", wechat: null },
      language: "en",
      register: "casual",
      tone_notes: "brief",
      context: "power-supply sizing",
    });
    expect(scaffold).toEqual({
      key: "michael-dobosz",
      display_name: "Michael Dobosz",
      identity: { relationship: "Embedded Systems Team Lead" },
      handles: { slack: "UR36HT3HV", gmail: "michael@taiv.tv", wechat: null },
      communication: { language: "en", register: "casual", tone_notes: "brief" },
      open_threads: "power-supply sizing",
      provenance: {
        "identity.relationship": "manual",
        "communication.language": "manual",
        "communication.register": "manual",
        "communication.tone_notes": "manual",
        open_threads: "inferred",
      },
      evidence: { open_threads: "migrated from v2 context — verify still current" },
      style_profile_meta: { last_built_at: null },
    });
  });

  it("open_threads migrates as a rolling inferred field, not frozen manual; new comm sub-fields stay writable", () => {
    const s = migrateMechanical({
      key: "x",
      display_name: "X",
      language: "en",
      register: "casual",
      tone_notes: "t",
      context: "ctx",
    });
    // open_threads is inferred (Phase B can refresh it), not manual
    expect(s.provenance!["open_threads"]).toBe("inferred");
    // communication is keyed explicitly, NOT a "communication.*" wildcard, so a
    // later LLM write to communication.response_rhythm is NOT blocked.
    expect(s.provenance!["communication.*"]).toBeUndefined();
    expect(provenanceFor("communication.response_rhythm", s.provenance)).toBe("inferred");
    expect(provenanceFor("communication.tone_notes", s.provenance)).toBe("manual");
  });
  it("omits blocks with no source content (sparse is correct)", () => {
    const scaffold = migrateMechanical({ key: "x", display_name: "X" });
    expect(scaffold.identity).toBeUndefined();
    expect(scaffold.communication).toBeUndefined();
    expect(scaffold.open_threads).toBeUndefined();
    expect(scaffold.provenance).toBeUndefined();
  });
});

describe("leafPaths", () => {
  it("blocks recurse one level, scalars/arrays are leaves, bookkeeping excluded", () => {
    const paths = leafPaths(base);
    expect(paths).toContain("identity.role");
    expect(paths).toContain("handles.slack");
    expect(paths).toContain("open_threads");
    expect(paths).toContain("key");
    expect(paths.some((p) => p.startsWith("provenance"))).toBe(false);
    expect(paths.some((p) => p.startsWith("evidence"))).toBe(false);
  });
});

describe("v3.1 behavior fields (flat under behavior — per-field provenance)", () => {
  it("new behavior leaves are enumerated one-level (so R1 stays per-field)", () => {
    const p: PersonaV3 = {
      ...base,
      behavior: { landmines: ["never CC his manager"], says_no_by: "silence" },
    };
    const paths = leafPaths(p);
    expect(paths).toContain("behavior.landmines");
    expect(paths).toContain("behavior.says_no_by");
  });

  it("strictCoverage accepts the new behavior fields when each carries evidence", () => {
    const p: PersonaV3 = {
      key: "x",
      display_name: "X",
      behavior: { decision_style: "data-first", landmines: ["scope creep"] },
      provenance: { "behavior.decision_style": "inferred", "behavior.landmines": "inferred" },
      evidence: {
        "behavior.decision_style": "msg 123: 'show me the numbers'",
        "behavior.landmines": "msg 456: pushed back hard on added scope",
      },
    };
    expect(validatePersonaV3(p, { strictCoverage: true })).toEqual([]);
  });

  it("an LLM may set the new behavior fields (they are NOT manual by default)", () => {
    const res = applyLlmUpdates(base, {
      set: { "behavior.landmines": ["scope creep"] },
      evidence: { "behavior.landmines": "msg 9: refused added scope" },
    });
    expect(res.applied).toContain("behavior.landmines");
  });
});

describe("v3.1 corrections (§7B — human-only, R1-protected)", () => {
  const withCorrection: PersonaV3 = {
    ...base,
    corrections: [{ scene: "ETA asks", wrong: "assume prompt reply", correct: "he ghosts until chased", at: "2026-06-18T00:00:00Z" }],
  };

  it("the LLM may NEVER write corrections (forbidden root)", () => {
    const res = applyLlmUpdates(base, {
      set: { corrections: [{ scene: "x", wrong: "y", correct: "z" }] },
      evidence: { corrections: "should not matter" },
    });
    expect(res.invalid).toContain("corrections");
    expect(res.applied).not.toContain("corrections");
  });

  it("an LLM update batch lands legit fields while corrections stays untouched", () => {
    const res = applyLlmUpdates(withCorrection, {
      set: {
        corrections: [{ scene: "hacked", wrong: "a", correct: "b" }],
        "relationship_meta.temperature": "warming",
      },
      evidence: { "relationship_meta.temperature": "msg 12: friendlier tone" },
    });
    expect(res.invalid).toContain("corrections");
    expect(res.applied).toContain("relationship_meta.temperature");
    expect(res.persona.corrections).toEqual(withCorrection.corrections);
  });

  it("corrections survive a promote merge (staged build never carries them)", () => {
    const staged: PersonaV3 = { key: base.key, display_name: base.display_name, open_threads: "new thread", provenance: { open_threads: "inferred" }, evidence: { open_threads: "msg 1" } };
    const { merged } = mergeStagedIntoLive(withCorrection, staged);
    expect(merged.corrections).toEqual(withCorrection.corrections);
  });

  it("validatePersonaV3 flags a correction with a missing field", () => {
    const bad: PersonaV3 = { ...base, corrections: [{ scene: "x", wrong: "", correct: "z" }] };
    expect(validatePersonaV3(bad)).toContain("corrections[0].wrong missing");
  });
});

// The derive rule reads assessment.needs_leo, so malformed verdicts silently
// shape the owner's list. Validated only when present — commitments predating
// the ASSESS pass carry none, and that is legal.
describe("commitment assessment validation", () => {
  const withAssessment = (a: unknown) =>
    ({
      schema: "persona-v3",
      key: "k",
      display_name: "K",
      commitments: [{ who: "me", what: "w", status: "open", assessment: a }],
    }) as unknown as PersonaV3;

  it("accepts a well-formed verdict", () => {
    const errs = validatePersonaV3(
      withAssessment({ needs_leo: true, blocked_on: "leo", next_step: "do it", evidence: "q", at: "2026-08-22T00:00:00Z" }),
    );
    expect(errs.filter((e) => e.includes("assessment"))).toEqual([]);
  });

  it("accepts a commitment with no verdict at all", () => {
    const errs = validatePersonaV3({
      schema: "persona-v3",
      key: "k",
      display_name: "K",
      commitments: [{ who: "me", what: "w", status: "open" }],
    } as unknown as PersonaV3);
    expect(errs.filter((e) => e.includes("assessment"))).toEqual([]);
  });

  it("rejects a non-boolean needs_leo", () => {
    const errs = validatePersonaV3(withAssessment({ needs_leo: "yes", evidence: "q", at: "t" }));
    expect(errs.some((e) => e.includes("needs_leo must be boolean"))).toBe(true);
  });

  it("rejects a verdict with no evidence and no date", () => {
    const errs = validatePersonaV3(withAssessment({ needs_leo: true, evidence: "  ", at: "" }));
    expect(errs.some((e) => e.includes("evidence missing"))).toBe(true);
    expect(errs.some((e) => e.includes("at missing"))).toBe(true);
  });

  it("rejects an unknown blocked_on", () => {
    const errs = validatePersonaV3(withAssessment({ needs_leo: false, blocked_on: "someone", evidence: "q", at: "t" }));
    expect(errs.some((e) => e.includes("blocked_on must be"))).toBe(true);
  });
});
