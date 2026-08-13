// Name → calendar attendee address. Pure core: no I/O.
//
// The owner asks for internal colleagues to be ON the invite ("加 Michael 和
// zech 到参加人", "要求 Michael@TAIV.TV"), but the drafter only ever produces the
// NAME it read in the thread, and buildCalendarEvent drops any attendee that is
// not already an email — so those people were silently left off every event.
//
// WHY NOT recipient-resolver's index: that one is a Map<string, personaKey>, so
// a second "michael" would OVERWRITE the first and resolve to whichever loaded
// last. Silently picking one of two people is the wrong-recipient failure, and
// that index is also the reply/relay path, which must not be destabilised. This
// index keeps a SET per name, so a collision is representable — and therefore
// refusable.
//
// First names are matched on purpose (that is how the owner writes), which is
// exactly why collision handling has to come first rather than after.

import type { Persona } from "./types.js";

export interface AttendeeResolution {
  /** Addresses to put on the invite, deduped, in first-seen order. */
  emails: string[];
  /** Names left off: no persona, several personas, or no address on file. */
  unresolved: string[];
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function isEmail(s: string): boolean {
  return s.includes("@");
}

/** name → the personas it could mean. A set, so ambiguity survives. */
export function buildAttendeeIndex(personas: readonly Persona[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const add = (alias: string, key: string) => {
    const k = norm(alias);
    if (!k) return;
    const set = index.get(k) ?? new Set<string>();
    set.add(key);
    index.set(k, set);
  };
  for (const p of personas) {
    add(p.key, p.key);
    add(p.displayName, p.key);
    for (const handle of Object.values(p.handles)) if (handle) add(handle, p.key);
    // The FIRST token of the display name — "Michael Dobosz" also answers to
    // "Michael". Two Michaels then map to one alias holding two keys, which
    // resolves to ambiguous rather than to whoever loaded last.
    const first = p.displayName.trim().split(/\s+/)[0];
    if (first && norm(first) !== norm(p.displayName)) add(first, p.key);
  }
  return index;
}

/**
 * Resolve the attendee list a card carries into real addresses.
 *
 * Entries that are ALREADY addresses pass through untouched — the thread stated
 * them, which beats any lookup. A name resolves only when it means exactly ONE
 * persona that has an email on file; anything else lands in `unresolved` and is
 * reported rather than guessed at, because an invite reaches a real inbox.
 */
export function resolveAttendees(
  attendees: readonly string[],
  personas: readonly Persona[],
): AttendeeResolution {
  const index = buildAttendeeIndex(personas);
  const byKey = new Map(personas.map((p) => [p.key, p]));
  const emails: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();

  for (const raw of attendees) {
    const value = raw.trim();
    if (!value) continue;
    if (isEmail(value)) {
      if (!seen.has(norm(value))) {
        seen.add(norm(value));
        emails.push(value);
      }
      continue;
    }
    const keys = index.get(norm(value));
    // no match, or more than one person answers to this name
    if (!keys || keys.size !== 1) {
      unresolved.push(value);
      continue;
    }
    const persona = byKey.get([...keys][0]!);
    const email = persona?.handles.gmail;
    // Resolved to a person we cannot invite — a WeChat-only contact has no
    // address. Report it; the people/place still go in the title/description.
    if (!email || !isEmail(email)) {
      unresolved.push(value);
      continue;
    }
    if (!seen.has(norm(email))) {
      seen.add(norm(email));
      emails.push(email);
    }
  }
  return { emails, unresolved };
}
