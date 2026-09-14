import { describe, it, expect, vi } from "vitest";
import {
  buildRawMimeMessage,
  gmailMessageToInbound,
  pollMailbox,
  scanGmailDirect,
  ownerLastSpokeInThreads,
} from "./gmail-direct.js";
import { encodeBase64Url, type GmailClient, type GmailMessage } from "../io/gmail-api.js";

function makeMessage(over: Partial<GmailMessage> & { from: string; to: string; subject?: string; body?: string; date?: number }): GmailMessage {
  const date = over.date ?? 1781000000000;
  return {
    id: over.id ?? "M1",
    threadId: over.threadId ?? "T1",
    internalDate: String(date),
    snippet: over.snippet,
    payload: {
      headers: [
        { name: "From", value: over.from },
        { name: "To", value: over.to },
        ...(over.subject ? [{ name: "Subject", value: over.subject }] : []),
      ],
      body: over.body ? { data: encodeBase64Url(over.body) } : undefined,
      mimeType: "text/plain",
      parts: over.body
        ? [
            {
              mimeType: "text/plain",
              body: { data: encodeBase64Url(over.body) },
            },
          ]
        : undefined,
    },
    labelIds: ["INBOX", "UNREAD"], // new inbound mail is unread by default (gate added 2026-06-20)
    ...over,
  };
}

function clientStub(overrides: Partial<GmailClient>): GmailClient {
  const noop = vi.fn(async () => {
    throw new Error("not stubbed");
  });
  return {
    getProfile: overrides.getProfile ?? noop,
    historyList: overrides.historyList ?? noop,
    listAllHistory: overrides.listAllHistory ?? noop,
    messagesList: overrides.messagesList ?? noop,
    getMessage: overrides.getMessage ?? noop,
    getThread: overrides.getThread ?? noop,
    getAttachment: overrides.getAttachment ?? noop,
    createDraft: overrides.createDraft ?? noop,
  } as unknown as GmailClient;
}

describe("gmailMessageToInbound — addressing + thread context", () => {
  it("recipientsIncludeUser true when self is in To:", () => {
    const msg = makeMessage({
      from: "alice@x.com",
      to: "Leo Zheng <leo@taiv.tv>, cc-target@x.com",
      body: "hi leo",
    });
    const inbound = gmailMessageToInbound(msg, {
      mailboxEmail: "leo@taiv.tv",
      threadHasSelfReply: false,
      threadLastSenderIsSelf: false,
    });
    expect(inbound.recipientsIncludeUser).toBe(true);
    expect(inbound.senderHandle).toBe("alice@x.com");
    expect(inbound.text).toContain("hi leo");
    expect(inbound.platform).toBe("gmail");
    expect(inbound.id).toBe("gmail:M1");
    expect(inbound.source).toBe("gmail:leo@taiv.tv");
  });

  it("recipientsIncludeUser also true when self is in Cc:", () => {
    const msg: GmailMessage = {
      id: "M2",
      threadId: "T2",
      internalDate: "1781000000000",
      payload: {
        headers: [
          { name: "From", value: "alice@x.com" },
          { name: "To", value: "bob@x.com" },
          { name: "Cc", value: "leo@taiv.tv, dan@x.com" },
        ],
      },
    };
    const inbound = gmailMessageToInbound(msg, {
      mailboxEmail: "leo@taiv.tv",
      threadHasSelfReply: false,
      threadLastSenderIsSelf: false,
    });
    expect(inbound.recipientsIncludeUser).toBe(true);
  });

  it("threadLastSenderIsSelf propagates to userIsLastSenderInChannel + threadAnsweredByUserAfter", () => {
    const msg = makeMessage({ from: "alice@x.com", to: "leo@taiv.tv" });
    const inbound = gmailMessageToInbound(msg, {
      mailboxEmail: "leo@taiv.tv",
      threadHasSelfReply: true,
      threadLastSenderIsSelf: true,
    });
    expect(inbound.userIsLastSenderInChannel).toBe(true);
    expect(inbound.threadAnsweredByUserAfter).toBe(true);
    expect(inbound.isReplyInUserThread).toBe(true);
  });

  it("attachments — collects parts with filename + attachmentId, kind=image for image/*", () => {
    const msg: GmailMessage = {
      id: "M3",
      threadId: "T3",
      internalDate: "1781000000000",
      payload: {
        headers: [
          { name: "From", value: "alice@x.com" },
          { name: "To", value: "leo@taiv.tv" },
        ],
        parts: [
          { mimeType: "text/plain", body: { data: encodeBase64Url("body") } },
          {
            mimeType: "image/png",
            filename: "screenshot.png",
            body: { attachmentId: "ATT-1" },
          },
          {
            mimeType: "application/pdf",
            filename: "spec.pdf",
            body: { attachmentId: "ATT-2" },
          },
          // inline images without filename should NOT be counted
          { mimeType: "image/png", body: { attachmentId: "ATT-inline" } },
        ],
      },
    };
    const inbound = gmailMessageToInbound(msg, {
      mailboxEmail: "leo@taiv.tv",
      threadHasSelfReply: false,
      threadLastSenderIsSelf: false,
    });
    expect(inbound.attachments).toEqual([
      { id: "ATT-1", kind: "image", name: "screenshot.png" },
      { id: "ATT-2", kind: "file", name: "spec.pdf" },
    ]);
  });

  it("falls back to snippet when no text/plain part exists", () => {
    const msg: GmailMessage = {
      id: "M4",
      threadId: "T4",
      internalDate: "1781000000000",
      snippet: "Just a HTML snippet preview",
      payload: {
        headers: [
          { name: "From", value: "alice@x.com" },
          { name: "To", value: "leo@taiv.tv" },
        ],
      },
    };
    const inbound = gmailMessageToInbound(msg, {
      mailboxEmail: "leo@taiv.tv",
      threadHasSelfReply: false,
      threadLastSenderIsSelf: false,
    });
    expect(inbound.text).toBe("Just a HTML snippet preview");
  });
});

describe("pollMailbox — bootstrap path", () => {
  it("with no cursor: getProfile → messages.list → messages.get; advances historyId to profile", async () => {
    const messages: Record<string, GmailMessage> = {
      M1: makeMessage({ id: "M1", threadId: "T1", from: "alice@x.com", to: "leo@taiv.tv", body: "first" }),
      M2: makeMessage({ id: "M2", threadId: "T2", from: "bob@x.com", to: "leo@taiv.tv", body: "second" }),
    };
    const client = clientStub({
      getProfile: vi.fn(async () => ({
        emailAddress: "leo@taiv.tv",
        messagesTotal: 1,
        threadsTotal: 1,
        historyId: "999",
      })),
      messagesList: vi.fn(async () => ({
        messages: [{ id: "M1", threadId: "T1" }, { id: "M2", threadId: "T2" }],
      })),
      getMessage: vi.fn(async ({ id }) => messages[id]!),
      getThread: vi.fn(async ({ id }) => ({
        id,
        messages: [messages[id === "T1" ? "M1" : "M2"]!],
      })),
    });
    const r = await pollMailbox({ client, mailboxEmail: "leo@taiv.tv" });
    expect(r.newHistoryId).toBe("999");
    expect(r.inbound.map((m) => m.id).sort()).toEqual(["gmail:M1", "gmail:M2"]);
  });

  it("excludes non-primary (promo/updates) mail from inbound, surfaces it in filtered", async () => {
    const messages: Record<string, GmailMessage> = {
      M1: makeMessage({ id: "M1", threadId: "T1", from: "alice@x.com", to: "leo@taiv.tv", body: "real", labelIds: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"] }),
      M2: makeMessage({ id: "M2", threadId: "T2", from: "deals@shop.com", to: "leo@taiv.tv", body: "sale", labelIds: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"] }),
      M3: makeMessage({ id: "M3", threadId: "T3", from: "news@x.com", to: "leo@taiv.tv", body: "digest", labelIds: ["UNREAD", "CATEGORY_UPDATES"] }),
    };
    const getThread = vi.fn(async ({ id }: { id: string }) => ({
      id,
      messages: [messages[id === "T1" ? "M1" : id === "T2" ? "M2" : "M3"]!],
    }));
    const client = clientStub({
      getProfile: vi.fn(async () => ({ emailAddress: "leo@taiv.tv", messagesTotal: 1, threadsTotal: 1, historyId: "999" })),
      messagesList: vi.fn(async () => ({
        messages: [{ id: "M1", threadId: "T1" }, { id: "M2", threadId: "T2" }, { id: "M3", threadId: "T3" }],
      })),
      getMessage: vi.fn(async ({ id }) => messages[id]!),
      getThread,
    });
    const r = await pollMailbox({ client, mailboxEmail: "leo@taiv.tv" });
    // only the Primary message is ingested
    expect(r.inbound.map((m) => m.id)).toEqual(["gmail:M1"]);
    // the two non-primary are reported as filtered, with reasons
    expect(r.filtered).toEqual([
      { id: "gmail:M2", reason: "gmail:promotions" },
      { id: "gmail:M3", reason: "gmail:updates" },
    ]);
    // promo mail never triggered a thread fetch (filtered before that work)
    expect(getThread).toHaveBeenCalledTimes(1);
    // cursor still advanced past everything (independent of filtering)
    expect(r.newHistoryId).toBe("999");
  });

  it("excludes already-READ mail (no UNREAD label) — the unread gate (2026-06-20)", async () => {
    const messages: Record<string, GmailMessage> = {
      M1: makeMessage({ id: "M1", threadId: "T1", from: "alice@x.com", to: "leo@taiv.tv", body: "unread one", labelIds: ["INBOX", "UNREAD"] }),
      // Leo already read this one elsewhere → no UNREAD label → must be skipped,
      // even though messageAdded history still surfaced it.
      M2: makeMessage({ id: "M2", threadId: "T2", from: "bob@x.com", to: "leo@taiv.tv", body: "already read", labelIds: ["INBOX"] }),
    };
    const client = clientStub({
      getProfile: vi.fn(async () => ({ emailAddress: "leo@taiv.tv", messagesTotal: 1, threadsTotal: 1, historyId: "999" })),
      messagesList: vi.fn(async () => ({ messages: [{ id: "M1", threadId: "T1" }, { id: "M2", threadId: "T2" }] })),
      getMessage: vi.fn(async ({ id }) => messages[id]!),
      getThread: vi.fn(async ({ id }: { id: string }) => ({ id, messages: [messages[id === "T1" ? "M1" : "M2"]!] })),
    });
    const r = await pollMailbox({ client, mailboxEmail: "leo@taiv.tv" });
    expect(r.inbound.map((m) => m.id)).toEqual(["gmail:M1"]); // read M2 skipped
    expect(r.newHistoryId).toBe("999"); // cursor still advances past the read one
  });

  it("excludes Leo's OWN sent mail (From === mailbox) from inbound", async () => {
    const messages: Record<string, GmailMessage> = {
      M1: makeMessage({ id: "M1", threadId: "T1", from: "alice@x.com", to: "leo@taiv.tv", body: "their msg" }),
      M2: makeMessage({ id: "M2", threadId: "T2", from: "leo@taiv.tv", to: "bob@x.com", body: "my own reply" }),
      // self-to-self (e.g. emailing yourself a scan) — also outgoing
      M3: makeMessage({ id: "M3", threadId: "T3", from: "LEO@taiv.tv", to: "leo@taiv.tv", body: "scan" }),
    };
    const client = clientStub({
      getProfile: vi.fn(async () => ({ emailAddress: "leo@taiv.tv", messagesTotal: 1, threadsTotal: 1, historyId: "999" })),
      messagesList: vi.fn(async () => ({
        messages: [{ id: "M1", threadId: "T1" }, { id: "M2", threadId: "T2" }, { id: "M3", threadId: "T3" }],
      })),
      getMessage: vi.fn(async ({ id }) => messages[id]!),
      getThread: vi.fn(async ({ id }: { id: string }) => ({ id, messages: [messages[id === "T1" ? "M1" : id === "T2" ? "M2" : "M3"]!] })),
    });
    const r = await pollMailbox({ client, mailboxEmail: "leo@taiv.tv" });
    expect(r.inbound.map((m) => m.id)).toEqual(["gmail:M1"]); // only the other person's mail
  });
});

describe("pollMailbox — steady-state delta", () => {
  it("with a cursor: history.list → messages.get for messagesAdded, dedupes by message id", async () => {
    const messages: Record<string, GmailMessage> = {
      M1: makeMessage({ id: "M1", threadId: "T1", from: "alice@x.com", to: "leo@taiv.tv", body: "first" }),
      M2: makeMessage({ id: "M2", threadId: "T1", from: "leo@taiv.tv", to: "alice@x.com", body: "my reply" }),
      M3: makeMessage({ id: "M3", threadId: "T2", from: "carol@x.com", to: "leo@taiv.tv", body: "new" }),
    };
    const client = clientStub({
      listAllHistory: vi.fn(async () => ({
        records: [
          {
            id: "h1",
            messagesAdded: [
              { message: { id: "M3", threadId: "T2" } },
              // duplicate id from another record (label add)
              { message: { id: "M3", threadId: "T2" } },
            ],
          },
        ],
        currentHistoryId: "1000",
      })),
      getMessage: vi.fn(async ({ id }) => messages[id]!),
      getThread: vi.fn(async () => ({
        id: "T2",
        messages: [messages.M3!],
      })),
    });
    const r = await pollMailbox({
      client,
      mailboxEmail: "leo@taiv.tv",
      sinceHistoryId: "900",
    });
    expect(r.newHistoryId).toBe("1000");
    expect(r.inbound).toHaveLength(1);
    expect(r.inbound[0]?.id).toBe("gmail:M3");
  });

  it("respects perPollLimit even when history has more messagesAdded", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `M${i}`);
    const messages: Record<string, GmailMessage> = Object.fromEntries(
      ids.map((id) => [
        id,
        makeMessage({ id, threadId: id, from: "x@x.com", to: "leo@taiv.tv", body: "b" }),
      ]),
    );
    const client = clientStub({
      listAllHistory: vi.fn(async () => ({
        records: [
          {
            id: "h1",
            messagesAdded: ids.map((id) => ({ message: { id, threadId: id } })),
          },
        ],
        currentHistoryId: "X",
      })),
      getMessage: vi.fn(async ({ id }) => messages[id]!),
      getThread: vi.fn(async ({ id }) => ({ id, messages: [messages[id]!] })),
    });
    const r = await pollMailbox({
      client,
      mailboxEmail: "leo@taiv.tv",
      sinceHistoryId: "0",
      perPollLimit: 3,
    });
    expect(r.inbound).toHaveLength(3);
  });

  it("caches thread fetches — same thread across multiple messages = one getThread call", async () => {
    const messages: Record<string, GmailMessage> = {
      M1: makeMessage({ id: "M1", threadId: "T1", from: "alice@x.com", to: "leo@taiv.tv", body: "a" }),
      M2: makeMessage({ id: "M2", threadId: "T1", from: "alice@x.com", to: "leo@taiv.tv", body: "b" }),
    };
    const getThread = vi.fn(async ({ id }) => ({
      id,
      messages: [messages.M1!, messages.M2!],
    }));
    const client = clientStub({
      listAllHistory: vi.fn(async () => ({
        records: [
          {
            id: "h1",
            messagesAdded: [
              { message: { id: "M1", threadId: "T1" } },
              { message: { id: "M2", threadId: "T1" } },
            ],
          },
        ],
        currentHistoryId: "X",
      })),
      getMessage: vi.fn(async ({ id }) => messages[id]!),
      getThread,
    });
    await pollMailbox({
      client,
      mailboxEmail: "leo@taiv.tv",
      sinceHistoryId: "0",
    });
    expect(getThread).toHaveBeenCalledTimes(1);
  });
});

describe("scanGmailDirect — multi-mailbox orchestration", () => {
  it("polls each client, returns flattened inbound + per-mailbox cursors", async () => {
    const mk = (email: string, hid: string, msgId: string): GmailClient =>
      clientStub({
        getProfile: vi.fn(async () => ({
          emailAddress: email,
          messagesTotal: 1,
          threadsTotal: 1,
          historyId: hid,
        })),
        messagesList: vi.fn(async () => ({ messages: [{ id: msgId, threadId: msgId }] })),
        getMessage: vi.fn(async () =>
          makeMessage({
            id: msgId,
            threadId: msgId,
            from: "a@x.com",
            to: email,
            body: "hi",
          }),
        ),
        getThread: vi.fn(async ({ id }) => ({
          id,
          messages: [
            makeMessage({
              id: msgId,
              threadId: msgId,
              from: "a@x.com",
              to: email,
              body: "hi",
            }),
          ],
        })),
      });
    const clients = {
      "leo@taiv.tv": mk("leo@taiv.tv", "111", "MA"),
      "leo@osyx.tech": mk("leo@osyx.tech", "222", "MB"),
    };
    const r = await scanGmailDirect({ clients });
    expect(r.inbound.map((m) => m.id).sort()).toEqual(["gmail:MA", "gmail:MB"]);
    expect(r.nextState.mailboxes).toEqual({
      "leo@taiv.tv": { historyId: "111" },
      "leo@osyx.tech": { historyId: "222" },
    });
  });

  it("isolates a failing mailbox: healthy mailboxes still scan + advance, failure reported", async () => {
    const good = clientStub({
      getProfile: vi.fn(async () => ({
        emailAddress: "leo@taiv.tv",
        messagesTotal: 1,
        threadsTotal: 1,
        historyId: "111",
      })),
      messagesList: vi.fn(async () => ({ messages: [{ id: "MA", threadId: "MA" }] })),
      getMessage: vi.fn(async () =>
        makeMessage({ id: "MA", threadId: "MA", from: "a@x.com", to: "leo@taiv.tv", body: "hi" }),
      ),
      getThread: vi.fn(async ({ id }) => ({
        id,
        messages: [makeMessage({ id: "MA", threadId: "MA", from: "a@x.com", to: "leo@taiv.tv", body: "hi" })],
      })),
    });
    const bad = clientStub({
      getProfile: vi.fn(async () => {
        throw new Error("token expired");
      }),
    });
    const r = await scanGmailDirect({ clients: { "leo@taiv.tv": good, "leo@osyx.tech": bad } });
    expect(r.inbound.map((m) => m.id)).toEqual(["gmail:MA"]); // healthy mailbox scanned
    expect(r.errors).toEqual([{ mailbox: "leo@osyx.tech", error: "token expired" }]);
    expect(r.nextState.mailboxes["leo@taiv.tv"]).toEqual({ historyId: "111" }); // advanced
    expect(r.nextState.mailboxes["leo@osyx.tech"]).toBeUndefined(); // failed, not advanced
  });
});

describe("buildRawMimeMessage", () => {
  it("assembles RFC 5322 headers and base64url-encodes the whole message", () => {
    const raw = buildRawMimeMessage({
      from: "leo@taiv.tv",
      to: "alice@example.com",
      subject: "Hello",
      body: "Body line 1\nBody line 2",
      inReplyTo: "<abc@gmail>",
    });
    // decode and inspect
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const decoded = Buffer.from(padded + pad, "base64").toString("utf8");
    expect(decoded).toContain("From: leo@taiv.tv");
    expect(decoded).toContain("To: alice@example.com");
    expect(decoded).toContain("Subject: Hello");
    expect(decoded).toContain("In-Reply-To: <abc@gmail>");
    expect(decoded).toContain("\r\n\r\nBody line 1\nBody line 2");
  });
});

describe("pollMailbox — self-sent mail", () => {
  it("From === mailbox is dropped AND recorded as filtered gmail:self (was a silent continue)", async () => {
    const messages: Record<string, GmailMessage> = {
      M1: makeMessage({ id: "M1", threadId: "T1", from: "leo@taiv.tv", to: "leo@taiv.tv", body: "note to self", labelIds: ["INBOX", "UNREAD"] }),
    };
    const client = clientStub({
      getProfile: vi.fn(async () => ({ emailAddress: "leo@taiv.tv", messagesTotal: 1, threadsTotal: 1, historyId: "999" })),
      messagesList: vi.fn(async () => ({ messages: [{ id: "M1", threadId: "T1" }] })),
      getMessage: vi.fn(async ({ id }) => messages[id]!),
      getThread: vi.fn(async ({ id }) => ({ id, messages: [messages.M1!] })),
    });
    const r = await pollMailbox({ client, mailboxEmail: "leo@taiv.tv" });
    expect(r.inbound).toEqual([]);
    expect(r.filtered).toEqual([{ id: "gmail:M1", reason: "gmail:self" }]);
    expect(r.newHistoryId).toBe("999"); // cursor still advances
  });
});

describe("ownerLastSpokeInThreads (answered-closes on Gmail)", () => {
  const msg = (from: string, ms: number) => ({ id: String(ms), threadId: "t1", internalDate: String(ms), payload: { headers: [{ name: "From", value: from }] } });
  const client = (owned: Record<string, any[]>) =>
    ({ getThread: async ({ id }: { id: string }) => { if (!(id in owned)) throw new Error("404"); return { id, messages: owned[id] }; } }) as any;

  it("finds the owning mailbox and the owner's latest message in the thread", async () => {
    const clients = {
      "leo@taiv.tv": client({}),
      "zhenghleo@gmail.com": client({ t1: [msg("João <joao@osyx.tech>", 100), msg("Leo <zhenghleo@gmail.com>", 200), msg("João <joao@osyx.tech>", 300)] }),
    };
    const m = await ownerLastSpokeInThreads(clients, ["t1"]);
    expect(m.get("t1")).toBe(200);
  });

  it("omits a thread the owner never wrote in", async () => {
    const m = await ownerLastSpokeInThreads({ "leo@taiv.tv": client({ t1: [msg("x@y.z", 100)] }) }, ["t1"]);
    expect(m.has("t1")).toBe(false);
  });

  it("omits a thread no mailbox can read", async () => {
    const m = await ownerLastSpokeInThreads({ "leo@taiv.tv": client({}) }, ["t1"]);
    expect(m.size).toBe(0);
  });
});
