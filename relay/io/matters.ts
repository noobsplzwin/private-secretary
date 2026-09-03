// The owner's matter registry (config/matters.yaml). Owner-only: the system
// nominates a commitment's matter, it never adds, renames or closes one.
//
// Read here, applied in core/ledger-list.ts as the PROMOTION gate — a
// commitment that belongs to no live matter is not a to-do the owner chose,
// so it sinks instead of taking a slot. It is never deleted (owner's rule:
// 系统删待办这个概念不存在).

import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface Matter {
  id: string;
  label: string;
  status?: "active" | "closed";
}

/** Every matter in the register, closed ones included. Throws on a broken file. */
export function readMatters(path: string): Matter[] {
  const doc = parse(readFileSync(path, "utf8")) as { matters?: unknown };
  if (!Array.isArray(doc?.matters)) throw new Error(`${path}: no \`matters\` list`);
  return doc.matters.map((raw, i) => {
    const m = raw as Partial<Matter>;
    if (typeof m.id !== "string" || !m.id.trim()) throw new Error(`${path}: matter #${i} has no id`);
    if (typeof m.label !== "string" || !m.label.trim()) throw new Error(`${path}: ${m.id} has no label`);
    if (m.status !== undefined && m.status !== "active" && m.status !== "closed") {
      throw new Error(`${path}: ${m.id} has status "${m.status}" (want active|closed)`);
    }
    return { id: m.id, label: m.label, ...(m.status ? { status: m.status } : {}) };
  });
}

/** The ids that can still justify a slot on the list. */
export function activeMatterIds(matters: readonly Matter[]): Set<string> {
  return new Set(matters.filter((m) => m.status !== "closed").map((m) => m.id));
}
