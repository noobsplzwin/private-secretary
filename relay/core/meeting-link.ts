// A JOIN LINK THAT ARRIVES AFTER THE EVENT — goes into the event.
//
// 2026-10-10: the 君合 meeting was booked with 「会议链接见微信群」 and the
// owner asked why the link was not in the description. The drafter now copies
// a link it can see; this covers the other order — a meeting agreed first, the
// Tencent/Zoom/Teams link posted later in the same chat. Deterministic: the
// link goes to the ONE upcoming event booked from that conversation, or to
// nothing — with two candidates there is no way to know which, and a link on
// the wrong meeting sends him to the wrong call.

import type { ActionItem } from "./action-item.js";

const JOIN_URL =
  /https?:\/\/(?:meeting\.tencent\.com|(?:[\w-]+\.)?vc\.feishu\.cn|(?:[\w-]+\.)?zoom\.(?:us|com\.cn)\/j|teams\.microsoft\.com\/(?:l\/meetup-join|meet)|meet\.google\.com)\/[^\s<>"'）)]+/i;
const DETAIL = /(会议号|腾讯会议[:：]|会议\s*ID|Meeting ID|密码|Passcode)/i;

/** The join link in a message, with the lines that carry its number and passcode. Null when none. */
export function joinLinkBlock(text: string): { url: string; block: string } | null {
  const m = JOIN_URL.exec(text);
  if (!m) return null;
  const url = m[0];
  const details = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.includes(url) && DETAIL.test(l));
  return { url, block: [url, ...details].join("\n") };
}

const HORIZON_MS = 14 * 24 * 60 * 60 * 1000;

/** The ONE booked, upcoming event from this conversation — or null. */
export function bookedMeetingFor(actions: readonly ActionItem[], senderHandle: string, nowMs: number): ActionItem | null {
  const hits = actions.filter((a) => {
    if (a.action_type !== "calendar" || a.status !== "executed") return false;
    if (a.context?.sender_handle !== senderHandle) return false;
    const receipt = a.params.execution_receipt as { kind?: string; ref?: string } | undefined;
    if (receipt?.kind !== "calendar_event" || !receipt.ref) return false;
    const start = Date.parse(String(a.params.start));
    return Number.isFinite(start) && start > nowMs && start - nowMs <= HORIZON_MS;
  });
  return hits.length === 1 ? hits[0]! : null;
}

/** The event's new description, or null when the link is already in it. */
export function descriptionWithLink(description: string | undefined, link: { url: string; block: string }): string | null {
  if ((description ?? "").includes(link.url)) return null;
  return description ? `${link.block}\n\n${description}` : link.block;
}
