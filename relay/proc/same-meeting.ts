// Before an auto-created event is booked: is that meeting already on one of
// his calendars at another time? (core/same-meeting.ts explains why.) Any
// failure answers "no" — the event is then booked exactly as before.

import type { ActionItem } from "../core/action-item.js";
import type { JsonRequest, Persona } from "../core/types.js";
import type { CalendarEvent } from "../io/calendar-api.js";
import { buildSameMeetingRequest, comparableEvents, parseSameMeeting } from "../core/same-meeting.js";
import { resolveCalendarMailbox, type ExecuteDeps } from "./execute.js";

/** Same calendar day, give or take: a moved time rarely moves further. */
const WINDOW_MS = 12 * 60 * 60 * 1000;

export async function sameMeetingOnCalendar(
  action: ActionItem,
  deps: ExecuteDeps,
  json: ((req: JsonRequest) => Promise<unknown>) | undefined,
  /** The contact book, so 「金小奇」 can meet 金奇浩 <qh_jin@…> by id. Exact handle only. */
  resolvePersona?: (handle: string) => Persona | null,
): Promise<CalendarEvent | null> {
  if (!json) return null;
  const mailbox = resolveCalendarMailbox(action, Object.keys(deps.calendar ?? {}));
  const cal = mailbox ? deps.calendar?.[mailbox] : undefined;
  const p = action.params;
  const start = Date.parse(String(p.start));
  if (!cal || !Number.isFinite(start)) return null;
  try {
    const events = comparableEvents(
      await cal.listAllEvents({ timeMin: new Date(start - WINDOW_MS).toISOString(), timeMax: new Date(start + WINDOW_MS).toISOString() }),
    );
    if (events.length === 0) return null;
    const handle = action.context?.sender_handle;
    const persona = handle ? resolvePersona?.(handle) ?? null : null;
    const people = persona
      ? [`${persona.displayName} (${Object.entries(persona.handles).map(([k, v]) => `${k} id ${v}`).join(", ")})`]
      : handle
        ? [action.context?.sender_name ?? handle]
        : [];
    const said = [p.time_quote, action.context?.original_message].filter((x): x is string => typeof x === "string" && x !== "").join("\n");
    const req = buildSameMeetingRequest(
      {
        title: String(p.title ?? ""),
        start: String(p.start),
        end: String(p.end),
        ...(typeof p.description === "string" ? { description: p.description } : {}),
        ...(Array.isArray(p.attendees) ? { attendees: p.attendees.map(String) } : {}),
        ...(said ? { said } : {}),
        ...(people.length ? { people } : {}),
      },
      events,
    );
    return parseSameMeeting(await json(req), events);
  } catch {
    return null;
  }
}
