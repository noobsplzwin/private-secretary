// Persistence for the 1:1 WeChat cursor book (core/wechat-direct-cursor.ts
// decides what goes in it). Beside loop-state.json, same as the group book.
//
// A separate file from wechat-groups.json on purpose: a group entry carries an
// admit/deny DECISION that the owner may edit by hand, while a direct entry is
// nothing but a position. Mixing them would put a hand-editable policy file and
// a machine cursor in the same document.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DirectBook } from "../core/wechat-direct-cursor.js";

export function directBookPath(statePath: string): string {
  return join(dirname(statePath), "wechat-direct.json");
}

/**
 * Missing or corrupt reads as EMPTY, never throws. The cost of an unreadable
 * book is bounded by the seed rule: every chat looks new, so every cursor is
 * re-seeded at now and one round of messages is skipped — never a backlog dump.
 */
export function loadDirectBook(statePath: string): DirectBook {
  const file = directBookPath(statePath);
  if (!existsSync(file)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof raw !== "object" || raw === null) return {};
    const out: DirectBook = {};
    for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
      const ms = (v as { lastSeenMs?: unknown })?.lastSeenMs;
      if (typeof ms === "number" && Number.isFinite(ms)) out[name] = { lastSeenMs: ms };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveDirectBook(statePath: string, book: DirectBook): void {
  const file = directBookPath(statePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(book, null, 2)}\n`);
}
