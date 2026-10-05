// Shared types for the relay core. Pure data — no I/O, no platform SDKs.
// Both the MVP (Claude skill) and the Phase 2 standalone app import these unchanged.

import type { Correction } from "./persona-v3.js";

// Action Items ORIGINATE only from person-to-person messaging: slack, gmail, wechat.
// jira/notion are NOT message origins — they are context the analyzer looks up and
// executor TARGETS actions land on (e.g. a future "create Jira ticket"). They appear
// here so ActionTarget.platform / persona handles can name them, never as an
// InboundMessage.platform.
export type Platform = "slack" | "gmail" | "wechat" | "jira" | "notion";

// Platforms we can truly auto-send through in THIS runtime. Only Slack — the Slack MCP
// has slack_send_message. The connected Gmail MCP exposes create_draft ONLY (no send),
// so a Gmail reply/relay creates a draft the user sends from Gmail = manual. WeChat is
// manual too. Phase 2 (own Claude API + a send-capable Gmail path) re-adds gmail here.
export const AUTO_SEND_PLATFORMS: ReadonlySet<Platform> = new Set(["slack"]);

export type Language = "en" | "zh";
export type Register = "formal" | "casual";

// One contact, FLATTENED for the pipeline (resolver/drafter context). The
// full on-disk shape is the v3 hierarchical schema (relay/core/persona-v3.ts,
// specs/persona-v3.md); relay/io/personas.ts maps either layout to this.
// Style profiles are built once at bootstrap and rebuilt only on explicit
// user command (persona-v3 R4) — there is no interaction-count threshold.
export interface Persona {
  key: string; // stable internal id, e.g. "wang-acme"
  displayName: string;
  relationship: string; // free text, fed to the drafter
  handles: Partial<Record<Platform, string>>; // platform id(s) that map to this persona
  language: Language; // language to DRAFT IN when writing to this person
  register: Register;
  toneNotes: string;
  context: string; // v3: open_threads — currently-open items only
  work?: { skills?: string[]; owns?: string[]; projects?: string[]; resources_represented?: string[] }; // v3.1 §7E — RAG context for drafting
  landmines?: string[]; // v3.1 behavior.landmines — things to avoid when drafting
  corrections?: Correction[]; // v3.1 §7B — human corrections, applied at draft time
}

// A file/image attached to a message. A message is NEVER text-only: the point is
// often in a screenshot (a recommended part, a dashboard, an error). The analyzer
// MUST read these before deciding intent — see hasAttachments + the skill rule.
export interface Attachment {
  id: string; // platform file id (e.g. Slack F0..., Gmail attachment id)
  kind: "image" | "file";
  name: string;
}

// An incoming message, normalized by a platform adapter. All fields are FACTS derived
// from platform metadata — no LLM judgment lives here, so the trigger filter stays
// deterministic and testable.
export interface InboundMessage {
  id: string; // platform-unique message id
  platform: Platform;
  senderHandle: string; // raw platform id of the sender
  timestampMs: number;
  text: string;
  source: string; // dedup bucket: channel id / thread id / mailbox, stable per stream
  isDirectMessage: boolean;
  mentionsUser: boolean;
  isReplyInUserThread: boolean; // a reply in a thread the user participates in
  recipientsIncludeUser: boolean; // for email: user in to:/cc:
  // A3 — skip-already-handled signals. Either being true means the user has
  // already engaged with this conversation since the inbound; the filter skips
  // it. Both are FACTS the source/skill supplies; the deterministic core only
  // reads them. They're tracked separately because they answer different
  // questions:
  //   threadAnsweredByUserAfter — user replied in THIS message's thread after
  //     this message's ts (per-thread, scoped). Slack thread / Gmail thread.
  //   userIsLastSenderInChannel — user is the most recent voice in the whole
  //     conversation bucket (DM channel, mailbox-thread, channel). Covers DMs
  //     where there is no "thread" structure but the user already replied via
  //     another client between this message and the scan.
  // Older payloads omit the second field — treat undefined as false.
  threadAnsweredByUserAfter: boolean; // user already replied after this message in-thread
  userIsLastSenderInChannel?: boolean; // user is the most recent sender in the conversation bucket
  attachments?: Attachment[]; // images/files — MUST be read during analysis
  /** A calendar invite this message carries, read from its .ics (core/calendar-invite.ts). */
  invite?: import("./calendar-invite.js").ParsedInvite;
  /** True for an invite in mail already READ: it travels only to be reconciled, never drafted. */
  inviteOnly?: boolean;
  // Recent conversation around this message (both sides, oldest→newest, sender-
  // labelled), for the analyzer to understand context. This is BACKGROUND — the
  // thing to respond to is `text`; threadContext must NOT be re-answered. Set by
  // sources that can fetch a thread (WeChat); omitted otherwise.
  threadContext?: string;
  // Reply-routing facts the source supplies so an approved reply can actually
  // be sent/drafted. Gmail: threadId (to thread the reply), subject (to build
  // "Re: …"), and messageId (the RFC822 Message-ID, for In-Reply-To). Omitted
  // by sources that don't need them (Slack/WeChat reply to a channel/contact).
  threadId?: string;
  subject?: string;
  messageId?: string;
  // Resolved display name for the sender (Slack: from the users.info cache,
  // relay/io/slack-users.ts). Purely cosmetic — the cockpit prefers the
  // persona-curated name, then this, then the raw senderHandle. Omitted when
  // resolution failed or the platform needs no lookup.
  senderName?: string;
}

// True when the message carries attachments the analyzer must read before drafting.
// The deterministic core can't read an image, but it can force the omission to be
// visible: a message with attachments cannot be understood from text alone.
export function hasAttachments(m: InboundMessage): boolean {
  return (m.attachments?.length ?? 0) > 0;
}

// The legacy Relay type and its auto-relay state machine were removed by the
// Action Item Engine (specs/action-item-engine.md): relay is now just one
// action_type in relay/core/action-item.ts, executed after approval like
// every other action.
