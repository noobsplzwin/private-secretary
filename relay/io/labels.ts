// Label ledger (P0) — the append-only ground truth for measuring accuracy.
//
// WHY THIS EXISTS: loop-state.json is a live working set, not an archive. It
// drops records from TWO paths — the MAX_TERMINAL_ACTIONS prune in state.ts and
// the supersede filter in scan-loop.ts — and the second one drops cards that
// never reached a terminal status at all, so no "export the terminal actions"
// pass can ever recover them. Every dropped record is a label we can never get
// back, and labels are the only thing that can prove accuracy improved.
//
// CONTRACT (enforced by tests):
//   1. APPEND ONLY. No code path may rewrite or delete an existing line. We
//      never read-modify-write the file — one O_APPEND write of one line.
//   2. Every removal path must appendLabel BEFORE removing. If the append
//      fails, the removal is abandoned (over-cap beats a lost label).
//   3. Records are SELF-CONTAINED (source_snapshot carries the whole action),
//      so a label stays readable after the live state has moved on.
//
// Concurrency: the cockpit and the daemon both write here. A single write() of
// a line ending in \n to an O_APPEND fd is atomic for our sizes on macOS/Linux,
// so concurrent writers interleave whole lines, never partial ones.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ActionItem } from "../core/action-item.js";

// Why the human rejected an item. Kept ORTHOGONAL to field_errors: mixing "this
// isn't a real thing" with "the time was wrong" makes it impossible to tell
// whether a card was a false positive or a good card with one bad field.
export type ExistenceVerdict =
  | "confirmed" // the human acted on it
  | "not_a_thing" // not a real obligation at all
  | "not_mine" // real, but not directed at the owner (addressee miss)
  | "duplicate" // same as an item already tracked
  | "already_handled" // resolved before it was surfaced
  | "deferred" // the card is RIGHT, the human just isn't doing it now
  | "other";

// Field-level defects, independent of whether the item should exist.
export type FieldError = "time" | "person" | "place" | "other";

export const EXISTENCE_VERDICTS: ReadonlySet<string> = new Set<ExistenceVerdict>([
  "confirmed",
  "not_a_thing",
  "not_mine",
  "duplicate",
  "already_handled",
  "deferred",
  "other",
]);

// `deferred` means "right card, wrong day" — counting it as a rejection would
// systematically UNDERSTATE precision, and precision is the primary metric. The
// baseline report excludes these from the denominator.
export const NON_PRECISION_VERDICTS: ReadonlySet<string> = new Set<ExistenceVerdict>([
  "deferred",
]);

export type LabelDecision =
  | "executed" // human approved and it ran
  | "rejected" // human skipped it
  | "superseded" // replaced by a fresher card for the same conversation
  | "pruned"; // evicted by the retention cap

export interface EditDiffEntry {
  field: string;
  before: unknown;
  after: unknown;
}

export interface LabelRecord {
  label_id: string;
  action_id: string;
  action_type: string;
  decision: LabelDecision;
  existence: ExistenceVerdict | null; // null for backfilled history
  field_errors?: FieldError[];
  decided_at: string | null; // null for backfilled history
  note?: string;
  edit_diff?: EditDiffEntry[];
  source_snapshot: ActionItem; // self-contained
  exported_at: string;
  git_sha?: string;
}

// labels.jsonl lives beside the state file it was derived from.
export function labelsPathFor(statePath: string): string {
  return join(dirname(statePath), "labels.jsonl");
}

export interface NewLabel {
  action: ActionItem;
  decision: LabelDecision;
  existence?: ExistenceVerdict | null;
  field_errors?: FieldError[];
  decided_at?: string | null;
  note?: string;
  edit_diff?: EditDiffEntry[];
  git_sha?: string;
}

export function buildLabel(input: NewLabel, now: () => string = () => new Date().toISOString()): LabelRecord {
  const rec: LabelRecord = {
    label_id: randomUUID(),
    action_id: input.action.id,
    action_type: input.action.action_type,
    decision: input.decision,
    existence: input.existence ?? null,
    decided_at: input.decided_at ?? null,
    source_snapshot: input.action,
    exported_at: now(),
  };
  if (input.field_errors && input.field_errors.length > 0) rec.field_errors = input.field_errors;
  if (input.note != null && input.note !== "") rec.note = input.note;
  if (input.edit_diff && input.edit_diff.length > 0) rec.edit_diff = input.edit_diff;
  if (input.git_sha) rec.git_sha = input.git_sha;
  return rec;
}

// Append one line per record. Throws on I/O failure so the CALLER can abandon
// whatever removal it was about to do. Never reads the file.
export function appendLabels(labelsPath: string, records: LabelRecord[]): void {
  if (records.length === 0) return;
  mkdirSync(dirname(labelsPath), { recursive: true });
  // One write for the whole batch: fewer interleaving points, and a batch is
  // all-or-nothing from the caller's point of view.
  const payload = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  appendFileSync(labelsPath, payload, { encoding: "utf8" });
}

export function appendLabel(labelsPath: string, record: LabelRecord): void {
  appendLabels(labelsPath, [record]);
}

// Read the ledger back (for the baseline report / migration idempotency).
// Tolerates a truncated final line rather than throwing — an append-only log
// read while being written should degrade, not explode.
export function readLabels(text: string): LabelRecord[] {
  const out: LabelRecord[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    try {
      out.push(JSON.parse(t) as LabelRecord);
    } catch {
      // skip malformed / partially-written line
    }
  }
  return out;
}
