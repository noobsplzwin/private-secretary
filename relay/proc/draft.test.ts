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
    expect(req.system).toContain("michael-dobosz"); // roster rides the cached system prefix
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

  it("turns a valid suggested task into an ActionItem with id + context", async () => {
    const llm: LlmCaller = async () => [
      {
        action_type: "task",
        target: {},
        reason: "Leo owes Michael a spec answer",
        confidence: 0.95,
        params: { title: "回复 Michael 供电规格" },
      } as DraftedAction,
    ];
    const r = await draftActions([msg()], deps(llm));
    expect(r.actions).toHaveLength(1);
    const a = r.actions[0]!;
    expect(a.action_type).toBe("task");
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
        action_type: "task",
        target: {},
        reason: "answer the supply question",
        confidence: 0.95,
        params: { title: "回复 Michael 供电规格" },
      } as DraftedAction,
    ];
    const r = await draftActions([msg({ senderName: "Michael" })], deps(llm));
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.context?.sender_handle).toBe("UMICHAEL");
    expect(r.actions[0]!.context?.sender_name).toBe("Michael");
  });

  // Thread locators ride on EVERY gmail-sourced card now: refresh/persona-update
  // re-read the conversation through thread_id, and the shelved one-click reply
  // button will need mailbox + in_reply_to when it lands.
  it("a gmail-sourced card carries the mailbox + thread + Re: subject", async () => {
    const llm: LlmCaller = async () => [
      { action_type: "task", reason: "ack", confidence: 0.7, params: { title: "回复 Alfredo" }, headline: "x", summary: "y" },
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
      { action_type: "task", reason: "ack", confidence: 0.7, params: { title: "回信" }, headline: "x", summary: "y" },
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

  // reply/relay/forward are ALL retired from production (owner, 2026-08-14:
  // "AI暂时不帮我回复"). The model is told not to emit them, and code enforces
  // it — an owed answer arrives as a `task` instead.
  it("drops reply, relay and forward alike", async () => {
    const llm: LlmCaller = async () => [
      { action_type: "reply", reason: "r", confidence: 0.9, draft: "hi" } as DraftedAction,
      { action_type: "relay", target: { platform: "wechat", personaKey: "x" }, reason: "r", confidence: 0.9, draft: "转发" } as DraftedAction,
      { action_type: "forward", target: { platform: "gmail", personaKey: "x" }, reason: "r", confidence: 0.9, draft: "fwd" } as DraftedAction,
      { action_type: "task", reason: "r", confidence: 0.9, params: { title: "回复 Michael 供电规格" } } as DraftedAction,
    ];
    const r = await draftActions([msg()], deps(llm));
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.action_type).toBe("task");
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
    // Retirement now drops it before the answered-thread gate would; either
    // way a reply never survives and the task beside it does.
    expect(r.dropped.length).toBeGreaterThan(0);
  });

  it("drops it for the last-sender signal too, not just the in-thread one", async () => {
    const llm: LlmCaller = async () => [
      { action_type: "reply", reason: "r", confidence: 0.9, draft: "d" } as DraftedAction,
    ];
    const r = await draftActions([msg({ userIsLastSenderInChannel: true })], deps(llm));
    expect(r.actions).toHaveLength(0);
  });

  // "still allows a reply on an unanswered thread" retired with reply
  // production itself (owner, 2026-08-14) — no thread state re-enables it.
  it("drops a reply even on a thread Leo has NOT answered", async () => {
    const llm: LlmCaller = async () => [
      { action_type: "reply", reason: "r", confidence: 0.9, draft: "d" } as DraftedAction,
    ];
    const r = await draftActions([msg()], deps(llm));
    expect(r.actions).toHaveLength(0);
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

// The owner asked for internal colleagues ON the invite ("加 Michael 和 zech 到
// 参加人"), but the model only writes the NAME it read, and buildCalendarEvent
// keeps only entries that are already addresses — so they were silently left off.
describe("calendar attendees: names become addresses at creation", () => {
  const resolver = buildPersonaResolver([michael]);
  const roster = [michael];
  const deps = (llm: LlmCaller) => ({
    llm,
    resolvePersona: resolver.resolve,
    knownPersonaKeys: resolver.keys,
    personas: roster,
    now: () => "2026-06-14T12:00:00Z",
  });
  const cal = (attendees: unknown[]): LlmCaller => async () => [
    {
      action_type: "calendar",
      reason: "agreed in thread",
      confidence: 0.9,
      params: { title: "评审", start: "2026-08-20T09:00", end: "2026-08-20T10:00", attendees },
    } as DraftedAction,
  ];

  it("resolves a first name to the persona's address", async () => {
    const r = await draftActions([msg()], deps(cal(["Michael"])));
    expect(r.actions[0]!.params.attendees).toEqual(["michael@taiv.tv"]);
    expect(r.actions[0]!.params.attendees_unresolved).toBeUndefined();
  });

  // Never guessed: an invite reaches a real inbox, so an unresolvable name is
  // reported on the card instead.
  it("reports an unresolvable name instead of inventing an address", async () => {
    const r = await draftActions([msg()], deps(cal(["Michael", "Gouwa Wang"])));
    expect(r.actions[0]!.params.attendees).toEqual(["michael@taiv.tv"]);
    expect(r.actions[0]!.params.attendees_unresolved).toEqual(["Gouwa Wang"]);
  });

  it("leaves an address the thread stated untouched", async () => {
    const r = await draftActions([msg()], deps(cal(["outside@partner.com"])));
    expect(r.actions[0]!.params.attendees).toEqual(["outside@partner.com"]);
  });

  it("does not touch a non-calendar card's params", async () => {
    const llm: LlmCaller = async () => [
      { action_type: "task", reason: "r", confidence: 0.9, params: { title: "t", attendees: ["Michael"] } } as DraftedAction,
    ];
    const r = await draftActions([msg()], deps(llm));
    expect(r.actions[0]!.params.attendees).toEqual(["Michael"]);
  });
});

// REGRESSION: the model wrote "回 Fabian：…" on a card whose sender was Cody.
// No Fabian persona, and the word appears nowhere in the thread. next_actions
// were never validated, yet they are the checklist items the owner works from.
describe("an invented name in next_actions is reported", () => {
  const resolver = buildPersonaResolver([michael]);
  const deps = (llm: LlmCaller) => ({
    llm,
    resolvePersona: resolver.resolve,
    knownPersonaKeys: resolver.keys,
    personas: [michael],
    now: () => "2026-06-14T12:00:00Z",
  });
  const withSteps = (steps: string[]): LlmCaller => async () => [
    { action_type: "task", reason: "r", confidence: 0.9, params: { title: "t" }, next_actions: steps } as DraftedAction,
  ];

  it("flags a name in neither the thread nor the roster", async () => {
    const r = await draftActions([msg()], deps(withSteps(["回 Fabian：4 点须列为 hard must-have"])));
    expect(r.actions[0]!.params.unverified_names).toEqual(["Fabian"]);
    // the STEP is kept — usually only the name is wrong
    expect(r.actions[0]!.next_actions).toHaveLength(1);
  });

  it("stays quiet for a roster name", async () => {
    const r = await draftActions([msg()], deps(withSteps(["同步 Michael 最新进度"])));
    expect(r.actions[0]!.params.unverified_names).toBeUndefined();
  });

  it("stays quiet for a name the thread itself used", async () => {
    const r = await draftActions(
      [msg({ text: "Darren: 我休假前想交接 build server" })],
      deps(withSteps(["回 Darren 确认交接人"])),
    );
    expect(r.actions[0]!.params.unverified_names).toBeUndefined();
  });

  it("sends real display names to the model, not just keys", async () => {
    let seenText = "";
    const llm: LlmCaller = async (req) => {
      seenText = req.system;
      return [{ action_type: "task", reason: "r", confidence: 0.9, params: { title: "t" } } as DraftedAction];
    };
    await draftActions([msg()], deps(llm));
    // The roster is STABLE, so it rides the system prefix, not userText: behind
    // the volatile timestamp it paid cache_write on every single call.
    expect(seenText).toContain("michael-dobosz = Michael Dobosz");
    expect(seenText).toContain("NEVER name anyone");
  });
});

// Token cost, not prose: `claude -p` bills the prompt PREFIX. A prefix that is
// byte-identical to the previous call reads from cache at 0.1x input; one byte
// of drift re-writes everything after it at 1.25x. Measured on two real calls
// with a 27k-char stable block: identical prefix $0.0669, drifting prefix
// $0.1805 — 63% of a draft call. Anything per-message/per-sender/per-clock that
// leaks into `system` silently deletes that saving, with no test and no log to
// notice it. Hence this.
describe("system prompt is a stable cache prefix", () => {
  const req = (over: Parameters<typeof buildDraftRequest>[0]) => buildDraftRequest(over);
  const stable = {
    knownPersonaKeys: ["michael-dobosz"],
    knownPeople: ["michael-dobosz = Michael Dobosz"],
    projectCatalog: "REV5 = Rev5 release",
    leoProfile: "delegates hardware",
  };

  it("is identical across different senders, messages and clocks", () => {
    const a = req({
      ...stable,
      persona: michael,
      messages: [msg({ text: "first message" })],
      now: "2026-08-20T10:00:00.000Z",
      nowLocal: "2026-08-20 18:00 (UTC+08:00)",
    });
    const b = req({
      ...stable,
      persona: { ...michael, key: "someone-else", displayName: "Someone Else" },
      messages: [msg({ text: "a totally different message" })],
      now: "2026-08-20T23:47:11.900Z",
      nowLocal: "2026-08-21 07:47 (UTC+08:00)",
    });
    expect(a.system).toBe(b.system);
    expect(a.userText).not.toBe(b.userText); // the variation is real, just not in the prefix
  });

  it("keeps the volatile clock OUT of the cached prefix", () => {
    const a = req({ ...stable, persona: michael, messages: [msg()], now: "2026-08-20T10:00:00.000Z" });
    expect(a.system).not.toContain("2026-08-20T10:00:00.000Z");
    expect(a.userText).toContain("2026-08-20T10:00:00.000Z");
  });

  // The blocks whose hoisting bought the saving — assert they are in the prefix
  // so a future "tidy the prompt" edit cannot quietly move them back.
  it("carries the stable blocks in the prefix, not per call", () => {
    const a = req({ ...stable, persona: michael, messages: [msg()] });
    expect(a.system).toContain("PROJECT CATALOG");
    expect(a.system).toContain("KNOWN PEOPLE");
    expect(a.system).toContain("ANCHOR TO THE MESSAGE");
    expect(a.userText).not.toContain("PROJECT CATALOG");
    expect(a.userText).not.toContain("KNOWN PEOPLE");
  });
});

describe("a total wipeout is reported as one", () => {
  // 2026-09-02 → 09-04: the subscription's OAuth session expired, every draft
  // call died, and the recorded error read "陈古龙: claude -p exit 1: …" — one
  // arbitrary contact. Indistinguishable from a single flake, so the outage ran
  // for two days. The denominator is what tells the two apart.
  it("reports the sender count alongside the failures", async () => {
    const llm: LlmCaller = async () => {
      throw new Error("Failed to authenticate: OAuth session expired");
    };
    const r = await draftActions(
      [msg({ senderHandle: "UMICHAEL" }), msg({ id: "slack:C1:2.0", senderHandle: "UZECH" })],
      { llm, resolvePersona: () => michael, knownPersonaKeys: [] },
    );
    expect(r.senders).toBe(2);
    expect(r.errors).toHaveLength(2); // every sender down — not one flake
  });

  it("counts senders, not messages", async () => {
    const llm: LlmCaller = async () => [];
    const r = await draftActions(
      [msg({ id: "slack:C1:1.0" }), msg({ id: "slack:C1:2.0" }), msg({ id: "slack:C1:3.0" })],
      { llm, resolvePersona: () => michael, knownPersonaKeys: [] },
    );
    expect(r.senders).toBe(1); // three messages, one sender
  });
});

// 2026-09-11, from the ticket bench: the drafter set assignee to
// `ihor-kachura`. That is the persona key it reads all through its own
// context, and it is the one string resolveJiraAssignee cannot resolve — Jira
// matches humans by display name, so the ticket ships unassigned and nothing
// reports why. Converted at creation, like attendees.
describe("a persona key as assignee becomes the name Jira matches on", () => {
  const ihor: Persona = {
    key: "ihor-kachura",
    displayName: "Ihor Kachura",
    relationship: "firmware lead",
    handles: { slack: "U_IHOR" },
    language: "en",
    register: "casual",
    toneNotes: "direct",
    context: "firmware",
  };

  const draftWith = async (assignee: string) => {
    const llm: LlmCaller = async () => [
      {
        action_type: "tool",
        reason: "r",
        confidence: 0.9,
        headline: "log collection",
        params: { tool: "jira", project: "TAIV", summary: "Offline log collection", description: "d", assignee },
      } as DraftedAction,
    ];
    const r = await draftActions([msg({ senderHandle: "U_IHOR" })], {
      llm,
      resolvePersona: () => ihor,
      knownPersonaKeys: ["ihor-kachura"],
      personas: [ihor],
    });
    return (r.actions[0]!.params as { assignee?: string }).assignee;
  };

  it("converts the key", async () => {
    expect(await draftWith("ihor-kachura")).toBe("Ihor Kachura");
  });

  it("leaves a real display name alone", async () => {
    expect(await draftWith("Ihor Kachura")).toBe("Ihor Kachura");
  });

  it("passes an unknown name through rather than bending it to a key", async () => {
    // No fuzzy matching on people. 「Ihor」 alone stays as written and the
    // resolver refuses it downstream — that is the Echo mis-binding lesson.
    expect(await draftWith("Ihor")).toBe("Ihor");
  });
});
