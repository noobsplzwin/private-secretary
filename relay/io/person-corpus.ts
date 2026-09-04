// One person's recent traffic across every source their handles reach,
// assembled BY HANDLE — no open card required. Extracted from
// scripts/audit-ledger.ts the moment a second caller (commitment seeding)
// needed it; run-notify's rep-card variant merges here in phase 4 of
// specs/person-first-consolidation.md.
//
// Slices are labelled and every line dated, because relative dates must anchor
// to the line that says them. A failing slice is skipped — partial context
// beats none.

import { GmailClient, getHeader } from "./gmail-api.js";
import { KNOWN_MAILBOXES } from "./google-oauth.js";
import { extractText } from "../sources/gmail-direct.js";
import { wechatHistory } from "./wechat-cli.js";
import { createSlackClientFromKeychain, SLACK_ACCOUNTS, type SlackClient } from "./slack-api.js";

export interface PersonHandles {
  slack?: string | null;
  gmail?: string | null;
  wechat?: string | null;
}

export interface SlackDmIndex {
  client: SlackClient;
  byUser: Map<string, string>;
  /**
   * The OWNER's own user id in this workspace (auth.test). Without it the
   * corpus labels his own Slack messages with a raw id, so a reader — human or
   * mechanical — cannot tell who spoke. That is the difference between "I
   * promised this" and "they promised this", and it is the single most
   * important fact on the line.
   */
  selfId?: string;
}

/**
 * How the corpus names the owner on every line he spoke. WeChat already emits
 * this; Slack and Gmail are normalised onto it so one speaker rule covers all
 * three dialects. Anything else on a line is the other party — or, when the
 * source cannot say (a Gmail body line carries no speaker), unknown.
 */
export const OWNER_LABEL = "me";

const gmailClients = new Map<string, GmailClient>();
function gmailFor(email: string): GmailClient {
  let c = gmailClients.get(email);
  if (!c) {
    c = new GmailClient({ email });
    gmailClients.set(email, c);
  }
  return c;
}

/** DM registry per workspace, built once per run: user id → im channel id. */
export async function slackDmIndexes(): Promise<SlackDmIndex[]> {
  const out: SlackDmIndex[] = [];
  for (const { account } of SLACK_ACCOUNTS) {
    try {
      const client = await createSlackClientFromKeychain({}, account);
      const ims = await client.listAllConversations({ types: "im" });
      const byUser = new Map<string, string>();
      for (const c of ims) if (c.user && c.id) byUser.set(c.user, c.id);
      // auth.test is one cheap call per workspace and is what makes the owner's
      // own lines identifiable. A failure is tolerated: the lines then carry the
      // raw id, exactly as before, and any speaker gate reads them as unknown
      // rather than guessing.
      let selfId: string | undefined;
      try {
        selfId = (await client.authTest()).user_id;
      } catch {
        /* unlabelled owner beats no corpus */
      }
      out.push({ client, byUser, ...(selfId ? { selfId } : {}) });
    } catch {
      /* workspace unreachable — assemble from what we have */
    }
  }
  return out;
}

export async function personCorpus(handles: PersonHandles, dms: SlackDmIndex[]): Promise<string> {
  const slices: string[] = [];

  if (handles.slack) {
    for (const dm of dms) {
      const { client, byUser } = dm;
      const channel = byUser.get(handles.slack);
      if (!channel) continue;
      try {
        const h = await client.conversationsHistory({ channel, limit: 60 });
        const lines = [...(h.messages ?? [])].reverse().map((m) => {
          const ms = m.ts ? Math.round(Number(m.ts) * 1000) : 0;
          const day = ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "?";
          const who = m.user && m.user === dm.selfId ? OWNER_LABEL : (m.user ?? "?");
          return `[${day}] ${who}: ${m.text ?? ""}`;
        });
        if (lines.length) slices.push(`=== slack DM ===\n${lines.join("\n")}`);
      } catch {
        /* skip */
      }
    }
  }

  if (handles.gmail) {
    for (const mailbox of KNOWN_MAILBOXES) {
      try {
        const list = await gmailFor(mailbox).messagesList({
          q: `(from:${handles.gmail} OR to:${handles.gmail}) newer_than:30d`,
          maxResults: 10,
        });
        const threadIds = [...new Set((list.messages ?? []).map((m) => m.threadId))].slice(0, 3);
        for (const id of threadIds) {
          if (!id) continue;
          const t = await gmailFor(mailbox).getThread({ id, format: "full" });
          const text = (t.messages ?? [])
            .map((m) => {
              const ms = Number(m.internalDate ?? 0);
              const day = ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "?";
              // The From header decides the speaker, same rule as Slack. Body
              // lines below carry NO speaker — a quote landing there is
              // attributable to nobody, which a speaker gate must read as
              // unknown rather than guess at.
              const from = getHeader(m.payload, "From") ?? "?";
              const mine = KNOWN_MAILBOXES.some((box) => from.toLowerCase().includes(box.toLowerCase()));
              return `[${day}] ${mine ? OWNER_LABEL : `From ${from}`}:\n${extractText(m)}`;
            })
            .join("\n---\n");
          if (text.trim()) slices.push(`=== gmail (${mailbox}) ===\n${text}`);
        }
      } catch {
        /* skip mailbox */
      }
    }
  }

  if (handles.wechat) {
    try {
      const text = await wechatHistory(handles.wechat, { limit: 80 });
      if (text.trim()) slices.push(`=== wechat ===\n${text}`);
    } catch {
      /* skip */
    }
  }

  return slices.join("\n\n");
}
