import { fold, quoteLongEnough } from "./corpus-lines.js";
import type { InboundMessage } from "./types.js";

// WHAT FINISHING A TASK TAKES — and the two answers that earn no row.
//
// The owner, twice: 「你不能每收到一句话，就让我回复建立一个Ticket」 (2026-10-09)
// and 「你还是会因为我随便收到一条信息，就创建一个"确认xxx"，"回复xxx" Ticket」
// (2026-10-12). Of the 21 card rows open that day, most were a sentence he owed
// someone — 「确认周一会议是否逐条讲SoW」, 「问马总下周是否有空，回杜维定时间」,
// 「给Neil回电话讨论AGV安全套件方案」. A reply is done in the chat it came from;
// a ticket for it is a second inbox. The prompt rule alone never held — the
// list kept filling — so the drafter NAMES the kind and code drops it.

export const TASK_KINDS = ["deliver", "pay", "decide", "work", "reply", "schedule"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/**
 * Kinds that never make a row: finished by talking, or by making up his mind.
 * "decide" joined 2026-10-18 — 「你又加入了过多确认xxx，决定xxx，这种不需要和别人
 * 交互做什么的事情」: seven 决定/Decide rows were on his list that day.
 */
const CHAT_ONLY: ReadonlySet<string> = new Set<TaskKind>(["reply", "schedule", "decide"]);

export const TASK_KIND_RULE = `kind — what FINISHING it takes. Required on every task:
  "deliver"  a THING changes hands: a file, schematic, document, sample, signed
             contract, shipment. 「发WiFi模组原理图给CTL Amy」, 「签字盖章新合同寄回」.
  "pay"      money moves: pay, refund, issue an invoice. 「确认芯片PI金额并安排付款」.
  "decide"   a choice he makes in his head: which vendor, which template, whether
             to order, approve a report, 确认/决定/Decide anything. 「决定PCB现金流解决
             方案」, 「Decide: team places 300-unit board order?」. He decides when
             the topic comes up; a row for it is noise.
  "work"     hands-on work by Leo: review a document, test, write, prepare a deck.
  "reply"    the whole job is WORDS to someone: answer, confirm, ask, tell, remind,
             pass information along, call back. 「确认周一会议是否逐条讲SoW」,
             「问货代能否接香港货运」, 「给Neil回电话讨论方案」, 「Route the request
             to Sandro」.
  "schedule" agreeing a time or place. 「问马总下周是否有空，回杜维定时间」.
  A reply that WRAPS real work takes the work's kind: 「审核付款方案并回复金小奇」
  is work, 「确认PI金额并付款」 is pay. "reply", "schedule" and "decide" are NOT
  rows — he does them in the chat or in his head, and code drops the card. Do not
  dress one up as another kind to keep it: reviewing a draft to decide on it is
  still "decide".`;

/** True when the drafter says this task is finished by a message or a time agreed. */
export function isChatOnlyTask(params: Record<string, unknown> | undefined): boolean {
  const k = params?.kind;
  return typeof k === "string" && CHAT_ONLY.has(k.trim().toLowerCase());
}

// ── HIS COMMITMENT ───────────────────────────────────────────────────────
// Owner, 2026-10-27: 「你生成了很多check的task，这些都是完全不需要的…只生成我有
// Committment的task」. That day he struck 「拆机排查异响盒子风扇卡滞」,
// 「测试按键/ADB能否切到RK通道」, 「开发测坡度功能」 — work someone raised, that he
// never took on. A task now carries the words in which HE took it on, and code
// finds them in one of his own lines. A commitment he makes later, in a reply
// after this batch, is the person pass's to record (core/ledger-list.ts
// inHisOwnWords) — that pass reads his lines, this one cannot yet.

export const COMMITMENT_RULE = `commitment — REQUIRED on every task: VERBATIM words from one of LEO'S
  OWN lines (marked 我 / me) in which he took this on: 「这个我找时间寄一个」,
  「我晚上到家发您」, 「I'll send it tonight」, 「好，我来付」. Someone asking,
  suggesting, reporting a problem or assigning work does NOT give Leo a task
  until he says he will do it. No such line in what you were shown → emit no
  task; code drops a task whose words are not in his own line.`;

const OWNER_LINE = /^(?:我|me)\s*[:：]\s*/i;

/** His own lines in a batch: the 我/me lines of its thread context, and an ownerOnly message's text. */
export function hisLines(batch: readonly Pick<InboundMessage, "text" | "threadContext" | "ownerOnly">[]): string[] {
  const out: string[] = [];
  for (const m of batch) {
    for (const l of (m.threadContext ?? "").split("\n")) if (OWNER_LINE.test(l.trim())) out.push(l.trim().replace(OWNER_LINE, ""));
    if (m.ownerOnly) out.push(...m.text.split("\n").map((l) => l.trim()).filter(Boolean));
  }
  return out;
}

/** Did he take this task on, in words found in one of his own lines? */
export function committedInHisWords(params: Record<string, unknown> | undefined, lines: readonly string[]): boolean {
  const q = typeof params?.commitment === "string" ? fold(params.commitment) : "";
  // Longer than the closure bar: 「好」 or 「ok」 is an answer, not an undertaking.
  const enough = quoteLongEnough(q) && q.length >= (/[一-鿿]/.test(q) ? 4 : 8);
  return enough && lines.some((l) => fold(l).includes(q));
}
