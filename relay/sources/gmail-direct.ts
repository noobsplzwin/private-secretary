// Direct-API Gmail source. Polls one or more mailboxes via GmailClient
// (relay/io/gmail-api.ts) using Gmail's historyId cursor (the canonical
// incremental delta), and emits InboundMessage[] for the trigger filter.
//
// Per-mailbox state lives in GmailPollState.mailboxes[email]:
//   - historyId: server-side cursor. Missing = bootstrap (first poll).
//
// Bootstrap (first poll for a mailbox):
//   1. getProfile() → the current historyId
//   2. messages.list q="newer_than:Nd -in:draft" → seed list of IDs
//   3. messages.get FULL for each → InboundMessage
//   4. save historyId as the cursor (NOT the messages we just saw — Gmail
//      treats historyId as "everything from now onward" and we don't want
//      to re-deliver those on a restart)
//
// Steady-state poll:
//   1. history.list startHistoryId=<saved> historyTypes=messageAdded
//   2. For each new message id, messages.get FULL
//   3. Advance to the current historyId from the response
//
// "Addressed to user":
//   - recipientsIncludeUser = the mailbox email appears in To: or Cc:
//   - mentionsUser = false (Gmail has no @-mentions in this sense)
//   - isDirectMessage = false (email isn't conceptually a DM)
//   - isReplyInUserThread = there's a prior message from self in the same threadId
//   - userIsLastSenderInChannel = the last message in the thread is from self
//   - threadAnsweredByUserAfter = same as above for now (Gmail isn't
//     thread-bucketed; collapse to the per-thread "user already in chain"
//     signal)

import { encodeBase64Url } from "../io/gmail-api.js";
import type {
  GmailClient,
  GmailMessage,
  GmailMessagePart,
} from "../io/gmail-api.js";
import { getHeader } from "../io/gmail-api.js";
import type { Attachment, InboundMessage } from "../core/types.js";
import { classifyPromo } from "../core/promo-filter.js";

export interface GmailMailboxCursor {
  historyId: string;
}

export interface GmailPollState {
  // Keyed by mailbox email. Missing entry = bootstrap path.
  mailboxes: Record<string, GmailMailboxCursor>;
}

// A message dropped at ingestion (Gmail non-primary category) — id in the
// `gmail:<id>` space so the scan-loop can dedup-mark it seen, plus the reason.
export interface FilteredMessage {
  id: string;
  reason: string;
}

export interface GmailMailboxResult {
  email: string;
  inbound: InboundMessage[];
  // Non-primary mail excluded before the trigger filter (promo/updates/etc).
  filtered: FilteredMessage[];
  newHistoryId: string;
}

export interface GmailPollResult {
  perMailbox: GmailMailboxResult[];
}

// ─── header parsing ────────────────────────────────────────────────

// Gmail puts addresses in headers as a comma-separated list of
// "Name <email>" entries. Pull just the bare emails out, lowercased.
function parseAddresses(header: string | null): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const raw of header.split(",")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // "Name <email>" — pick the part inside <>; fall back to whole token.
    const m = trimmed.match(/<([^>]+)>/);
    const email = (m ? m[1]! : trimmed).trim().toLowerCase();
    if (email) out.push(email);
  }
  return out;
}

function senderEmail(msg: GmailMessage): string {
  const from = getHeader(msg.payload, "From");
  const list = parseAddresses(from);
  return list[0] ?? "";
}

function recipientsForCheck(msg: GmailMessage): string[] {
  const to = parseAddresses(getHeader(msg.payload, "To"));
  const cc = parseAddresses(getHeader(msg.payload, "Cc"));
  return [...to, ...cc];
}

// Walk the payload and produce the plain-text "best effort" body.
// Falls back to the snippet when no text/plain part is present.
export function extractText(msg: GmailMessage): string {
  const collected: string[] = [];
  walk(msg.payload);
  if (collected.length === 0 && msg.snippet) return msg.snippet;
  return collected.join("\n").trim();

  function walk(part: GmailMessagePart | undefined): void {
    if (!part) return;
    if (part.mimeType === "text/plain" && part.body?.data) {
      collected.push(decodeText(part.body.data));
    }
    for (const child of part.parts ?? []) walk(child);
  }
}

function decodeText(b64url: string): string {
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return new TextDecoder().decode(
    new Uint8Array(Buffer.from(padded + pad, "base64")),
  );
}

// Collect attachments by walking payload parts and pulling anything that
// has both a filename and an attachmentId (these are the "real" attached
// files Gmail surfaces).
function collectAttachments(msg: GmailMessage): Attachment[] | undefined {
  const out: Attachment[] = [];
  walk(msg.payload);
  return out.length > 0 ? out : undefined;

  function walk(part: GmailMessagePart | undefined): void {
    if (!part) return;
    if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
      const isImage = (part.mimeType ?? "").startsWith("image/");
      out.push({
        id: part.body.attachmentId,
        kind: isImage ? "image" : "file",
        name: part.filename,
      });
    }
    for (const child of part.parts ?? []) walk(child);
  }
}

// ─── one message → InboundMessage ──────────────────────────────────

interface ConvertOptions {
  mailboxEmail: string;
  threadHasSelfReply: boolean; // does any prior message in this thread come from self
  threadLastSenderIsSelf: boolean; // is the most recent message in the thread from self
}

export function gmailMessageToInbound(
  msg: GmailMessage,
  opts: ConvertOptions,
): InboundMessage {
  const sender = senderEmail(msg);
  const recipients = recipientsForCheck(msg);
  const self = opts.mailboxEmail.toLowerCase();
  const recipientsIncludeUser = recipients.includes(self);
  const text = extractText(msg);
  const attachments = collectAttachments(msg);
  const tsMs = Number(msg.internalDate ?? "0") || 0;
  return {
    id: `gmail:${msg.id}`,
    platform: "gmail",
    senderHandle: sender,
    timestampMs: tsMs,
    text,
    source: `gmail:${opts.mailboxEmail}`,
    isDirectMessage: false,
    mentionsUser: false,
    isReplyInUserThread: opts.threadHasSelfReply,
    recipientsIncludeUser,
    threadAnsweredByUserAfter: opts.threadLastSenderIsSelf,
    userIsLastSenderInChannel: opts.threadLastSenderIsSelf,
    // Reply-routing facts so an approved Gmail reply threads + has a real
    // subject (the executor builds the MIME from these).
    threadId: msg.threadId,
    ...(getHeader(msg.payload, "Subject") ? { subject: getHeader(msg.payload, "Subject")! } : {}),
    ...(getHeader(msg.payload, "Message-ID") ? { messageId: getHeader(msg.payload, "Message-ID")! } : {}),
    ...(attachments ? { attachments } : {}),
  };
}

// ─── thread-context computation ───────────────────────────────────

// Given the full thread, decide whether the user has already replied in
// it and whether the user is the LAST sender. We use the thread's full
// message list rather than fetching the user's own messages separately —
// one API call instead of N.
function threadContext(
  threadMessages: GmailMessage[],
  mailboxEmail: string,
  candidateMessageId: string,
): { hasSelfReply: boolean; lastSenderIsSelf: boolean } {
  const self = mailboxEmail.toLowerCase();
  const sorted = [...threadMessages].sort(
    (a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0),
  );
  let candidateIdx = sorted.findIndex((m) => m.id === candidateMessageId);
  if (candidateIdx < 0) candidateIdx = sorted.length;
  // "hasSelfReply" — for threadAnsweredByUserAfter we want any self-msg
  // AFTER the candidate. For isReplyInUserThread we want any self-msg at
  // all in the thread, which is broader. Use the broader signal here.
  const hasSelfReply = sorted.some((m) => senderEmail(m).toLowerCase() === self);
  const last = sorted[sorted.length - 1];
  const lastSenderIsSelf = last ? senderEmail(last).toLowerCase() === self : false;
  return { hasSelfReply, lastSenderIsSelf };
}

// ─── one-mailbox poll ──────────────────────────────────────────────

export interface MailboxPollOptions {
  client: GmailClient;
  mailboxEmail: string;
  // Prior cursor; missing/empty means bootstrap.
  sinceHistoryId?: string;
  // Bootstrap window if no cursor. Default 7 days — enough to seed
  // "addressed to user" detection, not enough to drown the queue.
  bootstrapWindowDays?: number;
  // Hard cap on messages per poll (across bootstrap or delta). Default
  // 200. Multi-day backlogs converge across rounds rather than one big
  // fetch.
  perPollLimit?: number;
}

export async function pollMailbox(
  opts: MailboxPollOptions,
): Promise<GmailMailboxResult> {
  const { client, mailboxEmail } = opts;
  const limit = opts.perPollLimit ?? 200;
  const bootstrap = !opts.sinceHistoryId;

  let candidateIds: string[];
  let newHistoryId: string;
  if (bootstrap) {
    const days = opts.bootstrapWindowDays ?? 7;
    const profile = await client.getProfile();
    newHistoryId = profile.historyId;
    // Bootstrap seed: pull recent INBOX threads we're addressed in
    // (to:me or cc:me). Drafts excluded. Newer than N days. We page
    // through pageToken until the limit fills.
    const ids: string[] = [];
    let pageToken: string | undefined;
    while (ids.length < limit) {
      const resp = await client.messagesList({
        // Decision (2026-06-20): Gmail detection is UNREAD-gated — seed only
        // unread mail (matches "只处理未读 / 处理完结束未读"). Slack stays cursor-gated
        // (its MCP has no unread interface); WeChat is already unread-gated.
        q: `(to:me OR cc:me) newer_than:${days}d -in:draft -in:trash is:unread`,
        maxResults: Math.min(100, limit - ids.length),
        pageToken,
      });
      for (const m of resp.messages ?? []) ids.push(m.id);
      pageToken = resp.nextPageToken;
      if (!pageToken) break;
    }
    candidateIds = ids;
  } else {
    const { records, currentHistoryId } = await client.listAllHistory({
      startHistoryId: opts.sinceHistoryId!,
      historyTypes: ["messageAdded"],
    });
    newHistoryId = currentHistoryId;
    // messagesAdded carries new arrivals. Dedupe by id since one message
    // can appear in multiple history records (e.g. labelAdded after add).
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const rec of records) {
      for (const added of rec.messagesAdded ?? []) {
        if (!seen.has(added.message.id)) {
          seen.add(added.message.id);
          ids.push(added.message.id);
          if (ids.length >= limit) break;
        }
      }
      if (ids.length >= limit) break;
    }
    candidateIds = ids;
  }

  // Fetch each new message full + walk its thread once for self-reply
  // context. We cache thread fetches per threadId so a thread with N new
  // messages doesn't do N getThread calls.
  const threadCache = new Map<string, GmailMessage[]>();
  const inbound: InboundMessage[] = [];
  const filtered: FilteredMessage[] = [];
  for (const id of candidateIds) {
    let msg: GmailMessage;
    try {
      msg = await client.getMessage({ id, format: "full" });
    } catch {
      continue; // skip messages that vanished mid-poll
    }
    // Leo's OWN sent mail (From === this mailbox) is outgoing, never inbound —
    // it lands in the mailbox history (SENT folder, or a self-to-self) and must
    // not originate an action item (mirrors the Slack selfId / WeChat `me:`
    // exclusion). Without this, removing the addressed-to-user trigger gate let
    // Leo's own replies become "track" tasks. The cursor still advances past it.
    // Recorded as filtered ("gmail:self") — the bare `continue` made self-sent
    // test mail vanish with zero trace (2026-08-02: 'why no draft from my
    // email?' was undebuggable until code-reading).
    if (senderEmail(msg).toLowerCase() === mailboxEmail.toLowerCase()) {
      filtered.push({ id: `gmail:${msg.id}`, reason: "gmail:self" });
      continue;
    }
    // Unread gate (decision 2026-06-20): the messageAdded history path can return
    // mail Leo has since READ elsewhere, and we only want unread. Confirm the
    // CURRENT labels still include UNREAD; a read message is "handled" → skip.
    // The cursor (newHistoryId) still advances, so it won't be re-evaluated.
    if (!(msg.labelIds ?? []).includes("UNREAD")) {
      continue;
    }
    // Primary-only gate: drop non-primary (promo/updates/social/forums) mail
    // BEFORE the thread fetch + intent analysis. Cursor still advances past it
    // (newHistoryId is independent), so it is never re-evaluated.
    const promo = classifyPromo({ labelIds: msg.labelIds });
    if (promo.filtered) {
      filtered.push({ id: `gmail:${msg.id}`, reason: promo.reason! });
      continue;
    }
    if (!threadCache.has(msg.threadId)) {
      try {
        const t = await client.getThread({ id: msg.threadId, format: "full" });
        threadCache.set(msg.threadId, t.messages ?? [msg]);
      } catch {
        threadCache.set(msg.threadId, [msg]);
      }
    }
    const threadMsgs = threadCache.get(msg.threadId)!;
    const { hasSelfReply, lastSenderIsSelf } = threadContext(
      threadMsgs,
      mailboxEmail,
      msg.id,
    );
    inbound.push(
      gmailMessageToInbound(msg, {
        mailboxEmail,
        threadHasSelfReply: hasSelfReply,
        threadLastSenderIsSelf: lastSenderIsSelf,
      }),
    );
  }

  return { email: mailboxEmail, inbound, filtered, newHistoryId };
}

// ─── multi-mailbox scan ────────────────────────────────────────────

export interface GmailScanOptions {
  // Map of email -> client. Caller wires this up (one per Keychain bundle).
  clients: Record<string, GmailClient>;
  state?: GmailPollState;
  bootstrapWindowDays?: number;
  perMailboxLimit?: number;
}

export async function scanGmailDirect(
  opts: GmailScanOptions,
): Promise<{
  inbound: InboundMessage[];
  filtered: FilteredMessage[];
  nextState: GmailPollState;
  raw: GmailPollResult;
  errors: Array<{ mailbox: string; error: string }>;
}> {
  const perMailbox: GmailMailboxResult[] = [];
  const mailboxes: Record<string, GmailMailboxCursor> = {
    ...(opts.state?.mailboxes ?? {}),
  };
  const errors: Array<{ mailbox: string; error: string }> = [];
  for (const [email, client] of Object.entries(opts.clients)) {
    try {
      const result = await pollMailbox({
        client,
        mailboxEmail: email,
        sinceHistoryId: opts.state?.mailboxes[email]?.historyId,
        bootstrapWindowDays: opts.bootstrapWindowDays,
        perPollLimit: opts.perMailboxLimit,
      });
      perMailbox.push(result);
      mailboxes[email] = { historyId: result.newHistoryId };
    } catch (e) {
      // Per-mailbox isolation: one broken mailbox doesn't sink the others
      // and doesn't discard the cursors the healthy mailboxes just advanced.
      errors.push({ mailbox: email, error: (e as Error).message ?? String(e) });
    }
  }
  const inbound = perMailbox.flatMap((m) => m.inbound);
  const filtered = perMailbox.flatMap((m) => m.filtered);
  return { inbound, filtered, nextState: { mailboxes }, raw: { perMailbox }, errors };
}

// ─── helper: build an RFC 5322 message + base64url it for createDraft ─

export interface BuildMimeOptions {
  from: string;
  to: string;
  subject: string;
  body: string; // plain text
  inReplyTo?: string; // RFC 822 Message-ID of the parent (for reply threading)
  references?: string;
}

export function buildRawMimeMessage(opts: BuildMimeOptions): string {
  const headers = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
  ];
  if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) headers.push(`References: ${opts.references}`);
  const msg = headers.join("\r\n") + "\r\n\r\n" + opts.body;
  return encodeBase64Url(msg);
}

/**
 * When the OWNER last wrote in each of these threads. A card carries its
 * threadId (context.thread_ref) but not which of the four mailboxes owns it, so
 * each mailbox is tried in turn and the first that can read the thread is the
 * owner — thread ids are per-mailbox, so a foreign one simply 404s. At most
 * four calls per waiting card, on the 180s Gmail cadence, only while a reply
 * card is open. "From is this mailbox" is the self test, same as the rest of
 * this file.
 */
export async function ownerLastSpokeInThreads(
  clients: Readonly<Record<string, GmailClient>>,
  threadIds: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const id of threadIds) {
    for (const [email, client] of Object.entries(clients)) {
      let thread;
      try {
        thread = await client.getThread({ id, format: "metadata" });
      } catch {
        continue; // not this mailbox's thread
      }
      const self = email.toLowerCase();
      let latest = 0;
      for (const m of thread.messages ?? []) {
        const from = (getHeader(m.payload, "From") ?? "").toLowerCase();
        if (!from.includes(self)) continue;
        const ms = Number(m.internalDate ?? "0") || 0;
        if (ms > latest) latest = ms;
      }
      if (latest > 0) out.set(id, latest);
      break; // the thread was readable here; no other mailbox owns it
    }
  }
  return out;
}
