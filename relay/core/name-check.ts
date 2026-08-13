// Catch an INVENTED person in a next_action. Pure core: no I/O.
//
// next_actions is free text nobody validated. The model wrote "回 Fabian：4 点须
// 列为 hard must-have" on a card whose sender was Cody — there is no Fabian
// persona and the word appears nowhere in the thread. The owner spotted it
// himself ("Fabian 是谁！应该是Cody"). CLAUDE.md makes wrong-recipient the worst
// failure this product has, but that rule only ever covered the recipient
// FIELDS; a name inside a next_action string was never checked, and those
// strings are now the checklist items the owner works from in TickTick.
//
// SCOPE, deliberately narrow: only names in an ADDRESSING position — "回 X",
// "催 X", "Ping X", "assign to X". Those are the positions where a wrong name
// makes the owner contact the wrong person. General name extraction from prose
// would need NER, and a noisy warning is one people learn to ignore.
//
// This is a WARNING, not a gate. It cannot prove a name is wrong, only that the
// name is in neither the thread nor the roster — which is exactly the shape the
// Fabian case had.

/** Verbs after which the next token is being ADDRESSED. */
const CJK_VERBS = [
  "回复", "回", "告知", "通知", "同步", "催", "问", "找", "联系", "提醒", "发给", "转给", "指派给", "指派",
];
const EN_VERBS = [
  "reply to", "respond to", "ping", "ask", "tell", "notify", "remind", "assign to",
  "follow up with", "confirm with", "check with", "send to", "loop in",
];

// Words that follow an addressing verb but are things, not people. Without this
// "回复报价" reads as a person called 报价.
const NOT_NAMES = new Set([
  "报价", "邮件", "消息", "信息", "文档", "进度", "结果", "方案", "合同", "订单", "问题",
  "客户", "对方", "他", "她", "我", "大家", "群里", "频道", "团队", "会议", "时间", "地址",
  "him", "her", "them", "me", "us", "everyone", "team", "channel", "thread", "customer",
  "client", "the", "back", "it",
]);

function norm(s: string): string {
  return s.trim().toLowerCase();
}

// ONE alternation per language, verbs sorted LONGEST FIRST. Alternation is
// ordered, so "回复" wins over "回" at the same position — matching the short
// verb inside the long one turned "回复报价" into a person called 复报价.
const byLengthDesc = (a: string, b: string) => b.length - a.length;
const CJK_RE = new RegExp(
  `(?:${[...CJK_VERBS].sort(byLengthDesc).join("|")})\\s*([A-Z][A-Za-z.'-]+|[\\u4e00-\\u9fa5]{2,3})`,
  "gu",
);
// The verb's first letter accepts either case ("Ping" and "ping"), while the
// capture stays case-SENSITIVE — a lowercase word after "ask" is not a name, so
// an /i flag on the whole pattern would defeat the point.
const EN_RE = new RegExp(
  `\\b(?:${[...EN_VERBS]
    .sort(byLengthDesc)
    .map((v) => v.replace(/^([a-z])/, (c) => `[${c.toUpperCase()}${c}]`))
    .join("|")})\\s+([A-Z][A-Za-z.'-]+(?:\\s+[A-Z][A-Za-z.'-]+)?)`,
  "gu",
);

// A CJK capture is 2-3 characters, so a thing can still slip in as its prefix:
// "同步进度给团队" captures 进度给, whose first two characters are 进度. Test the
// prefix as well before treating the run as a name.
function considerCjk(candidate: string, consider: (c: string) => void): void {
  if (/^[一-龥]/u.test(candidate) && NOT_NAMES.has(norm(candidate.slice(0, 2)))) return;
  consider(candidate);
}

/**
 * Names used in an addressing position that appear in NEITHER the thread nor the
 * roster.
 *
 * `aliases` should be every name the roster answers to (keys, display names,
 * first names, handles) plus the owner's own names — anything legitimately
 * nameable without the thread having to say it.
 */
export function findUnverifiedNames(
  texts: readonly string[],
  opts: { threadText?: string; aliases?: readonly string[] } = {},
): string[] {
  const haystack = norm(opts.threadText ?? "");
  const known = new Set((opts.aliases ?? []).map(norm).filter((a) => a !== ""));
  const found: string[] = [];
  const seen = new Set<string>();

  const consider = (candidate: string): void => {
    const value = candidate.trim().replace(/[：:，,。.、!?？]+$/u, "");
    if (value.length < 2) return;
    const key = norm(value);
    if (NOT_NAMES.has(key) || seen.has(key)) return;
    // In the thread, or someone the roster knows → nothing to warn about.
    if (haystack.includes(key)) return;
    if (known.has(key)) return;
    seen.add(key);
    found.push(value);
  };

  for (const text of texts) {
    if (typeof text !== "string" || !text.trim()) continue;
    for (const m of text.matchAll(CJK_RE)) considerCjk(m[1]!, consider);
    for (const m of text.matchAll(EN_RE)) consider(m[1]!);
  }
  return found;
}

/** Every name the roster answers to, for the `aliases` argument above. */
export function rosterAliases(
  personas: ReadonlyArray<{ key: string; displayName: string; handles: Record<string, string | undefined> }>,
): string[] {
  const out: string[] = [];
  for (const p of personas) {
    out.push(p.key, p.displayName);
    const first = p.displayName.trim().split(/\s+/)[0];
    if (first) out.push(first);
    for (const h of Object.values(p.handles)) if (h) out.push(h);
  }
  return out;
}
