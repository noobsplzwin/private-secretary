// state/owner-tickets.json — the owner's own TickTick tickets as last read
// (core/owner-tickets.ts). Written by the readback after a COMPLETE read; read
// by the drafter and the person pass. A separate file, not a loop-state field:
// the readback and the analysers run in different lanes, and a file one side
// writes and the other only reads cannot be clobbered by a stale snapshot.
//
// Load is total: missing or corrupt → no tickets, which only means nothing is
// covered this tick — the behaviour before this file existed.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OwnerTicket } from "../core/owner-tickets.js";

export function ownerTicketsPathFor(statePath: string): string {
  return join(dirname(statePath), "owner-tickets.json");
}

export function loadOwnerTickets(statePath: string): OwnerTicket[] {
  try {
    const raw = JSON.parse(readFileSync(ownerTicketsPathFor(statePath), "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (t): t is OwnerTicket =>
        !!t && typeof t.id === "string" && typeof t.title === "string" && Array.isArray(t.steps),
    );
  } catch {
    return [];
  }
}

export function saveOwnerTickets(statePath: string, tickets: readonly OwnerTicket[]): void {
  writeFileSync(ownerTicketsPathFor(statePath), JSON.stringify(tickets, null, 2) + "\n");
}
