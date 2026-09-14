import { describe, it, expect, vi } from "vitest";
import { pollChannel, pollResultToInbound, scanSlackDirect, ownerLastSpokeInChannels } from "./slack-direct.js";
import type {
  SlackClient,
  SlackConversation,
  SlackHistoryResponse,
  SlackMessage,
} from "../io/slack-api.js";

// Build a SlackClient stub. Only the methods slack-direct calls need to
// exist; the rest stay as jest.fn() so accidental usage fails loudly.
function clientStub(overrides: Partial<SlackClient>): SlackClient {
  const noop = vi.fn(async () => {
    throw new Error("not stubbed");
  });
  return {
    authTest: overrides.authTest ?? noop,
    conversationsHistory: overrides.conversationsHistory ?? noop,
    conversationsReplies: overrides.conversationsReplies ?? noop,
    listAllReplies: overrides.listAllReplies ?? vi.fn(async () => []),
    listAllConversations: overrides.listAllConversations ?? noop,
    usersInfo: overrides.usersInfo ?? noop,
    downloadFile: overrides.downloadFile ?? noop,
  } as unknown as SlackClient;
}

const SELF = "UPHG4T8R1";

describe("pollChannel — single-channel poll producing ChannelRaw", () => {
  it("orders messages chronologically and sets user_is_last_sender_in_channel from newest", async () => {
    const messages: SlackMessage[] = [
      // Slack returns newest first
      { ts: "300.0", user: SELF, text: "from me — newest" },
      { ts: "200.0", user: "U2", text: "thanks" },
      { ts: "100.0", user: "U2", text: "hi <@UPHG4T8R1>" },
    ];
    const client = clientStub({
      conversationsHistory: vi.fn(
        async () => ({ messages, has_more: false } as SlackHistoryResponse),
      ),
    });
    const channel: SlackConversation = { id: "C1" };
    const result = await pollChannel({ client, selfId: SELF, channel });
    expect(result).not.toBeNull();
    expect(result!.newLastTs).toBe("300.0");
    expect(result!.raw.messages.map((m) => m.ts)).toEqual(["100.0", "200.0", "300.0"]);
    // Self is the most recent sender → all messages in the batch carry the flag
    for (const m of result!.raw.messages) {
      expect(m.user_is_last_sender_in_channel).toBe(true);
    }
  });

  it("returns null when conversationsHistory has no messages", async () => {
    const client = clientStub({
      conversationsHistory: vi.fn(
        async () => ({ messages: [], has_more: false } as SlackHistoryResponse),
      ),
    });
    const r = await pollChannel({ client, selfId: SELF, channel: { id: "C1" } });
    expect(r).toBeNull();
  });

  it("passes sinceTs as oldest cursor; '0' is treated as no cursor", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const client = clientStub({
      conversationsHistory: vi.fn(async (args: Record<string, unknown>) => {
        captured.push(args);
        return { messages: [{ ts: "1.0", user: SELF, text: "x" }], has_more: false };
      }) as SlackClient["conversationsHistory"],
    });
    await pollChannel({ client, selfId: SELF, channel: { id: "C1" }, sinceTs: "0" });
    expect(captured[0]?.oldest).toBeUndefined();

    await pollChannel({ client, selfId: SELF, channel: { id: "C1" }, sinceTs: "500.0" });
    expect(captured[1]?.oldest).toBe("500.0");
  });

  it("reconstructs reply_user_ids and user_answered_after from listAllReplies", async () => {
    const messages: SlackMessage[] = [
      { ts: "100.0", user: "U2", text: "question <@UPHG4T8R1>", thread_ts: "100.0", reply_count: 2 },
    ];
    const replies: SlackMessage[] = [
      { ts: "100.0", user: "U2", text: "question" }, // parent
      { ts: "110.0", user: SELF, text: "answered" }, // me
      { ts: "120.0", user: "U3", text: "follow up" },
    ];
    const client = clientStub({
      conversationsHistory: vi.fn(
        async () => ({ messages, has_more: false } as SlackHistoryResponse),
      ),
      listAllReplies: vi.fn(async () => replies),
    });
    const r = await pollChannel({ client, selfId: SELF, channel: { id: "C1" } });
    const m = r!.raw.messages[0]!;
    expect(m.reply_user_ids).toEqual(["U2", SELF, "U3"]);
    expect(m.user_answered_after).toBe(true);
  });

  it("user_answered_after is false when the user's reply ts <= the message ts", async () => {
    const messages: SlackMessage[] = [
      // The "newer" question
      { ts: "200.0", user: "U2", text: "newer Q", thread_ts: "100.0" },
    ];
    const replies: SlackMessage[] = [
      { ts: "100.0", user: "U2", text: "parent" },
      { ts: "150.0", user: SELF, text: "old answer" }, // pre-dates the new question
      { ts: "200.0", user: "U2", text: "newer Q" },
    ];
    const client = clientStub({
      conversationsHistory: vi.fn(
        async () => ({ messages, has_more: false } as SlackHistoryResponse),
      ),
      listAllReplies: vi.fn(async () => replies),
    });
    const r = await pollChannel({ client, selfId: SELF, channel: { id: "C1" } });
    expect(r!.raw.messages[0]!.user_answered_after).toBeUndefined();
  });

  it("drops messages without a user (bot / system events)", async () => {
    const messages: SlackMessage[] = [
      { ts: "100.0", text: "joined the channel" }, // no user
      { ts: "200.0", user: "U2", text: "hi" },
    ];
    const client = clientStub({
      conversationsHistory: vi.fn(
        async () => ({ messages, has_more: false } as SlackHistoryResponse),
      ),
    });
    const r = await pollChannel({ client, selfId: SELF, channel: { id: "C1" } });
    expect(r!.raw.messages.map((m) => m.ts)).toEqual(["200.0"]);
  });

  it("forwards file attachments verbatim (id + name + mimetype)", async () => {
    const messages: SlackMessage[] = [
      {
        ts: "100.0",
        user: "U2",
        text: "",
        files: [{ id: "F1", name: "diagram.png", mimetype: "image/png" }],
      },
    ];
    const client = clientStub({
      conversationsHistory: vi.fn(
        async () => ({ messages, has_more: false } as SlackHistoryResponse),
      ),
    });
    const r = await pollChannel({ client, selfId: SELF, channel: { id: "C1" } });
    expect(r!.raw.messages[0]!.files).toEqual([
      { id: "F1", name: "diagram.png", mimetype: "image/png" },
    ]);
  });
});

describe("pollResultToInbound — DM/MPIM patching", () => {
  it("marks IM channels as isDirectMessage + mentionsUser true", () => {
    const result = {
      selfId: SELF,
      errors: [],
      channels: [
        {
          channel: { id: "D1", is_im: true } as SlackConversation,
          raw: {
            channel_id: "D1",
            messages: [
              { ts: "100.0", user: "U2", text: "hello there" }, // no <@self> literal
            ],
          },
          newLastTs: "100.0",
        },
      ],
    };
    const inbound = pollResultToInbound(result);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.isDirectMessage).toBe(true);
    expect(inbound[0]!.mentionsUser).toBe(true);
  });

  it("drops Leo's OWN messages — they are outgoing, never inbound", () => {
    const result = {
      selfId: SELF,
      errors: [],
      channels: [
        {
          channel: { id: "D1", is_im: true } as SlackConversation,
          raw: {
            channel_id: "D1",
            messages: [
              { ts: "100.0", user: "U2", text: "can you review the PR?" },
              { ts: "101.0", user: SELF, text: "yep on it" }, // Leo's own — must be dropped
            ],
          },
          newLastTs: "101.0",
        },
      ],
    };
    const inbound = pollResultToInbound(result);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.senderHandle).toBe("U2");
    expect(inbound.some((m) => m.senderHandle === SELF)).toBe(false);
  });

  it("MPIMs are isDirectMessage but do NOT force mentionsUser (only literal mention counts)", () => {
    const result = {
      selfId: SELF,
      errors: [],
      channels: [
        {
          channel: { id: "G1", is_mpim: true } as SlackConversation,
          raw: {
            channel_id: "G1",
            messages: [
              { ts: "100.0", user: "U2", text: "yo team" },
              { ts: "101.0", user: "U2", text: `at <@${SELF}>` },
            ],
          },
          newLastTs: "101.0",
        },
      ],
    };
    const inbound = pollResultToInbound(result);
    expect(inbound.every((m) => m.isDirectMessage)).toBe(true);
    expect(inbound[0]!.mentionsUser).toBe(false); // no literal mention
    expect(inbound[1]!.mentionsUser).toBe(true);
  });

  it("public channels: isDirectMessage stays false; mention detection runs via slack-channels normalize", () => {
    const result = {
      selfId: SELF,
      errors: [],
      channels: [
        {
          channel: { id: "C1" } as SlackConversation,
          raw: {
            channel_id: "C1",
            messages: [{ ts: "100.0", user: "U2", text: `hey <@${SELF}>` }],
          },
          newLastTs: "100.0",
        },
      ],
    };
    const inbound = pollResultToInbound(result);
    expect(inbound[0]!.isDirectMessage).toBe(false);
    expect(inbound[0]!.mentionsUser).toBe(true);
  });
});

describe("scanSlackDirect — end-to-end orchestration", () => {
  it("advances per-channel lastTs in the returned state", async () => {
    const channels: SlackConversation[] = [{ id: "C1" }, { id: "C2" }];
    const history: Record<string, SlackMessage[]> = {
      C1: [{ ts: "100.0", user: "U2", text: "hi" }],
      C2: [{ ts: "200.0", user: "U2", text: "yo" }],
    };
    const client = clientStub({
      authTest: vi.fn(async () => ({
        user_id: SELF,
        team: "T",
        user: "leo",
        team_id: "T1",
        url: "",
        is_enterprise_install: false,
      })),
      conversationsHistory: vi.fn(async ({ channel }) => ({
        messages: history[channel] ?? [],
        has_more: false,
      })),
    });
    const r = await scanSlackDirect({ client, channels });
    expect(r.nextState.channels).toEqual({
      C1: { lastTs: "100.0" },
      C2: { lastTs: "200.0" },
    });
    expect(r.inbound.map((m) => m.id).sort()).toEqual([
      "slack:C1:100.0",
      "slack:C2:200.0",
    ]);
  });

  it("preserves cursors for channels with no new messages", async () => {
    const channels: SlackConversation[] = [{ id: "C1" }, { id: "C2" }];
    const client = clientStub({
      authTest: vi.fn(async () => ({
        user_id: SELF,
        team: "T",
        user: "leo",
        team_id: "T1",
        url: "",
        is_enterprise_install: false,
      })),
      conversationsHistory: vi.fn(async ({ channel }) => ({
        messages: channel === "C1" ? [{ ts: "500.0", user: "U2", text: "new" }] : [],
        has_more: false,
      })),
    });
    const r = await scanSlackDirect({
      client,
      channels,
      state: { channels: { C1: { lastTs: "100.0" }, C2: { lastTs: "200.0" } } },
    });
    // C1 advanced; C2 unchanged
    expect(r.nextState.channels).toEqual({
      C1: { lastTs: "500.0" },
      C2: { lastTs: "200.0" },
    });
  });

  it("skips archived channels without hitting conversationsHistory", async () => {
    const historyCalls: string[] = [];
    const channels: SlackConversation[] = [
      { id: "C1", is_archived: true },
      { id: "C2" },
    ];
    const client = clientStub({
      authTest: vi.fn(async () => ({
        user_id: SELF,
        team: "T",
        user: "leo",
        team_id: "T1",
        url: "",
        is_enterprise_install: false,
      })),
      conversationsHistory: vi.fn(async ({ channel }) => {
        historyCalls.push(channel);
        return { messages: [{ ts: "100.0", user: "U2", text: "x" }], has_more: false };
      }),
    });
    await scanSlackDirect({ client, channels });
    expect(historyCalls).toEqual(["C2"]);
  });

  it("isolates a failing channel: healthy channels still poll + advance, failure reported", async () => {
    const channels: SlackConversation[] = [{ id: "C1", is_im: true }, { id: "C2", is_im: true }];
    const client = clientStub({
      authTest: vi.fn(async () => ({
        user_id: SELF,
        team: "T",
        user: "leo",
        team_id: "T1",
        url: "",
        is_enterprise_install: false,
      })),
      conversationsHistory: vi.fn(async ({ channel }) => {
        if (channel === "C1") throw new Error("rate limited");
        return { messages: [{ ts: "200.0", user: "U2", text: "hi" }], has_more: false };
      }),
    });
    const r = await scanSlackDirect({ client, channels });
    expect(r.errors).toEqual([{ channelId: "C1", error: "rate limited" }]);
    expect(r.nextState.channels.C2?.lastTs).toBe("200.0"); // healthy channel advanced
    expect(r.nextState.channels.C1).toBeUndefined(); // failed channel not advanced
  });
});

describe("ownerLastSpokeInChannels (answered-closes on Slack)", () => {
  const fake = (msgs: Record<string, Array<{ user: string; ts: string }>>) =>
    ({
      conversationsHistory: async ({ channel }: { channel: string }) => {
        if (!(channel in msgs)) throw new Error("channel_not_found");
        return { ok: true, messages: msgs[channel] };
      },
    }) as any;

  it("reports the owner's latest message per channel, ignoring others", async () => {
    const m = await ownerLastSpokeInChannels(
      fake({ D1: [{ user: "UME", ts: "1789300000.000100" }, { user: "UJ", ts: "1789300500.000000" }, { user: "UME", ts: "1789300200.000000" }] }),
      "UME", ["D1"], 1789200000000,
    );
    expect(m.get("D1")).toBe(1789300200000);
  });

  it("omits a channel where only the other side spoke", async () => {
    const m = await ownerLastSpokeInChannels(fake({ D1: [{ user: "UJ", ts: "1789300500.000000" }] }), "UME", ["D1"], 0);
    expect(m.has("D1")).toBe(false);
  });

  it("skips a channel this workspace cannot read and keeps going", async () => {
    const m = await ownerLastSpokeInChannels(fake({ D2: [{ user: "UME", ts: "1789300000.000000" }] }), "UME", ["D1", "D2"], 0);
    expect(m.has("D1")).toBe(false);
    expect(m.get("D2")).toBe(1789300000000);
  });
});
