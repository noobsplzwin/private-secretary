// A calendar INVITE, read from its .ics, and reconciled against the meeting
// cards the engine already holds. Pure core.
//
// WHY: a meeting's time is settled by the invite, not by the chat that led to
// it. 2026-10-01 — João proposed 9AM Lisbon, Leo moved it in a Slack thread
// (「actually, can we call 2pm instead?」), João sent the invite: NXP AGV Sync,
// 21:00–22:00 GMT+8. The engine's card still said 16:00. The invite email did
// reach the drafter, two hours late, and produced nothing, because a card can
// only be superseded by a newer card from the SAME conversation, and this one
// came by Gmail while the card came from Slack.
//
// Matching is by IDENTITY, never by text: the invite's ORGANIZER email must be
// one of the card's attendee emails, exactly. Guessing that two meetings are
// "the same" from their titles is the fuzzy binding this codebase refuses.

import type { ActionItem } from "./action-item.js";
import { zoneOffsetAt } from "./when.js";

export interface ParsedInvite {
  /** REQUEST (new or updated) or CANCEL. */
  method: string;
  uid?: string;
  summary?: string;
  /** Lower-cased organizer email. */
  organizer: string;
  /** ISO instants. */
  start: string;
  end?: string;
}

/** RFC 5545 unfolding: a line that starts with a space continues the previous one. */
function unfold(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
}

/** DTSTART/DTEND value → ISO instant. Handles UTC (Z), TZID=, and all-day dates. */
function toInstant(params: string, value: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, hh = "00", mi = "00", ss = "00", z] = m;
  const wall = `${y}-${mo}-${d}T${hh}:${mi}:${ss}`;
  if (z) return new Date(`${wall}Z`).toISOString();
  const tz = /TZID=([^;:]+)/.exec(params)?.[1];
  // A floating time with no zone has no instant; refusing it is safer than
  // stamping one on.
  if (!tz) return null;
  const off = zoneOffsetAt(wall, tz);
  return off ? new Date(`${wall}${off}`).toISOString() : null;
}

export function parseInvite(ics: string): ParsedInvite | null {
  const lines = unfold(ics);
  const method = lines.find((l) => l.startsWith("METHOD:"))?.slice(7).trim().toUpperCase() ?? "REQUEST";
  const ev: Record<string, { params: string; value: string }> = {};
  let inEvent = false;
  for (const l of lines) {
    if (l === "BEGIN:VEVENT") inEvent = true;
    else if (l === "END:VEVENT") break; // the first VEVENT is the invite
    else if (inEvent) {
      const i = l.indexOf(":");
      if (i < 0) continue;
      const [name, ...rest] = l.slice(0, i).split(";");
      if (name && !(name in ev)) ev[name] = { params: rest.join(";"), value: l.slice(i + 1) };
    }
  }
  const organizer = /mailto:([^\s;]+)/i.exec(ev.ORGANIZER?.value ?? "")?.[1]?.toLowerCase();
  const start = ev.DTSTART ? toInstant(ev.DTSTART.params, ev.DTSTART.value) : null;
  if (!organizer || !start) return null;
  const end = ev.DTEND ? toInstant(ev.DTEND.params, ev.DTEND.value) : null;
  return {
    method,
    organizer,
    start,
    ...(end ? { end } : {}),
    ...(ev.UID?.value ? { uid: ev.UID.value.trim() } : {}),
    ...(ev.SUMMARY?.value ? { summary: ev.SUMMARY.value.trim().replace(/\\,/g, ",") } : {}),
  };
}

/** How far apart a card and an invite may be and still be the same meeting. */
export const INVITE_MATCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const emailsOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.includes("@")).map((x) => x.toLowerCase()) : [];

/**
 * The ONE open meeting card this invite settles, or null.
 *
 * Exactly one: the organizer is among the card's attendee emails, the card is
 * still open, and its time is within a week of the invite's. Two candidates
 * means there is no basis for choosing — nothing is touched.
 */
export function cardForInvite(actions: readonly ActionItem[], invite: ParsedInvite): ActionItem | null {
  if (invite.method === "CANCEL") return null;
  const at = Date.parse(invite.start);
  const hits = actions.filter((a) => {
    if (a.action_type !== "calendar") return false;
    if (a.status !== "suggested" && a.status !== "approved") return false;
    const p = a.params ?? {};
    const people = [...emailsOf(p.attendees), ...emailsOf(p.attendees_unresolved)];
    if (!people.includes(invite.organizer) && p.invite_received_from !== invite.organizer) return false;
    const t = Date.parse(typeof p.start === "string" ? p.start : "");
    return !Number.isNaN(t) && Math.abs(t - at) <= INVITE_MATCH_WINDOW_MS;
  });
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * The card, settled by the invite: its time is the invite's, and it no longer
 * offers to send an invite of its own — the other side already did, so ticking
 * it would send a duplicate at the old time.
 */
export function applyInvite(card: ActionItem, invite: ParsedInvite): ActionItem {
  const p = card.params ?? {};
  const was = typeof p.start === "string" ? p.start : "";
  return {
    ...card,
    params: {
      ...p,
      start: invite.start,
      ...(invite.end ? { end: invite.end } : {}),
      attendees: [],
      invite_received_from: invite.organizer,
      ...(invite.uid ? { invite_uid: invite.uid } : {}),
      time_confirmed: true,
      time_quote: `invite from ${invite.organizer}${invite.summary ? `: ${invite.summary}` : ""}`,
      ...(was && was !== invite.start ? { rescheduled_from: was } : {}),
    },
  };
}
