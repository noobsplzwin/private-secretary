// WeChat detection source for the notification loop.
//
// DETECTION MODEL (the get_new_messages digest was RETIRED — it was lossy and
// direction-blind, which produced four separate bugs; see specs / git history):
//   1. get_recent_sessions gives every session with its latest-message time. A
//      chat is scanned when it MOVED since the last look — a cursor, not the
//      unread count (core/wechat-direct-cursor.ts). Unread was the trigger until
//      2026-09-20, and it silently lost every commitment Leo handled on the
//      spot: 王凤壮 proposed 周二上午9点到9点30 B510, Leo answered 好的！four
//      minutes later, unread hit zero, and the meeting never reached the
//      calendar. "Unread is the open ask" holds for work waiting on him and is
//      exactly backwards for work he has already agreed to.
//      Leo's OWN sends still never draft: the direction filter below keeps only
//      incoming lines (that is what fixes "drafted a reply to my own message" —
//      it never depended on the unread count).
//   2. For each unread 1:1, get_chat_history pulls the ACTUAL recent messages,
//      which are DIRECTION-MARKED (the sender label is the contact for incoming,
//      Leo for outgoing) and give full multi-message context (not just the latest
//      one-line preview), plus image refs. We keep only the incoming unread
//      messages and combine them into one InboundMessage.
//
// Groups ([群] / @placeholder_foldgroup) and family (乐乐 / 郑建明) are dropped —
// the queue is person-to-person work only.
//
// Message content is UNTRUSTED DATA (prompt-injection guard) — never instructions.
//
// IMAGES: surfaced as refs (attachments: local_id=N) so the draft prompt flags
// "the point may be in here". Actually feeding the pixels to the model needs
// vision support in anthropic-api.ts (not wired for ANY source yet) — separate
// follow-up; decoding without a vision path would be wasted work.

import type { Attachment, InboundMessage } from "../core/types.js";
import { advanceCursor, planDirectScan, type DirectBook } from "../core/wechat-direct-cursor.js";
import {
  ADMIT_SAMPLE_SIZE,
  classifyGroup,
  countSpeakers,
  planGroupScan,
  type GroupBook,
} from "../core/wechat-groups.js";

// Family contacts to exclude (personal, not for the work queue).
export const WECHAT_FAMILY = ["乐乐", "郑建明"];

// ─── get_recent_sessions parsing ─────────────────────────────────────
// Format (mcp_server.get_recent_sessions):
//   最近 N 个会话:
//
//   [MM-DD HH:MM] <name>[ [群]][ (U条未读)]
//     <type>: [<group-sender>: ]<summary>
// We read ONLY the head line (the indented "  type: content" detail line and the
// "最近 N" header don't match and are skipped).
export interface RecentSession {
  name: string;
  isGroup: boolean;
  unread: number;
  tsMs: number; // latest-message time (minute precision)
}

const SESSION_HEAD_RE =
  /^\[(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})\]\s+(.+?)(\s\[群\])?(?:\s\((\d+)条未读\))?$/;

export function parseRecentSessions(text: string, nowMs: number): RecentSession[] {
  if (!text) return [];
  const out: RecentSession[] = [];
  const now = new Date(nowMs);
  for (const raw of text.split("\n")) {
    const m = SESSION_HEAD_RE.exec(raw.trim());
    if (!m) continue;
    const [, mo, dd, hh, mm, rawName, groupTag, unreadStr] = m;
    const name = rawName!.trim();
    // [MM-DD HH:MM] carries no year; assume the current one, roll back a year if
    // that lands in the future.
    const d = new Date(now.getFullYear(), Number(mo) - 1, Number(dd), Number(hh), Number(mm), 0, 0);
    if (d.getTime() > nowMs) d.setFullYear(d.getFullYear() - 1);
    out.push({
      name,
      isGroup: !!groupTag || name === "@placeholder_foldgroup",
      unread: unreadStr ? Number(unreadStr) : 0,
      tsMs: d.getTime(),
    });
  }
  return out;
}

// ─── get_chat_history parsing ────────────────────────────────────────
// Each line: "[YYYY-MM-DD HH:MM] <sender>: <text>" (sender omitted when unknown).
// In a 1:1 the sender label is the CONTACT's display name for incoming and Leo's
// for outgoing, so incoming === (label === contactName). Images render as
// "[图片] (local_id=N, ts=T)".
export interface HistoryMsg {
  tsMs: number;
  isIncoming: boolean;
  text: string;
  imageLocalIds: number[];
}

const HIST_RE = /^\[(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\]\s+(.*)$/;

export function parseChatHistory(text: string, contactName: string): HistoryMsg[] {
  if (!text) return [];
  const out: HistoryMsg[] = [];
  for (const raw of text.split("\n")) {
    const m = HIST_RE.exec(raw.trim());
    if (!m) continue;
    const [, y, mo, dd, hh, mm, rest] = m;
    let isIncoming = false;
    let body = rest!;
    const sep = rest!.indexOf(": ");
    if (sep > 0) {
      // The first ": " splits the sender label from the text; a 1:1 name never
      // contains ": ", so this is unambiguous.
      isIncoming = rest!.slice(0, sep) === contactName;
      body = rest!.slice(sep + 2);
    }
    const imageLocalIds: number[] = [];
    const img = /\[图片\].*?local_id=(\d+)/.exec(body);
    if (img) imageLocalIds.push(Number(img[1]));
    out.push({
      tsMs: new Date(Number(y), Number(mo) - 1, Number(dd), Number(hh), Number(mm), 0, 0).getTime(),
      isIncoming,
      text: body.trim(),
      imageLocalIds,
    });
  }
  return out;
}

// ─── official-account (公众号/服务号) detection ───────────────────────
// get_recent_sessions only gives display names, but get_contacts lists the
// wxid — and official/marketing accounts (公众号) have a `gh_` wxid prefix
// (mcp_server.py). Parse get_contacts into the set of display names (备注 +
// 昵称) belonging to gh_ accounts, so the scan can drop their broadcasts
// (recruiting links, promos) that aren't person-to-person work.
//
// get_contacts line: "<wxid>[  备注: <remark>][  昵称: <nick>]"
export function parseOfficialAccountNames(contactsText: string): Set<string> {
  const names = new Set<string>();
  for (const raw of contactsText.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("gh_")) continue;
    for (const part of line.split(/\s{2,}/)) {
      const m = /^(?:备注|昵称):\s*(.+)$/.exec(part);
      if (m) names.add(m[1]!.trim());
    }
  }
  return names;
}

// ─── the scan ────────────────────────────────────────────────────────
// How many extra prior messages (beyond the unread) to pull for thread context.
const CONTEXT_LOOKBACK = 6;

export interface WechatInboxOptions {
  // get_recent_sessions text (injectable for tests; prod passes wechatSessions).
  fetchSessions: () => Promise<string>;
  // get_chat_history text for one contact (injectable; prod passes wechatHistory).
  fetchHistory: (name: string, limit: number) => Promise<string>;
  nowMs: number;
  excludeNames?: string[];
  // Display names of 公众号/服务号 (gh_ accounts) to drop — built via
  // parseOfficialAccountNames(get_contacts). Their broadcasts aren't 1:1 work.
  officialNames?: Set<string>;
  historyCap?: number; // max messages to pull per session (default 20)
  /** Cursor book: how far each chat has been scanned. */
  book: DirectBook;
}

// One InboundMessage per unread 1:1 session, carrying the combined incoming
// unread messages. Cross-tick/restart dedup is the scan loop's job (it keeps
// only ids that are new vs the persisted marks).
export async function scanWechatInbox(
  opts: WechatInboxOptions,
): Promise<{ inbound: InboundMessage[]; sessions: RecentSession[]; book: DirectBook }> {
  const sessions = parseRecentSessions(await opts.fetchSessions(), opts.nowMs);
  const exclude = opts.excludeNames ?? WECHAT_FAMILY;
  const cap = opts.historyCap ?? 20;
  const plan = planDirectScan(sessions, opts.book, {
    exclude,
    ...(opts.officialNames ? { official: opts.officialNames } : {}),
  });
  let book = opts.book;
  // First contact seeds its cursor and mints nothing — otherwise the first sight
  // of a chat would pour its whole backlog into the queue as if it arrived now.
  for (const name of plan.seed) {
    const s = sessions.find((x) => x.name === name);
    if (s) book = advanceCursor(book, name, s.tsMs);
  }
  const byName = new Map(sessions.map((s) => [s.name, s]));
  const inbound: InboundMessage[] = [];
  for (const name of plan.fetch) {
    const s = byName.get(name)!;
    const since = opts.book[name]?.lastSeenMs ?? 0;
    // Enough to cover what is new PLUS a few prior messages for conversation
    // context (so the draft isn't a reply to a lone line ripped from its thread).
    const limit = Math.min(cap, Math.max(s.unread + CONTEXT_LOOKBACK, 6));
    const history = parseChatHistory(await opts.fetchHistory(s.name, limit), s.name);
    // The cursor advances on the whole session, Leo's own lines included:
    // otherwise a chat where he spoke last would be re-fetched every tick
    // forever. What he SAID is context, never a trigger.
    const newestSeen = history.reduce((mx, m) => Math.max(mx, m.tsMs), since);
    book = advanceCursor(book, name, Math.max(newestSeen, s.tsMs));
    const fresh = history.filter((m) => m.isIncoming && m.tsMs > since);
    if (fresh.length === 0) continue; // only Leo spoke → context, not an ask
    const combined = fresh.map((m) => m.text).filter(Boolean).join("\n");
    if (!combined) continue; // image/voice-only with no text → nothing to draft from yet
    const unread = fresh;
    const latest = unread[unread.length - 1]!;
    // Background context: the recent thread, both sides, labelled (我 = Leo).
    const threadContext = history
      .map((m) => `${m.isIncoming ? s.name : "我"}: ${m.text}`)
      .join("\n");
    const attachments: Attachment[] = unread
      .flatMap((m) => m.imageLocalIds)
      .map((id) => ({ id: String(id), kind: "image", name: `wechat-image local_id=${id}` }));
    inbound.push({
      id: `wechat:${s.name}:${latest.tsMs}`,
      platform: "wechat",
      senderHandle: s.name,
      timestampMs: latest.tsMs,
      text: combined,
      source: `wechat:${s.name}`,
      isDirectMessage: true,
      mentionsUser: false,
      isReplyInUserThread: false,
      recipientsIncludeUser: true,
      threadAnsweredByUserAfter: false,
      userIsLastSenderInChannel: false,
      threadContext,
      ...(attachments.length ? { attachments } : {}),
    });
  }
  return { inbound, sessions, book };
}

// ─── groups ───────────────────────────────────────────────────────────
//
// Groups were dropped wholesale until 2026-09-12, when a legal-counsel
// introduction the owner needed turned out to live in a two-person group and to
// have never entered the system at all. Which groups count and when one has
// something new are decided in core/wechat-groups.ts; this is the I/O around it.

/** One line of a GROUP history: the speaker is a person, not the group. */
export interface GroupMsg {
  tsMs: number;
  /** Verbatim speaker label. "me" is Leo. Never resolved to a persona here. */
  speaker: string;
  text: string;
  imageLocalIds: number[];
}

const OWN_LABEL = "me";

/**
 * Parse a group's get_chat_history. parseChatHistory above CANNOT do this: it
 * decides direction by `sender === contactName`, and in a group that position
 * holds the speaker, so every line would read as Leo's own and the speaker
 * label would be thrown away with it.
 */
export function parseGroupHistory(text: string): GroupMsg[] {
  if (!text) return [];
  const out: GroupMsg[] = [];
  for (const raw of text.split("\n")) {
    const m = HIST_RE.exec(raw.trim());
    if (!m) continue;
    const [, y, mo, dd, hh, mm, rest] = m;
    const sep = rest!.indexOf(": ");
    if (sep <= 0) continue; // no speaker label — a continuation line, not a message
    const speaker = rest!.slice(0, sep).trim();
    const body = rest!.slice(sep + 2).trim();
    const imageLocalIds: number[] = [];
    const img = /\[图片\].*?local_id=(\d+)/.exec(body);
    if (img) imageLocalIds.push(Number(img[1]));
    out.push({
      tsMs: new Date(Number(y), Number(mo) - 1, Number(dd), Number(hh), Number(mm), 0, 0).getTime(),
      speaker,
      text: body,
      imageLocalIds,
    });
  }
  return out;
}

export interface WechatGroupScanOptions {
  sessions: readonly RecentSession[];
  book: GroupBook;
  fetchHistory: (name: string, limit: number) => Promise<string>;
  historyCap?: number;
  now: () => string;
}

/**
 * One InboundMessage per ALLOWED group that has messages past its cursor.
 *
 * senderHandle is the GROUP, never a speaker. Binding a group line to a person
 * would mean matching a display name against persona handles, and the one rule
 * this codebase will not bend is that people are bound on an exact match or not
 * at all (the Echo / Echo Lian incident). The speakers stay in the text where
 * the model can read them and no code pretends to know who they are; a group
 * resolves to no persona, so its work reaches the owner through the card path.
 */
export async function scanWechatGroups(
  opts: WechatGroupScanOptions,
): Promise<{ inbound: InboundMessage[]; book: GroupBook }> {
  const cap = opts.historyCap ?? 40;
  const book: GroupBook = { ...opts.book };
  const plan = planGroupScan(opts.sessions, book);
  const at = opts.now();

  // Classify first, act next tick. A group admitted here has no cursor yet, so
  // the next pass reads it from the top of its window — one tick later costs
  // nothing and keeps this pass's two jobs from entangling.
  for (const name of plan.classify) {
    try {
      book[name] = classifyGroup(countSpeakers(await opts.fetchHistory(name, ADMIT_SAMPLE_SIZE)), at);
    } catch {
      // Unreadable this tick: leave it unclassified so it is retried, rather
      // than denying it permanently on one failed call.
    }
  }

  const inbound: InboundMessage[] = [];
  for (const name of plan.fetch) {
    const entry = book[name]!;
    let msgs: GroupMsg[];
    try {
      msgs = parseGroupHistory(await opts.fetchHistory(name, cap));
    } catch {
      continue; // one unreadable group must not sink the rest
    }
    if (msgs.length === 0) continue;
    const newest = msgs[msgs.length - 1]!.tsMs;
    // FIRST CONTACT seeds the cursor and mints nothing. A group admitted with no
    // cursor used to read as "everything is new", so its whole recent history
    // came through as fresh work: on 2026-09-12 the two-message group «Lucky»
    // produced 「回复茉莉：是否需要装空调」 from a message dated 2025-06-13 — a
    // reply the owner was asked to make to a question fifteen months old.
    // Coverage starts at admission; history before it is not a to-do.
    if (entry.lastSeenMs === undefined) {
      book[name] = { ...entry, lastSeenMs: newest };
      continue;
    }
    const cursor = entry.lastSeenMs;
    const unseen = msgs.filter((m) => m.tsMs > cursor && m.speaker !== OWN_LABEL);
    // The cursor advances over Leo's OWN messages too — they are seen, just not
    // work for him — otherwise a group where he speaks last re-reads every tick.
    book[name] = { ...entry, lastSeenMs: Math.max(cursor, newest) };
    if (unseen.length === 0) continue;
    const combined = unseen.map((m) => `${m.speaker}: ${m.text}`).filter((l) => l.trim() !== "").join("\n");
    if (!combined) continue;
    const latest = unseen[unseen.length - 1]!;
    const attachments: Attachment[] = unseen
      .flatMap((m) => m.imageLocalIds)
      .map((id) => ({ id: String(id), kind: "image", name: `wechat-image local_id=${id}` }));
    inbound.push({
      id: `wechat:${name}:${latest.tsMs}`,
      platform: "wechat",
      senderHandle: name,
      timestampMs: latest.tsMs,
      text: combined,
      source: `wechat:${name}`,
      // A group is not a DM, and saying otherwise would tell the trigger filter
      // that every line is addressed to Leo personally.
      isDirectMessage: false,
      mentionsUser: /@LEO|@Leo|@郑惠哲/.test(combined),
      isReplyInUserThread: false,
      recipientsIncludeUser: true,
      threadAnsweredByUserAfter: false,
      userIsLastSenderInChannel: msgs[msgs.length - 1]!.speaker === OWN_LABEL,
      threadContext: msgs.map((m) => `${m.speaker === OWN_LABEL ? "我" : m.speaker}: ${m.text}`).join("\n"),
      ...(attachments.length ? { attachments } : {}),
    });
  }
  return { inbound, book };
}

/**
 * When the OWNER last spoke in each of these conversations.
 *
 * The engine cannot learn this from an inbound message, which is the whole
 * problem: a WeChat conversation Leo has answered carries no unread, so it
 * stops being a scan candidate and never produces one. `userIsLastSenderInChannel`
 * is hard-coded false on the 1:1 path for the same reason — there was nothing
 * to set it from. So the answer is fetched directly, and only for conversations
 * that actually have a card waiting on a reply; a quiet contact costs nothing.
 *
 * Works for 1:1 and groups alike — both render as `[ts] <speaker>: <text>` and
 * both label the owner "me".
 */
export async function ownerLastSpokeIn(
  names: readonly string[],
  fetchHistory: (name: string, limit: number) => Promise<string>,
  limit = 20,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const name of names) {
    let msgs: GroupMsg[];
    try {
      msgs = parseGroupHistory(await fetchHistory(name, limit));
    } catch {
      continue; // one unreadable conversation must not sink the rest
    }
    let latest = 0;
    for (const m of msgs) if (m.speaker === OWN_LABEL && m.tsMs > latest) latest = m.tsMs;
    if (latest > 0) out.set(name, latest);
  }
  return out;
}
