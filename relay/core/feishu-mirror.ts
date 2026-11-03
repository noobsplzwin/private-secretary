// FEISHU CALENDAR → his Google calendar.
//
// Owner, 2026-10-31: 「这俩为什么没有更新进去」 — two Feishu invites (the
// 小鹏-瑞萨 OTA call, 冉朱旭's interview) never reached his calendar, because
// nothing here read Feishu. The engine now reads his Feishu agenda and keeps a
// mirror of it on the booking calendar: created, moved, retitled, removed.
//
// Ownership is the safety line. An event THIS mirror created is its to change
// or delete. An event that was already on his calendars for the same meeting
// (booked from WeChat, or by hand) is ADOPTED: recorded so it is never booked
// twice, and never touched — someone else made it.

import type { CalendarEvent } from "../io/calendar-api.js";

export interface FeishuEvent {
  /** Feishu event_id (instance id for a recurrence). */
  id: string;
  summary: string;
  /** RFC 3339 with offset, as Feishu returns it. */
  start: string;
  end: string;
  /** Feishu meeting link, when the event has one. */
  url?: string;
  organizer?: string;
  /** accept | tentative | needs_action | decline */
  rsvp?: string;
  appLink?: string;
}

export interface MirrorEntry {
  /** The Google event this Feishu event maps to. */
  googleId: string;
  /** What the Google event was last written from — a change means an update. */
  hash: string;
  /** Already on his calendar when first seen: mapped, never written. */
  adopted?: boolean;
  /** Start, so an entry past its meeting can be forgotten. */
  start: string;
}

export type MirrorMap = Record<string, MirrorEntry>;

/** `lark-cli calendar +agenda --as user` output → the timed events he has not declined. */
export function parseAgenda(raw: unknown): FeishuEvent[] {
  const data = (raw as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: FeishuEvent[] = [];
  for (const e of data as Array<Record<string, any>>) {
    const start = e?.start_time?.datetime;
    const end = e?.end_time?.datetime;
    if (typeof e?.event_id !== "string" || typeof start !== "string" || typeof end !== "string") continue; // all-day: no datetime
    if (e.self_rsvp_status === "decline") continue;
    out.push({
      id: e.event_id,
      summary: typeof e.summary === "string" && e.summary.trim() ? e.summary.trim() : "(飞书日程)",
      start,
      end,
      ...(typeof e.vchat?.meeting_url === "string" ? { url: e.vchat.meeting_url } : {}),
      ...(typeof e.event_organizer?.display_name === "string" ? { organizer: e.event_organizer.display_name } : {}),
      ...(typeof e.self_rsvp_status === "string" ? { rsvp: e.self_rsvp_status } : {}),
      ...(typeof e.app_link === "string" ? { appLink: e.app_link } : {}),
    });
  }
  return out;
}

/** The Google event a Feishu event becomes. The meeting link leads: location and the description's first line. */
export function googleEventFor(e: FeishuEvent): CalendarEvent {
  const lines = [
    e.url ? `飞书会议：${e.url}` : "",
    e.organizer ? `组织者：${e.organizer}` : "",
    e.appLink ? `飞书日程：${e.appLink}` : "",
    "（由秘书从飞书日历同步）",
  ].filter(Boolean);
  return {
    summary: e.summary,
    start: { dateTime: e.start },
    end: { dateTime: e.end },
    ...(e.url ? { location: e.url } : {}),
    description: lines.join("\n"),
  };
}

export function mirrorHash(e: FeishuEvent): string {
  return JSON.stringify([e.summary, Date.parse(e.start), Date.parse(e.end), e.url ?? ""]);
}

const fold = (s: string): string => s.replace(/[\s（）()【】\[\]·:：,，]/g, "").toLowerCase();
const NEAR_MS = 10 * 60 * 1000;

/**
 * The Google event that already IS this meeting: within ten minutes of its
 * start, and carrying its meeting link or the same title. Deterministic on
 * purpose — the link is the meeting's identity; a title match at the same
 * minute is the fallback for events booked from chat without one.
 */
export function existingFor(e: FeishuEvent, google: readonly CalendarEvent[]): CalendarEvent | null {
  const at = Date.parse(e.start);
  const code = e.url?.match(/\/j\/(\d+)/)?.[1];
  for (const g of google) {
    if (!g.id || g.status === "cancelled" || !g.start.dateTime) continue;
    if (Math.abs(Date.parse(g.start.dateTime) - at) > NEAR_MS) continue;
    const text = `${g.location ?? ""}\n${g.description ?? ""}`;
    if (e.url && (text.includes(e.url) || (code && text.replace(/\s/g, "").includes(code)))) return g;
    const a = fold(g.summary ?? "");
    const b = fold(e.summary);
    if (a && b && (a.includes(b) || b.includes(a))) return g;
  }
  return null;
}

export interface MirrorPlan {
  create: FeishuEvent[];
  adopt: Array<{ event: FeishuEvent; googleId: string }>;
  update: Array<{ event: FeishuEvent; googleId: string }>;
  /** Created by this mirror, gone from Feishu, still ahead. */
  remove: Array<{ feishuId: string; googleId: string }>;
  /** Entries whose meeting is over — dropped from the map, nothing written. */
  forget: string[];
}

/**
 * What to write. `feishu` is his agenda over [nowMs, windowEndMs); an entry
 * missing from it is gone only when its meeting falls inside that window —
 * outside it, absence means only that we did not look.
 */
export function planMirror(
  feishu: readonly FeishuEvent[],
  map: Readonly<MirrorMap>,
  google: readonly CalendarEvent[],
  nowMs: number,
  windowEndMs: number,
): MirrorPlan {
  const plan: MirrorPlan = { create: [], adopt: [], update: [], remove: [], forget: [] };
  const seen = new Set<string>();
  for (const e of feishu) {
    seen.add(e.id);
    if (Date.parse(e.end) <= nowMs) continue;
    const entry = map[e.id];
    if (!entry) {
      const g = existingFor(e, google);
      if (g?.id) plan.adopt.push({ event: e, googleId: g.id });
      else plan.create.push(e);
      continue;
    }
    if (!entry.adopted && entry.hash !== mirrorHash(e)) plan.update.push({ event: e, googleId: entry.googleId });
  }
  for (const [id, entry] of Object.entries(map)) {
    if (seen.has(id)) continue;
    const at = Date.parse(entry.start);
    if (!(at > nowMs)) plan.forget.push(id);
    else if (at < windowEndMs) {
      if (entry.adopted) plan.forget.push(id);
      else plan.remove.push({ feishuId: id, googleId: entry.googleId });
    }
  }
  return plan;
}
