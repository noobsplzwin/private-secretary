// WHICH WeChat groups are work, and WHEN a group has something new.
//
// Groups were dropped wholesale (`!s.isGroup` in sources/wechat-direct.ts). The
// cost showed up on 2026-09-12: a legal-counsel introduction the owner needed
// («郭律，我们奇绩的法务负责人，关于签署合同的相关事宜我们在本群对接») lived in a
// two-person group and never entered the system at all — 2538 shadow records,
// not one mention.
//
// TWO separate judgements, kept apart on purpose:
//
//   WHICH — an explicit allowlist the owner confirms, PLUS an auto-admit for
//   small groups so a new 3-person work group starts working without him
//   having to remember to register it. He asked for both, and both are needed:
//   the count rule cannot reach «β东亚时区RISCV双周会β», a 193-member group he
//   calls work, and an allowlist alone means every new group is invisible until
//   he notices.
//
//   WHEN — a per-group cursor, not the unread count. `unread > 0` is why the
//   legal thread was unreachable even in principle: the owner reads his working
//   groups the moment they buzz, so their unread is permanently 0. A cursor asks
//   the honest question — is the latest message newer than the last one I
//   handled — and costs no history call when the answer is no.
//
// MEMBERSHIP IS NOT AVAILABLE. The WeChat MCP server exposes seventeen tools and
// none of them returns a group's member count, so the auto-admit rule counts
// DISTINCT SPEAKERS in recent history instead. That is a proxy, and a biased
// one: «β东亚时区RISCV双周会β» has 193 members and showed 10 speakers. It
// under-counts, never over-counts, which is the safe direction for an
// auto-ADMIT — a big group can slip in, but a small one is never locked out.
//
// Because the proxy is unstable (today's 3 speakers can be tomorrow's 12), a
// decision is made ONCE and persisted. A gate that recomputed every tick would
// flicker groups in and out of coverage with no record of what it missed.

/** Distinct speakers at or below which a group auto-admits as work. */
export const AUTO_ADMIT_MAX_SPEAKERS = 6;

/** How many recent messages the auto-admit decision samples. */
export const ADMIT_SAMPLE_SIZE = 60;

export interface GroupDecision {
  decision: "allow" | "deny";
  /** Distinct speakers seen when the call was made. Absent for owner entries. */
  speakers?: number;
  /** "owner" survives a re-classification; "auto" is the rule's own guess. */
  by: "owner" | "auto";
  at: string;
  /** Latest message time already turned into inbound messages. */
  lastSeenMs?: number;
}

export type GroupBook = Record<string, GroupDecision>;

// `[2026-09-12 17:39] 金小奇 芯联集成: 那个鸭子也要吗`
//
// Anchored on the full timestamp. A looser "anything before a colon" pattern
// counted 「建议的折中」 and 「一句话收」 — fragments of a forwarded message — as
// separate people, which inflated 「Leo和台州帮」 from 3 speakers to 8 and would
// have pushed real work groups over any threshold.
const HISTORY_LINE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\s+([^:]{1,32}):\s/;

/** Distinct speakers in a get_chat_history block. `[系统]` is not a person. */
export function countSpeakers(history: string): number {
  const seen = new Set<string>();
  for (const line of history.split("\n")) {
    const m = HISTORY_LINE.exec(line);
    if (!m) continue;
    const who = m[1]!.trim();
    if (who === "" || who === "[系统]") continue;
    seen.add(who);
  }
  return seen.size;
}

/**
 * The auto-admit call for a group nobody has classified yet. Deliberately one
 * way: small admits, everything else is denied and stays denied until the owner
 * says otherwise — a wrong "allow" floods his list, a wrong "deny" he can fix.
 */
export function classifyGroup(speakers: number, at: string): GroupDecision {
  return {
    decision: speakers > 0 && speakers <= AUTO_ADMIT_MAX_SPEAKERS ? "allow" : "deny",
    speakers,
    by: "auto",
    at,
  };
}

export interface GroupSession {
  name: string;
  isGroup: boolean;
  tsMs: number;
}

export interface GroupScanPlan {
  /** Allowed groups whose latest message is newer than what we handled. */
  fetch: string[];
  /** Groups with no decision yet — sample their history, then classify. */
  classify: string[];
}

/**
 * What to do with this tick's session list. Pure: the caller does the I/O.
 *
 * A group with NO new message is in neither list, which is the whole point —
 * steady state costs one get_recent_sessions call and nothing else, however
 * many groups are allowed.
 */
export function planGroupScan(
  sessions: readonly GroupSession[],
  book: GroupBook,
): GroupScanPlan {
  const fetch: string[] = [];
  const classify: string[] = [];
  for (const s of sessions) {
    if (!s.isGroup) continue;
    // A folded-group placeholder is a UI artifact, not a conversation.
    if (s.name === "@placeholder_foldgroup" || s.name === "") continue;
    const known = book[s.name];
    if (!known) {
      classify.push(s.name);
      continue;
    }
    if (known.decision !== "allow") continue;
    if (s.tsMs > (known.lastSeenMs ?? 0)) fetch.push(s.name);
  }
  return { fetch, classify };
}
