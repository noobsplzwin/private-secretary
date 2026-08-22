// WHO gets assessed this tick. Pure core, no I/O.
//
// specs/person-first-consolidation.md §3.1: the person pass should run for
// "persons with new traffic", and that is the cost bound — a quiet tick costs
// nothing. What shipped instead keyed the pass on OPEN CARDS and rate-limited
// it with a 10-minute TTL, which gets both halves wrong:
//
//   - a contact who talked but has no card open is never assessed at all, so
//     work that never made it onto a card is invisible to the ledger
//   - a contact with a card is re-assessed every TTL whether or not they said
//     anything, which is the same clock-gated waste that made refresh 69% of
//     the token bill
//
// Two cursors replace the TTL. `traffic` is when we last SAW a message from
// someone; `assessed` is when the pass last ran for them. Work is owed when
// traffic > assessed, which is self-limiting — once assessed they do not come
// back until they talk again — and survives a restart, which the module-level
// TTL did not.
//
// Strictly-greater, not >=: a message seen in the same millisecond as the last
// assessment is already covered by it, and >= would re-assess forever on a
// clock with coarse resolution.

export interface PersonQueueEntry {
  personaKey: string;
  /** When this person last spoke — epoch ms. Oldest first, so nobody starves. */
  trafficMs: number;
}

export function personsNeedingAssessment(
  traffic: Readonly<Record<string, number>>,
  assessed: Readonly<Record<string, number>>,
  /** Cap per tick, so one busy hour cannot fan out into hundreds of calls. */
  maxPerTick: number,
): PersonQueueEntry[] {
  if (maxPerTick <= 0) return [];
  return Object.entries(traffic)
    .filter(([key, ms]) => ms > (assessed[key] ?? 0))
    .sort(([aKey, a], [bKey, b]) => a - b || aKey.localeCompare(bKey))
    .slice(0, maxPerTick)
    .map(([personaKey, trafficMs]) => ({ personaKey, trafficMs }));
}

/**
 * Record that messages from these people were seen. Keeps the LATEST timestamp
 * per person: a person who spoke twice this tick is one unit of work, and
 * taking the newest stamp means the assessment covers everything up to it.
 */
export function recordTraffic(
  traffic: Readonly<Record<string, number>>,
  seen: ReadonlyArray<{ personaKey: string; timestampMs: number }>,
): Record<string, number> {
  const out = { ...traffic };
  for (const { personaKey, timestampMs } of seen) {
    if (!personaKey) continue;
    const prev = out[personaKey];
    if (prev === undefined || timestampMs > prev) out[personaKey] = timestampMs;
  }
  return out;
}

/**
 * Mark these people assessed. The cursor is set to the TRAFFIC stamp the queue
 * entry carried, NOT to "now": a message that arrives while the pass is running
 * would be silently marked covered by a now-stamp, and lost. Using the stamp we
 * actually read up to errs toward re-assessing, which costs one call; the other
 * direction costs a commitment nobody ever sees.
 */
export function markAssessed(
  assessed: Readonly<Record<string, number>>,
  done: ReadonlyArray<PersonQueueEntry>,
): Record<string, number> {
  const out = { ...assessed };
  for (const { personaKey, trafficMs } of done) {
    const prev = out[personaKey];
    if (prev === undefined || trafficMs > prev) out[personaKey] = trafficMs;
  }
  return out;
}
