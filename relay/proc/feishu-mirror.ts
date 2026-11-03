// One pass of the Feishu → Google mirror (core/feishu-mirror.ts explains it).
// Owns state/feishu-mirror.json and nothing else: no loop-state, no lock.
// Every write emails nobody (sendUpdates none). A write that fails leaves its
// entry as it was, so the next pass tries again; the map is saved after each
// write, so a crash mid-pass never forgets an event it already booked.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { CalendarApiError, type CalendarEvent } from "../io/calendar-api.js";
import { googleEventFor, mirrorHash, planMirror, type FeishuEvent, type MirrorMap } from "../core/feishu-mirror.js";
import { comparableEvents } from "../core/same-meeting.js";

export interface MirrorCalendar {
  listAllEvents(opts: { timeMin: string; timeMax: string }): Promise<CalendarEvent[]>;
  insertEvent(opts: { event: CalendarEvent; sendUpdates?: "all" | "externalOnly" | "none" }): Promise<CalendarEvent>;
  patchEvent(opts: { eventId: string; patch: Partial<CalendarEvent>; sendUpdates?: "all" | "externalOnly" | "none" }): Promise<CalendarEvent>;
  deleteEvent(opts: { eventId: string; sendUpdates?: "all" | "externalOnly" | "none" }): Promise<void>;
}

export interface FeishuMirrorDeps {
  fetchAgenda: (startIso: string, endIso: string) => Promise<FeishuEvent[]>;
  calendar: MirrorCalendar;
  mapPath: string;
  nowMs?: number;
  /** How far ahead to mirror. */
  days?: number;
}

export function loadMirrorMap(path: string): MirrorMap {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as MirrorMap;
  } catch {
    return {};
  }
}

function saveMirrorMap(path: string, map: MirrorMap): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(map, null, 1));
  renameSync(tmp, path);
}

export interface MirrorResult {
  created: string[];
  adopted: string[];
  updated: string[];
  removed: string[];
  errors: string[];
}

export async function runFeishuMirror(deps: FeishuMirrorDeps): Promise<MirrorResult> {
  const now = deps.nowMs ?? Date.now();
  const end = now + (deps.days ?? 30) * 86_400_000;
  const [startIso, endIso] = [new Date(now).toISOString(), new Date(end).toISOString()];
  const feishu = await deps.fetchAgenda(startIso, endIso);
  const google = comparableEvents(await deps.calendar.listAllEvents({ timeMin: startIso, timeMax: endIso }));
  const map = loadMirrorMap(deps.mapPath);
  const plan = planMirror(feishu, map, google, now, end);
  const r: MirrorResult = { created: [], adopted: [], updated: [], removed: [], errors: [] };
  const save = (): void => saveMirrorMap(deps.mapPath, map);

  for (const id of plan.forget) delete map[id];
  for (const { event, googleId } of plan.adopt) {
    map[event.id] = { googleId, hash: mirrorHash(event), start: event.start, adopted: true };
    r.adopted.push(event.summary);
  }
  if (plan.forget.length || plan.adopt.length) save();

  for (const event of plan.create) {
    try {
      const g = await deps.calendar.insertEvent({ event: googleEventFor(event), sendUpdates: "none" });
      if (!g.id) throw new Error("insert returned no id");
      map[event.id] = { googleId: g.id, hash: mirrorHash(event), start: event.start };
      save();
      r.created.push(event.summary);
    } catch (e) {
      r.errors.push(`create "${event.summary}": ${(e as Error).message.split("\n")[0]}`);
    }
  }
  for (const { event, googleId } of plan.update) {
    try {
      const body = googleEventFor(event);
      await deps.calendar.patchEvent({ eventId: googleId, patch: body, sendUpdates: "none" });
      map[event.id] = { googleId, hash: mirrorHash(event), start: event.start };
      save();
      r.updated.push(event.summary);
    } catch (e) {
      r.errors.push(`update "${event.summary}": ${(e as Error).message.split("\n")[0]}`);
    }
  }
  for (const { feishuId, googleId } of plan.remove) {
    try {
      try {
        await deps.calendar.deleteEvent({ eventId: googleId, sendUpdates: "none" });
      } catch (e) {
        // Already gone — he deleted it himself. That is the outcome we wanted.
        if (!(e instanceof CalendarApiError && (e.httpStatus === 404 || e.httpStatus === 410))) throw e;
      }
      delete map[feishuId];
      save();
      r.removed.push(googleId);
    } catch (e) {
      r.errors.push(`remove ${googleId}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  return r;
}
