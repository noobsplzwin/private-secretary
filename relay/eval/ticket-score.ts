// Ticket quality bench: can the brain turn a conversation into a ticket the
// assignee can act on without asking anyone anything?
//
// The surface does not matter here. Jira and TickTick are both just MCPs; what
// is being measured is whether the READING of the thread was good enough:
//
//   1. did it decide a ticket is owed at all
//   2. did it name the right assignee, or refuse to name one (ASK-not-GUESS)
//   3. does the body carry the facts that exist ONLY in the chat — the verbatim
//      log signatures, the four log types, the eMMC constraint, the doc link
//   4. does it carry the JUDGEMENT — when Bluetooth recovery is worth it, the
//      agent guardrails, what the first deliverable is
//   5. did it leave the strategy padding out (owner, 2026-09-09: 「删除掉所有冗余,
//      对Zack工作没有必要的信息」)
//
// Ground truth is the two tickets the owner reviewed, corrected and kept:
// TAIV-7049 and TAIV-7050. His edits ARE the rubric.

export interface TicketCase {
  id: string;
  /** The persona whose thread this is. */
  personaKey: string;
  /** Frozen conversation, the production corpus rendering. */
  corpus: string;
  /**
   * Who the thread names as the owner of the work.
   *
   * `name` is the JIRA DISPLAY NAME, because that is what the field actually
   * holds: params.assignee is free text matched against real Jira accounts by
   * exact display name (core/jira-assignee.ts). An address is accepted too via
   * `alsoAccept` — the point is to catch a DIFFERENT PERSON, not a different
   * spelling. Requiring the email scored 「Ihor Kachura」 as wrong on
   * 2026-09-10 and nearly sent me rewriting the prompt over it.
   */
  assignee: { name: string; alsoAccept?: string[] };
  /**
   * Facts that exist only in the chat. A ticket missing one sends the assignee
   * back to Slack, which is the failure this bench measures.
   */
  mustCarry: Array<{ label: string; anyOf: string[] }>;
  /** Framing the owner struck out. Present = the ticket is padded. */
  mustOmit?: Array<{ label: string; anyOf: string[] }>;
  /** His reviewed tickets land near 1,800 characters. */
  maxChars?: number;
}

/** What the brain produced, narrowed to what scoring needs. */
export interface DraftedTicket {
  tool?: string;
  project?: string;
  summary?: string;
  description?: string;
  assignee?: string;
}

export interface TicketVerdict {
  id: string;
  /** Did it decide a ticket is owed at all? */
  ticketed: boolean;
  /** right = the thread's named owner; wrong = someone else; absent = refused to guess. */
  assignee: "right" | "wrong" | "absent";
  carried: string[];
  missing: string[];
  padded: string[];
  chars: number;
  tooLong: boolean;
  /** A ticket the assignee could act on unaided. */
  pass: boolean;
}

const fold = (s: string): string => s.toLowerCase().replace(/\s+/g, " ");

/** Present if ANY of the phrasings appears — the model may word it its own way. */
function present(haystack: string, anyOf: readonly string[]): boolean {
  const h = fold(haystack);
  return anyOf.some((p) => h.includes(fold(p)));
}

export function scoreTicket(c: TicketCase, drafted: readonly DraftedTicket[]): TicketVerdict {
  const ticket = drafted.find((d) => (d.tool ?? "").toLowerCase() === "jira");
  const body = [ticket?.summary, ticket?.description].filter(Boolean).join("\n");

  const carried: string[] = [];
  const missing: string[] = [];
  for (const f of c.mustCarry) (present(body, f.anyOf) ? carried : missing).push(f.label);

  const padded = (c.mustOmit ?? []).filter((f) => present(body, f.anyOf)).map((f) => f.label);

  // An assignee the thread never named is worse than none: ASK-not-GUESS holds
  // here exactly as it does for recipients.
  const accepted = [c.assignee.name, ...(c.assignee.alsoAccept ?? [])];
  const assignee: TicketVerdict["assignee"] = !ticket?.assignee
    ? "absent"
    : accepted.some((a) => fold(ticket.assignee!).includes(fold(a)))
      ? "right"
      : "wrong";

  const chars = body.length;
  const tooLong = c.maxChars !== undefined && chars > c.maxChars;

  return {
    id: c.id,
    ticketed: !!ticket,
    assignee,
    carried,
    missing,
    padded,
    chars,
    tooLong,
    pass: !!ticket && assignee === "right" && missing.length === 0 && padded.length === 0 && !tooLong,
  };
}
