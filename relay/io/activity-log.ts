// Activity log — one human-readable JSONL line per thing the engine DID.
//
// WHY THIS EXISTS: loop-state.json shows where the queue IS, not how it got
// there, and the shadow-log only covers the pre-LLM scan. When a card
// vanishes (superseded), completes itself (auto-execute), or a tick drafts
// nothing, answering "what happened?" used to mean guessing. This log is the
// operational trail: scan ticks, supersedes, auto-executes, cockpit decisions,
// and errors, oldest→newest, greppable.
//
// Same append-only pattern + concurrency assumptions as labels.ts /
// llm-raw-log.ts: single O_APPEND write per record, POSIX atomicity under
// PIPE_BUF (summary is capped well below that), daemon + cockpit both append.
//
// Not an accuracy ledger (that's labels.jsonl) and not message content
// (that's shadow-log.jsonl) — this is ENGINE BEHAVIOUR. Never blocks the
// operation it describes: callers wrap appends in try/catch.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type ActivityKind =
  // daemon, one per scan tick that did anything (fully-idle ticks are
  // skipped — a 10s WeChat poll would otherwise drown the signal)
  | "tick"
  // a fresher card replaced still-suggested card(s) for the same cluster
  | "supersede"
  // a high-confidence card executed without a human click
  | "auto-execute"
  // cockpit decisions
  | "approve"
  | "skip"
  | "edit"
  | "restore"
  | "mark-done"
  // the owner annotated a card WITHOUT deciding it (see core/addComment)
  | "comment"
  // AI re-timed a calendar card's proposed start/end
  | "re-time"
  // anything that failed: a dropped commit, an executor throw
  | "error";

export interface ActivityRecord {
  at: string; // ISO timestamp of the event
  kind: ActivityKind;
  summary: string; // human-readable one-liner — the show-activity viewer prints this verbatim
  data?: Record<string, unknown>; // structured detail (counts, ids) for tooling
}

// Summaries stay single-line and bounded so the file greps cleanly and an
// append stays well under PIPE_BUF.
export const SUMMARY_MAX_CHARS = 300;

// activity-log.jsonl lives beside the state file it narrates.
export function activityPathFor(statePath: string): string {
  return join(dirname(statePath), "activity-log.jsonl");
}

// All valid kinds — the cockpit server validates the ?kind= filter against
// this so a stray query value can't silently filter to nothing.
export const ACTIVITY_KINDS: ReadonlySet<string> = new Set<ActivityKind>([
  "tick",
  "supersede",
  "auto-execute",
  "approve",
  "skip",
  "edit",
  "restore",
  "mark-done",
  "comment",
  "re-time",
  "error",
]);

// Append one record. Throws on I/O failure — the CALLER decides whether that
// matters (daemon/cockpit wrap it so logging never breaks the operation).
export function appendActivity(filePath: string, rec: ActivityRecord): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const summary =
    rec.summary.length > SUMMARY_MAX_CHARS
      ? rec.summary.slice(0, SUMMARY_MAX_CHARS)
      : rec.summary;
  appendFileSync(filePath, JSON.stringify({ ...rec, summary }) + "\n", {
    encoding: "utf8",
  });
}

// Read the log back (viewer / tests). Tolerates a truncated final line — an
// append-only log read while being written should degrade, not explode.
export function readActivity(text: string): ActivityRecord[] {
  const out: ActivityRecord[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    try {
      out.push(JSON.parse(t) as ActivityRecord);
    } catch {
      // skip malformed / partially-written line
    }
  }
  return out;
}
