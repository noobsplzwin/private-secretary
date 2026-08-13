import { describe, it, expect } from "vitest";
import { buildPersonaResolver, draftActions, type LlmCaller } from "./draft.js";
import { buildDraftRequest } from "./draft-prompt.js";
import type { DraftedAction } from "./draft-prompt.js";
import type { InboundMessage, Persona } from "../core/types.js";

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: "slack:C1:1.0",
    platform: "slack",
    senderHandle: "UMICHAEL",
    timestampMs: 1781000000000,
    text: "what supply should we spec for rev5?",
    source: "slack:C1",
    isDirectMessage: true,
    mentionsUser: true,
    isReplyInUserThread: false,
    recipientsIncludeUser: false,
    threadAnsweredByUserAfter: false,
    ...over,
  };
}

const michael: Persona = {
  key: "michael-dobosz",
  displayName: "Michael Dobosz",
  relationship: "embedded co-lead",
  handles: { slack: "UMICHAEL", gmail: "michael@taiv.tv" },
  language: "en",
  register: "casual",
  toneNotes: "terse, dry humor",
  context: "rev5 planning",
};

describe("buildDraftRequest (pure prompt)", () => {
  it("includes persona, messages, and the tool name", () => {
    const req = buildDraftRequest({ persona: michael, messages: [msg()], knownPersonaKeys: ["michael-dobosz"] });
    expect(req.system).toContain("personal secretary");
    expect(req.userText).toContain("Michael Dobosz");
    expect(req.userText).toContain("what supply should we spec");
    expect(req.userText).toContain("michael-dobosz"); // known persona keys hint
    expect(req.toolName).toBe("emit_action_items");
    expect((req.toolInputSchema as { required: string[] }).required).toContain("actions");
  });

  it("flags a new contact when persona is null", () => {
    const req = buildDraftRequest({ persona: null, messages: [msg()], knownPersonaKeys: [] });
    expect(req.userText).toContain("new contact");
  });

  it("surfaces attachments in the message block", () => {
    const req = buildDraftRequest({
      persona: michael,
      messages: [msg({ text: "", attachments: [{ id: "F1", kind: "image", name: "spec.png" }] })],
      knownPersonaKeys: [],
    });
    expect(req.userText).toContain("image:spec.png");
  });

  it("renders threadContext as background (do-not-re-answer), separate from the new message", () => {
    const req = buildDraftRequest({
      persona: michael,
      messages: [msg({ text: "rev5?", threadContext: "我: 在路上\nMichael: rev5?" })],
      knownPersonaKeys: [],
    });
    expect(req.userText).toContain("recent conversation for context");
    expect(req.userText).toContain("do NOT re-answer");
    expect(req.userText).toContain("在路上"); // the prior turn is present as context
  });

  it("renders each message's own timestamp in its header line", () => {
    const req = buildDraftRequest({ persona: michael, messages: [msg()], knownPersonaKeys: [] });
    expect(req.userText).toContain("(slack, id=slack:C1:1.0, at=2026-06-09T10:13:20.000Z)");
  });

  it("prepends a CURRENT TIME anchor line when now is provided (ISO + local)", () => {
    const req = buildDraftRequest({
      persona: michael,
      messages: [msg()],
      knownPersonaKeys: [],
      now: "2026-07-30T10:52:13.456Z",
      nowLocal: "2026-07-30 18:52 (UTC+08:00)",
    });
    expect(req.userText).toContain(
      "CURRENT TIME: 2026-07-30T10:52:13.456Z (UTC) = local 2026-07-30 18:52 (UTC+08:00)",
    );
    expect(req.userText).toContain("Resolve relative dates");
    // the anchor comes first — before the persona block
    expect(req.userText.indexOf("CURRENT TIME")).toBeLessThan(req.userText.indexOf("SENDER PERSONA"));
  });

  it("omits the CURRENT TIME line entirely when now is absent (no 'undefined')", () => {
    const req = buildDraftRequest({ persona: michael, messages: [msg()], knownPersonaKeys: [] });
    expect(req.userText).not.toContain("CURRENT TIME");
    expect(req.userText).not.toContain("undefined");
  });

  it("anchors calendar dates to the message timestamp + CURRENT TIME, never the model's calendar", () => {
    const req = buildDraftRequest({ persona: michael, messages: [msg()], knownPersonaKeys: [] });
    expect(req.system).toContain("timestamp + the CURRENT TIME anchor");
    expect(req.system).toContain("leave start/end unset");
  });
});

describe("draftActions orchestrator", () => {
  const resolver = buildPersonaResolver([michael]);
  const deps = (llm: LlmCaller) => ({
    llm,
    resolvePersona: resolver.resolve,
    knownPersonaKeys: resolver.keys,
    now: () => "2026-06-14T12:00:00Z",
  });

  it("vision: decodes image attachments and passes their paths to the LLM req", async () => {
    let seen: string[] | undefined;
    const llm: LlmCaller = async (req) => {
      seen = req.imagePaths;
      return [{ action_type: "reply", reason: "saw the spec", confidence: 0.8, draft: "got it", headline: "x", summary: "y" } as DraftedAction];
    };
    const withImage = msg({
      attachments: [{ id: "222", kind: "image", name: "wechat-image local_id=222" }],
    });
    const resolveImages = async () => ["/decoded/ccf.png"];
    await draftActions([withImage], { ...deps(llm), resolveImages });
    expect(seen).toEqual(["/decoded/ccf.png"]);
  });

  it("vision: a failing decode is skipped — draft still proceeds text-only", async () => {
    let seen: string[] | undefined = ["sentinel"];
    const llm: LlmCaller = async (req) => {
      seen = req.imagePaths;
      return [{ action_type: "task", reason: "track", confidence: 0.8, params: { title: "t" }, headline: "x", summary: "y" } as DraftedAction];
    };
    const withImage = msg({ attachments: [{ id: "9", kind: "image", name: "img" }] });
    const resolveImages = async () => { throw new Error("decrypt failed"); };
    const r = await draftActions([withImage], { ...deps(llm), resolveImages });
    expect(seen).toBeUndefined(); // no imagePaths set → text-only
    expect(r.actions).toHaveLength(1); // draft still produced
  });

  it("turns a valid suggested reply into an ActionItem with id + context", async () => {
    const llm: LlmCaller = async () => [
      {
        action_type: "reply",
        target: { platform: "slack", personaKey: "michael-dobosz" },
        reason: "answer the supply question",
        confidence: 0.95,
        draft: "25-30W is fine",
      } as DraftedAction,
    ];
    const r = await draftActions([msg()], deps(llm));
    expect(r.actions).toHaveLength(1);
    const a = r.actions[0]!;
    expect(a.action_type).toBe("reply");
    expect(a.status).toBe("suggested");
    expect(a.id).toBeTruthy();
    expect(a.source_message_id).toBe("slack:C1:1.0");
    expect(a.context?.original_message).toContain("what supply");
    expect(a.context?.sender_handle).toBe("UMICHAEL");
    expect(a.context?.sender_name).toBeUndefined(); // no name resolution in this batch
  });

  it("context carries sender_name when the batch was name-resolved at scan time", async () => {
    const llm: LlmCaller = async () => [
      {
        action_type: "reply",
        target: { platform: "slack", personaKey: "michael-dobosz" },
        reason: "answer the supply question",
        confidence: 0.95,
        draft: "25-30W is fine",
      } as DraftedAction,
    ];
    const r = await draftActions([msg({ senderName: "Michael" })], deps(llm));
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.context?.sender_handle).toBe("UMICHAEL");
    expect(r.actions[0]!.context?.sender_name).toBe("Michael");
  });

  it("a Gmail reply carries the mailbox + thread + Re: subject so the executor can draft it", async () => {
    const llm: LlmCaller = async () => [
      { action_type: "reply", reason: "ack", confidence: 0.7, draft: "Thanks!", headline: "x", summary: "y" },
    ];
    const gmailMsg = msg({
      id: "gmail:abc123",
      platform: "gmail",
      source: "gmail:leo@taiv.tv",
      senderHandle: "alfredo@renesas.com",
      threadId: "T-xyz",
      subject: "xEv proposal",
      messageId: "<orig@renesas.com>",
    });
    const r = await draftActions([gmailMsg], deps(llm));
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.params.mailbox).toBe("leo@taiv.tv");
    expect(r.actions[0]!.params.thread_id).toBe("T-xyz");
    expect(r.actions[0]!.params.subject).toBe("Re: xEv proposal");
    expect(r.actions[0]!.params.in_reply_to).toBe("<orig@renesas.com>");
  });

  it("does not double-prefix Re: on an already-Re: subject", async () => {
    const llm: LlmCaller = async () => [
      { action_type: "reply", reason: "ack", confidence: 0.7, draft: "ok", headline: "x", summary: "y" },
    ];
    const r = await draftActions(
      [msg({ platform: "gmail", source: "gmail:leo@taiv.tv", subject: "Re: already a reply" })],
      deps(llm),
    );
    expect(r.actions[0]!.params.subject).toBe("Re: already a reply");
  });

  it("backfills a task's params.title from headline so it isn't blocked on Needs info", async () => {
    const llm: LlmCaller = async () => [
      // model put the title only in headline, leaving params.title empty
      { action_type: "task", reason: "coordinate the pickup", confidence: 0.7, headline: "与金总定上车地铁站", summary: "s" },
    ];
    const r = await draftActions([msg()], deps(llm));
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.params.title).toBe("与金总定上车地铁站");
  });

  it("threads deps.now into the request as the CURRENT TIME anchor (ISO + local)", async () => {
    let seenUserText = "";
    const llm: LlmCaller = async (req) => {
      seenUserText = req.userText;
      return [];
    };
    await draftActions([msg()], deps(llm)); // deps.now = 2026-06-14T12:00:00Z
    expect(seenUserText).toMatch(/CURRENT TIME: 2026-06-14T12:00:00Z \(UTC\) = local \d{4}-\d{2}-\d{2} \d{2}:\d{2} \([A-Za-z_]+\/[A-Za-z_]+, GMT[+-]\d{2}:\d{2}\)/);
  });

  it("groups a sender's multiple messages into ONE analysis", async () => {
    const calls: number[] = [];
    const llm: LlmCaller = async (req) => {
      calls.push(req.userText.length);
      return [{ action_type: "task", reason: "track", confidence: 0.9, params: { title: "x" } } as DraftedAction];
    };
    await draftActions(
      [msg({ id: "m1", text: "first" }), msg({ id: "m2", text: "second" })],
      deps(llm),
    );
    // one sender → one LLM call covering both messages
    expect(calls).toHaveLength(1);
  });

  it("drops a malformed suggestion (bad action_type) without sinking the batch", async () => {
    const llm: LlmCaller = async () => [
      { action_type: "explode" as never, reason: "x", confidence: 0.9 },
      { action_type: "task", reason: "ok", confidence: 0.9, params: { title: "real" } } as DraftedAction,
    ];
    const r = await draftActions([msg()], deps(llm));
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.action_type).toBe("task");
    expect(r.dropped).toHaveLength(1);
  });

  it("isolates a per-sender LLM error and continues other senders", async () => {
    const llm: LlmCaller = async (req) => {
      if (req.userText.includes("UMICHAEL") || req.userText.includes("Michael")) {
        throw new Error("rate limited");
      }
      return [{ action_type: "task", reason: "ok", confidence: 0.9, params: { title: "t" } } as DraftedAction];
    };
    const r = await draftActions(
      [msg({ senderHandle: "UMICHAEL" }), msg({ senderHandle: "UOTHER", id: "slack:C2:2.0", text: "hi" })],
      deps(llm),
    );
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.sender).toBe("UMICHAEL");
    expect(r.actions).toHaveLength(1); // the other sender still produced one
  });

  it("empty LLM output → no actions, no errors", async () => {
    const llm: LlmCaller = async () => [];
    const r = await draftActions([msg()], deps(llm));
    expect(r.actions).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("empty: lists senders whose LLM call succeeded but suggested zero actions", async () => {
    const llm: LlmCaller = async (req) => {
      if (req.userText.includes("UEMPTY")) return []; // the silent skip
      return [{ action_type: "task", reason: "ok", confidence: 0.9, params: { title: "t" } } as DraftedAction];
    };
    const r = await draftActions(
      [
        msg({ senderHandle: "UEMPTY", id: "slack:C1:1.0", text: "from UEMPTY" }),
        msg({ senderHandle: "UGOOD", id: "slack:C2:2.0", text: "from UGOOD" }),
      ],
      deps(llm),
    );
    expect(r.empty).toEqual(["UEMPTY"]);
    expect(r.actions).toHaveLength(1);
  });

  it("empty: errored senders and validation-dropped senders are NOT 'empty'", async () => {
    const llm: LlmCaller = async (req) => {
      if (req.userText.includes("UFAIL")) throw new Error("boom");
      // UDROP's only suggestion fails validation (bad action_type) → dropped,
      // not empty: the model DID answer, the answer was malformed.
      return [{ action_type: "explode" as never, reason: "x", confidence: 0.9 }];
    };
    const r = await draftActions(
      [
        msg({ senderHandle: "UFAIL", id: "slack:C1:1.0", text: "from UFAIL" }),
        msg({ senderHandle: "UDROP", id: "slack:C2:2.0", text: "from UDROP" }),
      ],
      deps(llm),
    );
    expect(r.empty).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.dropped).toHaveLength(1);
  });

  it("context.sent_at is the newest batch message's timestamp (same pick as source_message_id)", async () => {
    const llm: LlmCaller = async () => [
      { action_type: "task", reason: "ok", confidence: 0.9, params: { title: "t" } } as DraftedAction,
    ];
    const r = await draftActions(
      [
        msg({ id: "m1", text: "first", timestampMs: 1781000000000 }),
        msg({ id: "m2", text: "second", timestampMs: 1781000300000 }),
      ],
      deps(llm),
    );
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.source_message_id).toBe("m2");
    expect(r.actions[0]!.context?.sent_at).toBe(new Date(1781000300000).toISOString());
  });

  it("preserves sender order in output even when LLM calls finish out of order", async () => {
    // Concurrency is bounded but must not reorder output: earlier senders'
    // calls resolve LAST here, yet the result stays in first-seen order.
    const order = ["S1", "S2", "S3"];
    const llm: LlmCaller = async (req) => {
      const idx = order.findIndex((s) => req.userText.includes(`from ${s}`));
      await new Promise((r) => setTimeout(r, (order.length - idx) * 5)); // reversed delays
      return [
        { action_type: "task", reason: "ok", confidence: 0.9, params: { title: order[idx] } } as DraftedAction,
      ];
    };
    const candidates = order.map((s, i) => msg({ senderHandle: s, id: `slack:C:${i}.0`, text: `from ${s}` }));
    const r = await draftActions(candidates, deps(llm));
    expect(r.actions.map((a) => a.params.title)).toEqual(["S1", "S2", "S3"]);
  });

  it("forces a reply's target to the source platform + sender (ignores the model's target)", async () => {
    // Slack message in, but the model wrongly says gmail → must be corrected to slack.
    const llm: LlmCaller = async () => [
      { action_type: "reply", target: { platform: "gmail", personaKey: "someone-else" }, reason: "x", confidence: 0.7, draft: "hi" } as DraftedAction,
    ];
    const r = await draftActions([msg({ platform: "slack", senderHandle: "UMICHAEL" })], deps(llm));
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.target?.platform).toBe("slack"); // source platform
    expect(r.actions[0]!.target?.personaKey).toBe("michael-dobosz"); // the sender
  });

  it("drops relay/forward (cross-platform forwarding disabled)", async () => {
    const llm: LlmCaller = async () => [
      { action_type: "relay", target: { platform: "slack", personaKey: "zech" }, reason: "fwd", confidence: 0.8, draft: "fyi" } as DraftedAction,
      { action_type: "forward", reason: "fwd2", confidence: 0.8, draft: "fyi2" } as DraftedAction,
      { action_type: "task", reason: "keep", confidence: 0.9, params: { title: "t" } } as DraftedAction,
    ];
    const r = await draftActions([msg()], deps(llm));
    expect(r.actions).toHaveLength(1); // only the task survives
    expect(r.actions[0]!.action_type).toBe("task");
    expect(r.dropped[0]!.errors.join(" ")).toMatch(/relay\/forward disabled/);
  });

  it("reply with null recipient still becomes an item (needs-info, not dropped)", async () => {
    const llm: LlmCaller = async () => [
      { action_type: "reply", target: { platform: "slack", personaKey: null }, reason: "x", confidence: 0.7, draft: "hi" } as DraftedAction,
    ];
    const r = await draftActions([msg()], deps(llm));
    expect(r.actions).toHaveLength(1); // validateActionItem accepts it; missingInfo flags later
  });
});

describe("buildPersonaResolver", () => {
  it("indexes every handle → persona, case-insensitive", () => {
    const { resolve, keys } = buildPersonaResolver([michael]);
    expect(resolve("UMICHAEL")?.key).toBe("michael-dobosz");
    expect(resolve("michael@taiv.tv")?.key).toBe("michael-dobosz");
    expect(resolve("UMICHAEL".toLowerCase())?.key).toBe("michael-dobosz");
    expect(resolve("unknown")).toBeNull();
    expect(keys).toEqual(["michael-dobosz"]);
  });

  it("falls back to display name when no handle matches (WeChat senderHandle = name)", () => {
    // WeChat InboundMessage.senderHandle is the display name, but the persona
    // handle is the wxid — handle lookup misses, name fallback resolves it.
    const { resolve } = buildPersonaResolver([michael]);
    expect(resolve("Michael Dobosz")?.key).toBe("michael-dobosz");
    expect(resolve("michael dobosz")?.key).toBe("michael-dobosz"); // case-insensitive
  });
});

describe("draftActions null-tolerance", () => {
  // The model writes explicit nulls for "none" ("draft":null on a calendar
  // action — the 2026-08-02 迪士尼 card). Passing null through used to fail
  // validation and silently kill the card; null now means "absent".
  it("coerces null optional fields to absent instead of failing validation", async () => {
    const llm: LlmCaller = async () => [
      {
        action_type: "calendar",
        reason: "meeting proposed",
        confidence: 0.8,
        params: { title: "迪士尼考察", start: "2026-08-04T09:00:00+08:00", end: "2026-08-04T11:00:00+08:00" },
        draft: null,
        headline: "迪士尼考察安排",
        summary: null,
        next_actions: null,
        project_id: null,
      } as unknown as DraftedAction,
    ];
    const r = await draftActions([msg()], {
      llm,
      resolvePersona: () => null,
      knownPersonaKeys: [],
      now: () => "2026-06-14T12:00:00Z",
    });
    expect(r.actions).toHaveLength(1);
    const a = r.actions[0]!;
    expect(a.action_type).toBe("calendar");
    expect(a.draft).toBeUndefined();
    expect(a.headline).toBe("迪士尼考察安排");
  });
});

describe("draftActions empty-retry (flaky LLM)", () => {
  it("an empty first answer gets exactly one retry; cards on the retry are kept", async () => {
    let calls = 0;
    const llm: LlmCaller = async () => {
      calls++;
      if (calls === 1) return [];
      return [{ action_type: "task", reason: "track", confidence: 0.8, params: { title: "t" }, headline: "x" } as DraftedAction];
    };
    const r = await draftActions([msg()], {
      llm, resolvePersona: () => null, knownPersonaKeys: [], now: () => "2026-06-14T12:00:00Z",
    });
    expect(calls).toBe(2);
    expect(r.actions).toHaveLength(1);
    expect(r.empty).toEqual([]);
  });

  it("two empties in a row = genuinely empty (recorded once, exactly 2 calls)", async () => {
    let calls = 0;
    const llm: LlmCaller = async () => { calls++; return []; };
    const r = await draftActions([msg()], {
      llm, resolvePersona: () => null, knownPersonaKeys: [], now: () => "2026-06-14T12:00:00Z",
    });
    expect(calls).toBe(2);
    expect(r.actions).toEqual([]);
    expect(r.empty).toEqual(["UMICHAEL"]);
  });

  it("a non-empty first answer does NOT retry", async () => {
    let calls = 0;
    const llm: LlmCaller = async () => { calls++; return [{ action_type: "task", reason: "t", confidence: 0.8, params: { title: "t" }, headline: "x" } as DraftedAction]; };
    const r = await draftActions([msg()], {
      llm, resolvePersona: () => null, knownPersonaKeys: [], now: () => "2026-06-14T12:00:00Z",
    });
    expect(calls).toBe(1);
    expect(r.actions).toHaveLength(1);
  });
});

describe("owner timezone anchors the clock", () => {
  const resolver = buildPersonaResolver([michael]);

  // The anchor used to come from the machine's offset. Same thing at home,
  // wrong the moment the owner travels or this runs on a server — and a wrong
  // anchor makes every "tomorrow 9am" resolve to the wrong day, silently.
  it("renders the clock line in the configured zone, naming it", async () => {
    let seen = "";
    await draftActions([msg()], {
      llm: async (req) => {
        seen = req.userText;
        return [];
      },
      resolvePersona: resolver.resolve,
      knownPersonaKeys: resolver.keys,
      ownerTimeZone: "Europe/Lisbon",
      now: () => "2026-06-14T12:00:00Z",
    });
    expect(seen).toContain("Europe/Lisbon");
    expect(seen).toContain("2026-06-14 13:00");
  });
});

describe("answered threads: mined for commitments, never re-replied", () => {
  const resolver = buildPersonaResolver([michael]);
  const deps = (llm: LlmCaller) => ({
    llm,
    resolvePersona: resolver.resolve,
    knownPersonaKeys: resolver.keys,
    now: () => "2026-06-14T12:00:00Z",
  });

  // 1,550 messages were discarded before analysis purely because Leo had spoken
  // last — and that is exactly where his own commitments live ("好", "我去订",
  // a confirmed appointment). They are analysed now.
  it("keeps a task the model found in a thread Leo already answered", async () => {
    const llm: LlmCaller = async () => [
      {
        action_type: "task",
        reason: "he committed to booking it",
        confidence: 0.9,
        params: { title: "订机票" },
      } as DraftedAction,
    ];
    const r = await draftActions([msg({ threadAnsweredByUserAfter: true })], deps(llm));
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.action_type).toBe("task");
  });

  // REGRESSION: the deterministic half of the rule. The prompt is told not to
  // draft a reply here, but a prompt is not enforcement, and re-drafting a
  // reply to a conversation Leo already finished is the most irritating false
  // positive there is.
  it("DROPS a reply the model produced anyway, keeping the task beside it", async () => {
    const llm: LlmCaller = async () => [
      { action_type: "reply", reason: "answer him", confidence: 0.95, draft: "got it" } as DraftedAction,
      { action_type: "task", reason: "track", confidence: 0.9, params: { title: "订机票" } } as DraftedAction,
    ];
    const r = await draftActions([msg({ threadAnsweredByUserAfter: true })], deps(llm));
    expect(r.actions.map((a) => a.action_type)).toEqual(["task"]);
    expect(r.dropped[0]!.errors.join()).toContain("already replied");
  });

  it("drops it for the last-sender signal too, not just the in-thread one", async () => {
    const llm: LlmCaller = async () => [
      { action_type: "reply", reason: "r", confidence: 0.9, draft: "d" } as DraftedAction,
    ];
    const r = await draftActions([msg({ userIsLastSenderInChannel: true })], deps(llm));
    expect(r.actions).toHaveLength(0);
  });

  it("still allows a reply on a thread Leo has NOT answered", async () => {
    const llm: LlmCaller = async () => [
      { action_type: "reply", reason: "r", confidence: 0.9, draft: "d" } as DraftedAction,
    ];
    const r = await draftActions([msg()], deps(llm));
    expect(r.actions.map((a) => a.action_type)).toEqual(["reply"]);
  });
});

// The routing rule these pin is prompt-level, so the tests are too: there is no
// deterministic way for core to decide whether something is engineering work.
// What they DO prevent is the rule being silently dropped by a later edit — the
// owner rejected five cards for exactly this ("这个应该创建Jira").
describe("task vs tool routing lives in the prompt", () => {
  it("draft states that WHO DOES THE WORK decides ticket vs task", () => {
    const req = buildDraftRequest({ persona: michael, messages: [msg()], knownPersonaKeys: [] });
    expect(req.system).toContain("WHO DOES THE WORK");
    expect(req.system).toContain("ENGINEERING EXECUTION");
    // and that Leo's own work is NOT a ticket
    expect(req.system).toMatch(/paying an invoice/);
  });

  it("draft forbids a guessed assignee", () => {
    const req = buildDraftRequest({ persona: michael, messages: [msg()], knownPersonaKeys: [] });
    expect(req.system).toMatch(/ONLY when the thread names the person/);
  });

  it("draft lists the connected tool keys so params.tool is not guessed", () => {
    const req = buildDraftRequest({
      persona: michael,
      messages: [msg()],
      knownPersonaKeys: [],
      toolKeys: ["jira", "ticktick"],
    });
    // draft puts the tool keys in the SYSTEM prompt (refresh puts them in userText)
    expect(req.system).toContain("jira, ticktick");
  });
});
