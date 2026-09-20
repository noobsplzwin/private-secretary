// Which 1:1 WeChat chats have something new — by CURSOR, not by unread count.
//
// WHY THE UNREAD MODEL HAD TO GO. The scanner used to take only sessions with
// unread > 0, and said so in its own comment: "unread IS the open ask." That is
// true for work waiting on Leo, and exactly backwards for work he has already
// agreed to. Measured case, 2026-09-20: 王凤壮 sent "周二上午9点到9点30 B510" at
// 14:07, Leo answered "好的！" four minutes later, unread went to zero, and the
// meeting never reached the calendar — the engine had no way to ever see that
// conversation again. The rows most worth catching are precisely the ones he
// handles on the spot, because handling them is what makes them real.
//
// So a direct chat is scanned when it has moved since we last looked, whether
// or not Leo has read it. The cursor mirrors the group path (core/wechat-groups
// .ts), including its first-contact rule.

export interface DirectCursor {
  /** Latest message time already scanned in this chat. */
  lastSeenMs: number;
}

export type DirectBook = Record<string, DirectCursor>;

/** Only what the planner needs from a parsed session line. */
export interface DirectSession {
  name: string;
  isGroup: boolean;
  tsMs: number;
}

export interface DirectScanPlan {
  /** Chats to pull history for. */
  fetch: string[];
  /**
   * Chats seen for the FIRST time. Their cursor is seeded at the current
   * timestamp and nothing is minted — same rule the group scan needed: first
   * contact must not dump a contact's whole backlog into the queue as if it all
   * arrived today.
   */
  seed: string[];
}

export function planDirectScan(
  sessions: readonly DirectSession[],
  book: DirectBook,
  opts: { exclude?: readonly string[]; official?: ReadonlySet<string> } = {},
): DirectScanPlan {
  const fetch: string[] = [];
  const seed: string[] = [];
  for (const s of sessions) {
    if (s.isGroup) continue;
    if (s.name === "" || s.name === "@placeholder_foldgroup") continue;
    if (opts.exclude?.some((f) => s.name.includes(f))) continue;
    if (opts.official?.has(s.name)) continue;
    const known = book[s.name];
    if (known === undefined) {
      seed.push(s.name);
      continue;
    }
    if (s.tsMs > known.lastSeenMs) fetch.push(s.name);
  }
  return { fetch, seed };
}

/**
 * Advance a cursor. Never moves backwards: a session line carries only
 * minute precision, so two scans in the same minute must not re-open a chat
 * already consumed, and a clock wobble must not replay a whole conversation.
 */
export function advanceCursor(book: DirectBook, name: string, tsMs: number): DirectBook {
  const known = book[name]?.lastSeenMs ?? 0;
  return tsMs > known ? { ...book, [name]: { lastSeenMs: tsMs } } : book;
}
