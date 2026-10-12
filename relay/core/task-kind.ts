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

/** Kinds that are finished by talking. Never a row. */
const CHAT_ONLY: ReadonlySet<string> = new Set<TaskKind>(["reply", "schedule"]);

export const TASK_KIND_RULE = `kind — what FINISHING it takes. Required on every task:
  "deliver"  a THING changes hands: a file, schematic, document, sample, signed
             contract, shipment. 「发WiFi模组原理图给CTL Amy」, 「签字盖章新合同寄回」.
  "pay"      money moves: pay, refund, issue an invoice. 「确认芯片PI金额并安排付款」.
  "decide"   a choice only Leo can make, with stakes: vendor, terms, which template,
             approve a report. 「回复金小奇：拨改投转股模板选哪个」 is a decision.
  "work"     hands-on work by Leo: review a document, test, write, prepare a deck.
  "reply"    the whole job is WORDS to someone: answer, confirm, ask, tell, remind,
             pass information along, call back. 「确认周一会议是否逐条讲SoW」,
             「问货代能否接香港货运」, 「给Neil回电话讨论方案」, 「Route the request
             to Sandro」.
  "schedule" agreeing a time or place. 「问马总下周是否有空，回杜维定时间」.
  A reply that WRAPS real work takes the work's kind: 「审核付款方案并回复金小奇」
  is work. "reply" and "schedule" are NOT rows — he does them in the chat, and
  code drops the card. Do not dress a reply up as another kind to keep it.`;

/** True when the drafter says this task is finished by a message or a time agreed. */
export function isChatOnlyTask(params: Record<string, unknown> | undefined): boolean {
  const k = params?.kind;
  return typeof k === "string" && CHAT_ONLY.has(k.trim().toLowerCase());
}
