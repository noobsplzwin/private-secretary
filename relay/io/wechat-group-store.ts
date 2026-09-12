// Persistence for the WeChat group book (core/wechat-groups.ts decides what
// goes in it). Beside loop-state.json, same as the TickTick sync map.
//
// It is PERSISTED rather than recomputed because the auto-admit signal — how
// many distinct people spoke recently — is not a stable property of a group.
// Today's three speakers can be tomorrow's twelve, so a gate that re-decided
// every tick would flicker groups in and out of coverage with no record of what
// it missed while they were out. Deciding once and writing it down also gives
// the owner a file he can read and edit.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GroupBook, GroupDecision } from "../core/wechat-groups.js";

export function groupBookPath(statePath: string): string {
  return join(dirname(statePath), "wechat-groups.json");
}

function isDecision(v: unknown): v is GroupDecision {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Partial<GroupDecision>;
  return (
    (d.decision === "allow" || d.decision === "deny") &&
    (d.by === "owner" || d.by === "auto") &&
    typeof d.at === "string"
  );
}

/**
 * Missing or corrupt reads as EMPTY, never throws. An unreadable book must not
 * stop a scan; the cost is that groups get re-classified, which is one extra
 * history call each and no wrong messages.
 */
export function loadGroupBook(statePath: string): GroupBook {
  const file = groupBookPath(statePath);
  if (!existsSync(file)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof raw !== "object" || raw === null) return {};
    const out: GroupBook = {};
    for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!isDecision(v)) continue;
      out[name] = {
        decision: v.decision,
        by: v.by,
        at: v.at,
        ...(typeof v.speakers === "number" ? { speakers: v.speakers } : {}),
        ...(typeof v.lastSeenMs === "number" ? { lastSeenMs: v.lastSeenMs } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveGroupBook(statePath: string, book: GroupBook): void {
  const file = groupBookPath(statePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(book, null, 2)}\n`);
}
