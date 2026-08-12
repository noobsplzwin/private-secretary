// Turning "Thursday 3pm Portugal time" into an instant.
//
// The model was asked to do this arithmetic and got it wrong four different
// ways for one meeting — the same 3pm produced 13:00, 14:00, 15:00 and 07:00
// UTC across consecutive refreshes. Approving the wrong one books a real
// calendar event at the wrong hour, which is the failure this product can
// least afford.
//
// So the model no longer converts. It reports the WALL TIME it read and the
// ZONE that wall time belongs to, and this does the conversion — with the
// zone's actual offset on that date, so a summer meeting is not shifted an
// hour by a winter offset.

/** Offset of an IANA zone at a given instant, in minutes east of UTC. */
function zoneOffsetMinutes(zone: string, atUtcMs: number): number {
  // Intl is the only DST-correct table available without a dependency: format
  // the instant in the zone, read it back as if it were UTC, and the delta is
  // the offset in force on that date.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const { type, value } of dtf.formatToParts(new Date(atUtcMs))) p[type] = value;
  // "24" appears at midnight in some locales/engines.
  const hour = p.hour === "24" ? "00" : p.hour;
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(hour),
    Number(p.minute),
    Number(p.second),
  );
  return Math.round((asUtc - atUtcMs) / 60000);
}

/**
 * The offset ("+HH:MM" / "-HH:MM") in force in `zone` at the WALL TIME `wall`.
 *
 * At the wall time, not "now": Winnipeg is -05:00 in August and -06:00 in
 * December, so an event booked in one season while the clock reads the other
 * would be stamped an hour off. Returns null for an unreadable wall time or an
 * unknown zone rather than guessing an offset.
 */
export function zoneOffsetAt(wall: string, zone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(wall.trim());
  if (!m) return null;
  if (!isValidTimeZone(zone)) return null;
  const [, y, mo, d, h, mi, sec] = m;
  const naive = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +(sec ?? 0));
  // Same two-pass settle as resolveWallTime: the offset depends on the instant,
  // and the instant depends on the offset.
  const guess = naive - zoneOffsetMinutes(zone, naive) * 60000;
  const minutes = zoneOffsetMinutes(zone, guess);
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a wall-clock string in a named zone to an ISO UTC instant.
 *
 * `wall` is "YYYY-MM-DDTHH:mm" (no offset). If it already carries an offset or
 * a Z, it is already an instant and is returned normalized — the model
 * sometimes answers that way and there is nothing to convert.
 *
 * Returns null when the input cannot be read, rather than guessing: a card
 * with no time blocks approval, which is recoverable. A card with a WRONG time
 * gets approved and books the wrong hour.
 */
export function resolveWallTime(wall: string, zone: string): string | null {
  const s = wall.trim();
  if (!s) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return null;
  if (!isValidTimeZone(zone)) return null;
  const [, y, mo, d, h, mi, sec] = m;
  const naive = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +(sec ?? 0));
  // Two passes: the offset depends on the instant, and the instant depends on
  // the offset. One correction settles everything except the hour inside a DST
  // transition, which no representation can disambiguate anyway.
  const guess = naive - zoneOffsetMinutes(zone, naive) * 60000;
  const exact = naive - zoneOffsetMinutes(zone, guess) * 60000;
  return new Date(exact).toISOString();
}
// The clock line the model reasons against, rendered in the OWNER's zone.
//
// This used to use the machine's offset via getTimezoneOffset(). Same thing
// while the laptop sits at home, wrong the moment the owner travels or this
// runs on a server — and a wrong anchor makes every "tomorrow 9am" resolve to
// the wrong day, silently.
export function nowLocalIn(iso: string, zone: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  const p: Record<string, string> = {};
  for (const { type, value } of parts) p[type] = value;
  const hour = p.hour === "24" ? "00" : p.hour;
  const offName =
    new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(d)
      .find((x) => x.type === "timeZoneName")?.value ?? "";
  return `${p.year}-${p.month}-${p.day} ${hour}:${p.minute} (${zone}${offName ? `, ${offName}` : ""})`;
}
