// Persona Layer v3 (specs/persona-v3.md): hierarchical persona schema with
// field-level provenance (manual | inferred) and an evidence ledger for every
// inferred field. Pure logic — no I/O.
//
// R1 lives HERE and nowhere else: applyLlmUpdates() decides whether an
// LLM-originated write goes through. relay/io/persona-store.ts routes every
// actor="llm" write through it; callers never re-implement the guard.

export type ProvenanceTag = "manual" | "inferred";
export type Power = "serves-them" | "peer" | "leads-them";
export type CommitmentWho = "me" | "them";
// "dropped": overtaken by events, superseded, or abandoned — closed WITHOUT the
// work having been done. The vocabulary had no exit for these, so the ledger
// only ever grew: an audit of 89 open who=me commitments found reviews of
// documents that had since shipped and prep for meetings that had happened.
// done ≠ dropped matters downstream — a derived to-do list may resurface a
// dropped item if its thread wakes up, but never a done one.
export type CommitmentStatus = "open" | "done" | "overdue" | "dropped";

export const POWERS: Power[] = ["serves-them", "peer", "leads-them"];
export const BLOCKED_ONS = ["leo", "them", "third-party"] as const;
const COMMITMENT_WHOS: CommitmentWho[] = ["me", "them"];
export const COMMITMENT_STATUSES: CommitmentStatus[] = ["open", "done", "overdue", "dropped"];

// The ASSESS verdict (specs/person-first-consolidation.md §3.2), written by the
// person pass each time that contact's corpus moves. It rides ON the commitment
// so the derived list can read it without a second lookup.
//
// `needs_leo` is the one hard judgment in the whole design — the owner named it
// himself. Everything else here exists to make it auditable: `evidence` must
// quote the corpus verbatim or the verdict is discarded by code, and `at` dates
// the judgment so a stale one cannot keep an item alive forever. A commitment
// assessed a fortnight ago says nothing about today, and "finished work that
// will not leave the list" is the complaint this whole axis change came from.
//
// No `state: advanced|blocked|done|unchanged` field: nothing consumes it. `done`
// is the existing status transition, `blocked` is `blocked_on !== undefined`,
// and advanced-vs-unchanged drives no behaviour.
export interface CommitmentAssessment {
  /** Does this need LEO's own time now? The derive rule turns only these into items. */
  needs_leo: boolean;
  /** Who the work sits with. `them`/`third-party` means no item, however much the thread looks like it wants chasing. */
  blocked_on?: "leo" | "them" | "third-party";
  /** One imperative line. Only meaningful when needs_leo. */
  next_step?: string;
  /** Verbatim quote from the corpus. Ungrounded verdicts never reach the ledger. */
  evidence: string;
  /** ISO instant this verdict was made, so staleness is visible. */
  at: string;
}

export interface Commitment {
  who: CommitmentWho;
  what: string;
  due?: string;
  status: CommitmentStatus;
  source_message_id?: string;
  assessment?: CommitmentAssessment;
}

// v3.1 (specs/persona-v3.md §7): a human-stated behavioral correction. Always
// provenance=manual; the LLM may never write these (it would defeat the point).
// Consulted at draft time so a corrected mistake isn't repeated.
export interface Correction {
  scene: string; // the situation, e.g. "when Leo asks him for an ETA"
  wrong: string; // what a draft / intent-read got wrong
  correct: string; // what is actually true of this person
  at?: string; // when the correction was recorded (ISO)
}

export interface PersonaV3 {
  key: string;
  display_name: string;
  // Alternate names the same human goes by (middle name, nickname). Used so a
  // name other than display_name still points at this one persona. Survives
  // rebuilds via FIELD_ORDER + manual provenance (R1).
  aliases?: string[];
  identity?: { role?: string; org?: string; relationship?: string };
  relationship_meta?: {
    power?: Power;
    decision_authority?: boolean;
    origin?: string;
    temperature?: string; // inferred, revised on fact change (Phase B)
  };
  handles?: Record<string, string | null>;
  communication?: {
    language?: "en" | "zh";
    register?: "formal" | "casual";
    tone_notes?: string;
    timezone?: string;
    active_hours?: string;
    response_rhythm?: string;
    channel_preference?: Record<string, string>;
    urgency_calibration?: string;
  };
  // v3.1 §7E — durable work context, the primary RAG layer for Action Item
  // generation: what he can do, what he owns, and the project interaction points
  // with Leo. Distinct from open_threads (which is only what's open RIGHT NOW).
  // Flat arrays so leafPaths/provenance/merge stay per-field. Inferred-only,
  // evidence-required, omit-if-empty.
  // resources_represented (v3.1.1): the RESOURCE this person is a gateway to —
  // distinct from a skill. Capital (范总→华登 fund), manufacturing capacity
  // (Leo.Yang), vendor-ecosystem access (朱桦→Renesas), a government grant
  // channel, a customer, talent. Leo routes by "who unlocks resource X" as much
  // as by skill, so this is a first-class match key alongside skills.
  work?: { skills?: string[]; owns?: string[]; projects?: string[]; resources_represented?: string[] };
  open_threads?: string; // ONLY currently-open items (R2 interim guardrail)
  commitments?: Commitment[];
  // v3.1 behavior block (specs/persona-v3.md §7). All fields flat (one level
  // under `behavior`) so leafPaths/provenance/merge stay per-field — nesting
  // deeper would collapse R1 to whole-block granularity. All inferred-only,
  // evidence-required, omit-if-empty. The new fields exist so the bootstrap's
  // behavioral findings land in real slots instead of being folded into prose.
  behavior?: {
    reliability?: string;
    bad_news_style?: string;
    pet_peeves?: string[];
    decision_style?: string; // priorities / what moves them / how they disagree / handle pushback
    interpersonal?: string; // toward superiors / reports / peers + under pressure
    landmines?: string[]; // hard lines + topics to avoid (drafting-critical)
    says_no_by?: string; // flat refusal | excuse | silence | forward to someone
    work_style_tags?: string[]; // reference-tags.md vocabulary, ≤3, each evidenced
    culture_tags?: string[]; // 字节范 / 阿里味 / ..., ≤2, each evidenced
  };
  corrections?: Correction[]; // v3.1 §7B — human-only, R1-manual, consulted at draft time
  personal?: { family?: string; interests?: string[]; notes?: string };
  graph?: { reports_to?: string; related_contacts?: string[] };
  provenance?: Record<string, ProvenanceTag>; // field path (wildcards like "identity.*" allowed)
  evidence?: Record<string, string>; // required for every inferred path
  style_profile_meta?: { last_built_at?: string | null };
}

// Canonical top-level emission order (spec §1). Empty blocks are omitted —
// sparse personas are the correct shape, never null placeholders.
export const FIELD_ORDER: ReadonlyArray<keyof PersonaV3> = [
  "key",
  "display_name",
  "aliases",
  "identity",
  "relationship_meta",
  "handles",
  "communication",
  "work",
  "open_threads",
  "commitments",
  "behavior",
  "corrections",
  "personal",
  "graph",
  "provenance",
  "evidence",
  "style_profile_meta",
];

// Paths an LLM update may never set directly: the primary key, the bookkeeping
// maps (written BY the guard, not through it), and corrections (human-stated
// feedback — letting the LLM write them would defeat their purpose; §7B).
const LLM_FORBIDDEN_ROOTS = new Set(["key", "provenance", "evidence", "corrections"]);

export function isV3(raw: Record<string, unknown>): boolean {
  return (
    typeof raw.identity === "object" ||
    typeof raw.communication === "object" ||
    typeof raw.provenance === "object"
  );
}

// Resolve a field path against a provenance/evidence map: exact entry wins,
// else the longest matching wildcard ("identity.*" covers "identity.role").
// No entry -> "inferred" (manual protection must be explicit).
function lookup<T>(path: string, map: Record<string, T> | undefined): T | undefined {
  if (!map) return undefined;
  if (map[path] !== undefined) return map[path];
  const segs = path.split(".");
  for (let i = segs.length - 1; i >= 1; i--) {
    const wildcard = segs.slice(0, i).join(".") + ".*";
    if (map[wildcard] !== undefined) return map[wildcard];
  }
  return undefined;
}

export function provenanceFor(
  path: string,
  prov: Record<string, ProvenanceTag> | undefined,
): ProvenanceTag {
  return lookup(path, prov) ?? "inferred";
}

export function evidenceFor(
  path: string,
  evidence: Record<string, string> | undefined,
): string | undefined {
  return lookup(path, evidence);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepGet(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function deepSet(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split(".");
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    if (!isPlainObject(cur[seg])) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]!] = value;
}

function deepDelete(obj: Record<string, unknown>, path: string): void {
  const segs = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const next = cur[segs[i]!];
    if (!isPlainObject(next)) return;
    cur = next;
  }
  delete cur[segs[segs.length - 1]!];
}

// Leaf paths of a persona for merge purposes: top-level scalars/arrays are
// leaves; top-level blocks recurse exactly one level (so "identity.role",
// "handles.slack", and map-valued fields like
// "communication.channel_preference" are leaves). provenance/evidence are
// bookkeeping, not content — excluded.
export function leafPaths(p: PersonaV3): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (k === "provenance" || k === "evidence" || v === undefined) continue;
    if (isPlainObject(v)) {
      for (const inner of Object.keys(v)) out.push(`${k}.${inner}`);
    } else {
      out.push(k);
    }
  }
  return out;
}

export interface LlmUpdate {
  set: Record<string, unknown>; // field path -> new value (null = remove)
  evidence?: Record<string, string>; // field path -> evidence (required per path)
}

export interface LlmUpdateResult {
  persona: PersonaV3;
  applied: string[];
  blockedByR1: string[]; // manual provenance — never overwritten
  missingEvidence: string[]; // inferred update without traceability — rejected
  invalid: string[]; // key/provenance/evidence or unknown root — rejected
}

// THE R1 guard. Applies what it may, reports the rest — a batch with one
// blocked field still lands its legitimate updates.
export function applyLlmUpdates(current: PersonaV3, update: LlmUpdate): LlmUpdateResult {
  const persona = structuredClone(current);
  const applied: string[] = [];
  const blockedByR1: string[] = [];
  const missingEvidence: string[] = [];
  const invalid: string[] = [];

  for (const [path, value] of Object.entries(update.set)) {
    const root = path.split(".")[0]!;
    if (LLM_FORBIDDEN_ROOTS.has(root) || !FIELD_ORDER.includes(root as keyof PersonaV3)) {
      invalid.push(path);
      continue;
    }
    if (provenanceFor(path, current.provenance) === "manual") {
      blockedByR1.push(path);
      continue;
    }
    const ev = update.evidence?.[path];
    if (typeof ev !== "string" || ev.trim() === "") {
      missingEvidence.push(path);
      continue;
    }
    if (value === null || value === undefined) {
      deepDelete(persona as unknown as Record<string, unknown>, path);
    } else {
      deepSet(persona as unknown as Record<string, unknown>, path, value);
    }
    persona.provenance = { ...persona.provenance, [path]: "inferred" };
    persona.evidence = { ...persona.evidence, [path]: ev };
    applied.push(path);
  }
  return { persona, applied, blockedByR1, missingEvidence, invalid };
}

export interface StagedMergeResult {
  merged: PersonaV3;
  appliedPaths: string[];
  keptManual: string[]; // live manual fields the staged version may not touch
}

// Promote-time merge: staged (LLM-built) values land everywhere EXCEPT paths
// the live persona marks manual — those always win (R1).
export function mergeStagedIntoLive(live: PersonaV3, staged: PersonaV3): StagedMergeResult {
  const merged = structuredClone(live);
  const appliedPaths: string[] = [];
  const keptManual: string[] = [];

  for (const path of leafPaths(staged)) {
    if (path === "key") continue;
    const value = deepGet(staged, path);
    if (value === null || value === undefined) continue;
    if (provenanceFor(path, live.provenance) === "manual") {
      keptManual.push(path);
      continue;
    }
    deepSet(merged as unknown as Record<string, unknown>, path, value);
    const tag = provenanceFor(path, staged.provenance);
    merged.provenance = { ...merged.provenance, [path]: tag };
    const ev = evidenceFor(path, staged.evidence);
    if (tag === "inferred" && ev) merged.evidence = { ...merged.evidence, [path]: ev };
    appliedPaths.push(path);
  }
  return { merged, appliedPaths, keptManual };
}

export interface ContactMergeConflict {
  path: string;
  kept: unknown;
  dropped: unknown;
}

export interface ContactMergeResult {
  merged: PersonaV3;
  adopted: string[]; // paths taken from the secondary persona
  conflicts: ContactMergeConflict[]; // differing values — kept side recorded
}

// R3 merge (two personas believed to be the same person), primary wins ties:
// union of handles/fields; on conflict manual beats inferred, both-inferred
// keeps the primary and reports the conflict for the user to eyeball.
export function mergeContacts(primary: PersonaV3, secondary: PersonaV3): ContactMergeResult {
  const merged = structuredClone(primary);
  const adopted: string[] = [];
  const conflicts: ContactMergeConflict[] = [];

  for (const path of leafPaths(secondary)) {
    if (path === "key" || path === "display_name") continue;
    const sv = deepGet(secondary, path);
    if (sv === null || sv === undefined) continue;
    const pv = deepGet(primary, path);
    const sTag = provenanceFor(path, secondary.provenance);
    const sEv = evidenceFor(path, secondary.evidence);

    if (pv === undefined || pv === null) {
      deepSet(merged as unknown as Record<string, unknown>, path, sv);
      merged.provenance = { ...merged.provenance, [path]: sTag };
      if (sTag === "inferred" && sEv) merged.evidence = { ...merged.evidence, [path]: sEv };
      adopted.push(path);
      continue;
    }
    if (JSON.stringify(pv) === JSON.stringify(sv)) continue;

    const pTag = provenanceFor(path, primary.provenance);
    if (pTag !== "manual" && sTag === "manual") {
      // secondary's hand-written value beats primary's inference
      deepSet(merged as unknown as Record<string, unknown>, path, sv);
      merged.provenance = { ...merged.provenance, [path]: "manual" };
      adopted.push(path);
      conflicts.push({ path, kept: sv, dropped: pv });
    } else {
      conflicts.push({ path, kept: pv, dropped: sv });
    }
  }
  return { merged, adopted, conflicts };
}

// Structural validation. strictCoverage (bootstrap full writes by the LLM):
// every content leaf must resolve to a provenance entry, and every inferred
// provenance entry must have matching evidence — "no evidence, no field".
export function validatePersonaV3(
  p: PersonaV3,
  opts: { strictCoverage?: boolean } = {},
): string[] {
  const errors: string[] = [];
  if (typeof p.key !== "string" || p.key.trim() === "") errors.push("missing key");
  if (typeof p.display_name !== "string" || p.display_name.trim() === "")
    errors.push("missing display_name");

  const lang = p.communication?.language;
  if (lang !== undefined && lang !== "en" && lang !== "zh")
    errors.push(`communication.language must be en|zh, got "${lang}"`);
  const reg = p.communication?.register;
  if (reg !== undefined && reg !== "formal" && reg !== "casual")
    errors.push(`communication.register must be formal|casual, got "${reg}"`);
  const power = p.relationship_meta?.power;
  if (power !== undefined && !POWERS.includes(power))
    errors.push(`relationship_meta.power must be ${POWERS.join("|")}, got "${power}"`);

  (p.commitments ?? []).forEach((c, i) => {
    if (!COMMITMENT_WHOS.includes(c.who)) errors.push(`commitments[${i}].who invalid`);
    if (typeof c.what !== "string" || c.what.trim() === "")
      errors.push(`commitments[${i}].what missing`);
    if (!COMMITMENT_STATUSES.includes(c.status))
      errors.push(`commitments[${i}].status invalid`);
    // Validated only when present. A malformed verdict is worse than none: the
    // derive rule reads needs_leo, so garbage there silently shapes the list.
    const a = c.assessment;
    if (a !== undefined) {
      if (typeof a.needs_leo !== "boolean")
        errors.push(`commitments[${i}].assessment.needs_leo must be boolean`);
      if (typeof a.evidence !== "string" || a.evidence.trim() === "")
        errors.push(`commitments[${i}].assessment.evidence missing`);
      if (typeof a.at !== "string" || a.at.trim() === "")
        errors.push(`commitments[${i}].assessment.at missing`);
      if (a.blocked_on !== undefined && !BLOCKED_ONS.includes(a.blocked_on))
        errors.push(`commitments[${i}].assessment.blocked_on must be ${BLOCKED_ONS.join("|")}`);
    }
  });

  (p.corrections ?? []).forEach((c, i) => {
    for (const f of ["scene", "wrong", "correct"] as const) {
      if (typeof c[f] !== "string" || c[f].trim() === "")
        errors.push(`corrections[${i}].${f} missing`);
    }
  });

  for (const [path, tag] of Object.entries(p.provenance ?? {})) {
    if (tag !== "manual" && tag !== "inferred")
      errors.push(`provenance["${path}"] must be manual|inferred`);
    if (tag === "inferred" && !evidenceFor(path.replace(/\.\*$/, ".x"), p.evidence) && !p.evidence?.[path])
      errors.push(`provenance["${path}"] is inferred but has no evidence entry`);
  }

  if (opts.strictCoverage) {
    for (const path of leafPaths(p)) {
      if (path === "key" || path === "display_name" || path.startsWith("style_profile_meta"))
        continue;
      if (lookup(path, p.provenance) === undefined)
        errors.push(`no provenance entry covers "${path}"`);
      else if (
        provenanceFor(path, p.provenance) === "inferred" &&
        evidenceFor(path, p.evidence) === undefined
      )
        errors.push(`inferred "${path}" has no evidence`);
    }
  }
  return errors;
}

// Mechanical part of the v2 -> v3 migration (spec §3): old fields to new paths.
// Hand-written v2 content is marked provenance=manual at the EXACT key (not a
// "block.*" wildcard) so new inferred sub-fields the bootstrap later adds
// (communication.response_rhythm, active_hours, ...) are not frozen by a broad
// wildcard. open_threads is the exception: it is a ROLLING field (Phase B keeps
// it current), so it migrates as `inferred` with migrated-evidence, not manual —
// otherwise the v2 snapshot freezes forever. Judgment-derived additions
// (role/org split, relationship_meta, behavior) are layered on by the operator.
export function migrateMechanical(old: Record<string, unknown>): PersonaV3 {
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() !== "" ? v : undefined;

  const provenance: Record<string, ProvenanceTag> = {};
  const evidence: Record<string, string> = {};
  const out: PersonaV3 = {
    key: str(old.key) ?? "",
    display_name: str(old.display_name) ?? "",
  };

  const relationship = str(old.relationship);
  if (relationship) {
    out.identity = { relationship };
    provenance["identity.relationship"] = "manual";
  }
  if (isPlainObject(old.handles)) {
    out.handles = { ...(old.handles as Record<string, string | null>) };
  }
  const communication: NonNullable<PersonaV3["communication"]> = {};
  const language = str(old.language);
  if (language === "en" || language === "zh") {
    communication.language = language;
    provenance["communication.language"] = "manual";
  }
  const register = str(old.register);
  if (register === "formal" || register === "casual") {
    communication.register = register;
    provenance["communication.register"] = "manual";
  }
  const toneNotes = str(old.tone_notes);
  if (toneNotes) {
    communication.tone_notes = toneNotes;
    provenance["communication.tone_notes"] = "manual";
  }
  if (Object.keys(communication).length > 0) out.communication = communication;

  const context = str(old.context);
  if (context) {
    out.open_threads = context;
    provenance["open_threads"] = "inferred";
    evidence["open_threads"] = "migrated from v2 context — verify still current";
  }
  if (Object.keys(provenance).length > 0) out.provenance = provenance;
  if (Object.keys(evidence).length > 0) out.evidence = evidence;

  const sp = old.style_profile as Record<string, unknown> | undefined;
  out.style_profile_meta = {
    last_built_at: isPlainObject(sp) ? (str(sp.generated_at) ?? null) : null,
  };
  return out;
}
