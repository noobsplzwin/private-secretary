// LLM drafting orchestrator. Turns filtered candidate messages into
// validated ActionItems for round-commit. The LLM call itself is
// injected (LlmCaller) so this is unit-testable with a stub and the
// real Anthropic adapter slots in for prod.
//
// Flow (mirrors the /relay skill's "merge + analyze" step):
//   1. group candidates by sender (one combined analysis per sender)
//   2. resolve the sender's persona
//   3. build the draft request (draft-prompt.ts) + call the LLM
//   4. validate each suggested action into a full ActionItem, attaching
//      id / created_at / status=suggested / source_message_id / context
//   5. return the actions + any per-action validation errors (dropped, not
//      fatal — a malformed suggestion shouldn't sink the whole batch)
//
// Per-sender fault isolation: an LLM error for one sender records an
// error and continues with the others (same shape as source faults).

import { randomUUID } from "node:crypto";
import {
  validateActionItem,
  type ActionContext,
  type ActionItem,
} from "../core/action-item.js";
import type { InboundMessage, Persona } from "../core/types.js";
import { nowLocalIn } from "../core/when.js";
import { machineTimeZone } from "../io/settings.js";
import { buildDraftRequest, type DraftedAction } from "./draft-prompt.js";
import { selectProjects, renderProjectContext, renderProjectCatalog, type Project } from "../core/project.js";
import { detectMentions } from "../core/mentions.js";
import { mayProduceActionType } from "../core/trigger-filter.js";

// The injected LLM call: takes the assembled request, returns the parsed
// suggested actions (the adapter extracts them from the tool call).
export type LlmCaller = (req: {
  system: string;
  userText: string;
  toolName: string;
  toolInputSchema: Record<string, unknown>;
  // Absolute paths to decoded image files for this sender's batch. When set,
  // the caller runs in vision mode (the model reads the pixels). Empty/absent =
  // text-only. The point of a message is often IN a screenshot (GST25A12).
  imagePaths?: string[];
}) => Promise<DraftedAction[]>;

export interface DraftDeps {
  /** The OWNER's IANA zone — anchors every relative date. Defaults to the machine. */
  ownerTimeZone?: string;
  llm: LlmCaller;
  // handle (senderHandle / email) → persona, or null for a new contact.
  resolvePersona: (senderHandle: string) => Persona | null;
  knownPersonaKeys: string[];
  // Connected MCP tool keys the model may pick for params.tool (defaults +
  // user config). Absent → the prompt falls back to its built-in jira hint.
  toolKeys?: string[];
  // Decode a message's image attachments to local file paths the LLM can read
  // (WeChat: decode_image; Slack: download url_private). Injected so draft.ts
  // stays I/O-free. A decode that throws is skipped — the draft still proceeds
  // text-only rather than failing. Absent = no vision (text refs only).
  resolveImages?: (m: InboundMessage) => Promise<string[]>;
  // 3-layer RAG (optional). `projects` = the project layer; per sender/message,
  // draftActions selects the relevant ones and injects their goal/state/open-gaps.
  // `leoProfile` = how Leo decides (conditions the analysis). Absent = persona-only.
  projects?: Project[];
  leoProfile?: string;
  // P10 multi-party awareness. `personas` = the full roster, scanned to detect
  // which OTHER known contacts a message/thread mentions (e.g. 古龙's trip thread
  // names 金总). `fetchRelatedThread` pulls that third party's recent conversation
  // so the draft is informed by it AND can emit a follow-up toward them (sync the
  // agreed time to 金小奇). Absent = single-conversation behavior.
  personas?: Persona[];
  fetchRelatedThread?: (p: Persona) => Promise<string | null>;
  now?: () => string;
}

export interface DraftResult {
  actions: ActionItem[];
  // per-sender LLM failures (isolated, non-fatal) + dropped malformed
  // suggestions, for observability.
  errors: Array<{ sender: string; error: string }>;
  dropped: Array<{ sender: string; errors: string[] }>;
  // Senders whose LLM call SUCCEEDED but returned zero suggested actions.
  // This is the silent-empty case: the cursor has advanced, so if the model
  // flaked (DeepSeek intermittently answers off-schema), the message is
  // permanently skipped — the scan-loop surfaces these handles in
  // sourceErrors so the miss is visible. Senders with errors are NOT here
  // (they're in `errors`), nor senders whose suggestions were all dropped
  // by validation (those are in `dropped` — the model DID answer).
  empty: string[];
}

// Per-sender LLM calls run concurrently up to this cap. Bounded so a big
// catch-up tick doesn't fire hundreds of Anthropic requests at once; output
// is still assembled in sender order, so results are deterministic. Kept low (2)
// because each `claude -p` draft is a heavy Claude Code subprocess — running 4 at
// once starved the later consolidate/rank claude -p calls into 180s timeouts.
const DRAFT_CONCURRENCY = 2;

// Run fn over items with at most `limit` in flight, returning results in the
// SAME order as the input (not completion order).
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

function groupBySender(messages: InboundMessage[]): Map<string, InboundMessage[]> {
  const m = new Map<string, InboundMessage[]>();
  for (const msg of messages) {
    const arr = m.get(msg.senderHandle) ?? [];
    arr.push(msg);
    m.set(msg.senderHandle, arr);
  }
  return m;
}

// Build the offline detail-pane snapshot (T2) from the sender's batch:
// the message text(s), sender handle, permalink + attachments if any.
// Provenance fields (sender_handle, sent_at) follow the same pick as
// source_message_id — the NEWEST message in the batch — so the cockpit's
// "which platform · who · when" line always points at the latest trigger.
function contextFor(batch: InboundMessage[]): ActionContext {
  const latest = batch[batch.length - 1]!;
  const combined = batch.map((m) => m.text).filter(Boolean).join("\n---\n");
  const attachments = batch.flatMap((m) => m.attachments ?? []);
  return {
    original_message: combined,
    sender_handle: latest.senderHandle,
    sent_at: new Date(latest.timestampMs).toISOString(),
    ...(latest.senderName ? { sender_name: latest.senderName } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    // Persist the Gmail threadId so the Stage-2 refresh can re-read the thread
    // (the card's source_message_id is the message id, not the thread id).
    ...(latest.platform === "gmail" && latest.threadId
      ? { thread_ref: latest.threadId }
      : {}),
  };
}

export async function draftActions(
  candidates: InboundMessage[],
  deps: DraftDeps,
): Promise<DraftResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const ownerZone = deps.ownerTimeZone || machineTimeZone();
  const bySender = groupBySender(candidates);
  const actions: ActionItem[] = [];
  const errors: DraftResult["errors"] = [];
  const dropped: DraftResult["dropped"] = [];
  const empty: string[] = [];

  // One self-contained unit of work per sender. Returned shape is folded
  // back into actions/errors/dropped in sender order below, so concurrency
  // never changes the output ordering.
  const draftOne = async (
    sender: string,
    batch: InboundMessage[],
  ): Promise<{ sender: string; actions: ActionItem[]; error?: string; senderErrors: string[]; empty: boolean }> => {
    const persona = deps.resolvePersona(sender);
    // 3-layer RAG: pick the project(s) this sender/message touches, render their
    // goal/state/open-gaps. Empty when no project deps or no match (persona-only).
    const projectContext =
      deps.projects && deps.projects.length > 0
        ? selectProjects(deps.projects, {
            senderKey: persona?.key ?? null,
            text: batch.map((m) => m.text).join(" "),
          })
            .map((m) => renderProjectContext(m.project))
            .join("\n\n") || undefined
        : undefined;
    // P10 multi-party: detect OTHER known contacts named in this batch/thread and
    // pull their recent conversation, so the draft is informed by it and can emit
    // a follow-up toward them when a decision here affects them.
    let relatedContext: string | undefined;
    if (deps.personas && deps.personas.length > 0 && deps.fetchRelatedThread) {
      const scan = batch.map((m) => `${m.text}\n${m.threadContext ?? ""}`).join("\n");
      const mentioned = detectMentions(scan, deps.personas, { excludeKey: persona?.key ?? undefined, limit: 2 });
      const blocks: string[] = [];
      for (const key of mentioned) {
        const p = deps.personas.find((x) => x.key === key);
        if (!p) continue;
        const thread = await deps.fetchRelatedThread(p).catch(() => null);
        if (thread && thread.trim())
          blocks.push(`### ${p.displayName} (${p.key}) — recent conversation:\n${thread.trim()}`);
      }
      if (blocks.length > 0) relatedContext = blocks.join("\n\n");
    }
    // The full project catalog (all ids + names + goals) so project_id is
    // assigned by meaning, even when keyword-matching surfaced no focused context.
    const projectCatalog =
      deps.projects && deps.projects.length > 0 ? renderProjectCatalog(deps.projects) : undefined;
    // Time anchor for the prompt: the model gets BOTH the UTC ISO instant and
    // the machine-local rendering (Leo's senders share his timezone), so
    // relative dates resolve against evidence instead of the model's stale
    // calendar (live incident: a 2026-07-30 message was booked onto 2025-01-23).
    const nowIso = now();
    // Rendered in the OWNER's configured zone. Using the machine's offset was
    // the same thing until the owner travelled or this ran on a server, at
    // which point every "tomorrow 9am" resolved to the wrong day, silently.
    const nowLocal = nowLocalIn(nowIso, ownerZone);
    const req = buildDraftRequest({
      persona,
      messages: batch,
      knownPersonaKeys: deps.knownPersonaKeys,
      toolKeys: deps.toolKeys,
      leoProfile: deps.leoProfile,
      projectContext,
      projectCatalog,
      relatedContext,
      now: nowIso,
      nowLocal,
    });
    // Decode this batch's image attachments to local paths so the model can
    // SEE them (vision mode). A failed decode is skipped, not fatal — the draft
    // proceeds text-only. Only resolve when there are image attachments.
    const hasImages = batch.some((m) => (m.attachments ?? []).some((a) => a.kind === "image"));
    if (deps.resolveImages && hasImages) {
      const paths = (
        await Promise.all(
          batch.map((m) =>
            deps.resolveImages!(m).catch(() => [] as string[]),
          ),
        )
      ).flat();
      if (paths.length > 0) req.imagePaths = paths;
    }
    let suggested: DraftedAction[];
    try {
      suggested = await deps.llm(req);
      // DeepSeek drafting is FLAKY: the same batch can legitimately come back
      // with cards on one call and {"actions":[]} on the next (measured; the
      // raw-log exists because of it). An empty first answer gets ONE retry —
      // the retry agrees it's empty, it's a real "nothing to do" and the
      // sender is recorded empty; the retry disagrees, the cards were almost
      // lost to a coin flip. Bounded: at most 2 calls per sender per tick.
      if (suggested.length === 0) suggested = await deps.llm(req);
    } catch (e) {
      return { sender, actions: [], error: (e as Error).message ?? String(e), senderErrors: [], empty: false };
    }
    const ctx = contextFor(batch);
    const latest = batch[batch.length - 1]!;
    const senderErrors: string[] = [];
    const senderActions: ActionItem[] = [];
    for (const s of suggested) {
      // Cross-platform relay/forward is disabled (v1): we only reply to the
      // sender on the platform they messaged from. Drop any the model emits.
      if (s.action_type === "relay" || s.action_type === "forward") {
        senderErrors.push(
          `dropped ${s.action_type}: relay/forward disabled — reply on the source platform only`,
        );
        continue;
      }
      // A reply's recipient is unambiguously the sender, on the platform the
      // message arrived on (Gmail in → Gmail reply, Slack in → Slack reply).
      // Force it deterministically rather than trusting the model's target.
      const target =
        s.action_type === "reply"
          ? { platform: latest.platform, personaKey: persona?.key ?? null }
          : s.target ?? {};
      // Gmail reply routing: the executor builds the reply MIME + threads the
      // draft from these. The mailbox is encoded in the source ("gmail:<email>").
      // Without them the Gmail draft can't be created (the bug where approve
      // said "Draft created" but no draft existed). The LLM never sets these,
      // so the source facts are authoritative.
      const gmailParams: Record<string, unknown> = {};
      if (latest.platform === "gmail") {
        if (latest.source.startsWith("gmail:")) gmailParams.mailbox = latest.source.slice("gmail:".length);
        if (latest.threadId) gmailParams.thread_id = latest.threadId;
        if (latest.subject)
          gmailParams.subject = /^re:/i.test(latest.subject) ? latest.subject : `Re: ${latest.subject}`;
        if (latest.messageId) gmailParams.in_reply_to = latest.messageId;
      }
      // Robustness: task/calendar need params.title to be APPROVABLE, but the
      // model sometimes puts the title only in `headline`, leaving the card stuck
      // on "Needs info: params.title". Backfill title from headline/summary.
      const baseParams: Record<string, unknown> = { ...(s.params ?? {}) };
      if (
        (s.action_type === "task" || s.action_type === "calendar") &&
        (typeof baseParams.title !== "string" || (baseParams.title as string).trim() === "")
      ) {
        const fallback = (s.headline ?? s.summary ?? "").trim();
        if (fallback) baseParams.title = fallback;
      }
      // Assemble the full ActionItem shape the validator + queue expect.
      // Optional fields pass through ONLY when they carry the right type —
      // the model sometimes writes explicit nulls ("draft":null) for "none",
      // which fails validation and silently kills an otherwise good card.
      const raw = {
        action_type: s.action_type,
        target,
        reason: s.reason,
        confidence: s.confidence,
        params: { ...baseParams, ...gmailParams },
        ...(typeof s.draft === "string" ? { draft: s.draft } : {}),
        ...(typeof s.headline === "string" ? { headline: s.headline } : {}),
        ...(typeof s.summary === "string" ? { summary: s.summary } : {}),
        ...(Array.isArray(s.next_actions) ? { next_actions: s.next_actions } : {}),
        ...(typeof s.project_id === "string" ? { project_id: s.project_id } : {}),
        status: "suggested" as const,
        source_message_id: latest.id,
        context: ctx,
      };
      // A thread the owner already answered is analysed for what it commits him
      // to, never for another reply. The prompt is told this, but a prompt is
      // not enforcement: re-drafting a reply to a conversation he already
      // finished is the most irritating false positive there is.
      if (!mayProduceActionType(latest, String(s.action_type))) {
        senderErrors.push(
          `dropped ${s.action_type}: owner already replied in this thread (task/calendar only)`,
        );
        continue;
      }
      const result = validateActionItem(raw);
      if (!result.ok) {
        senderErrors.push(result.errors.join("; "));
        continue;
      }
      senderActions.push({
        ...result.item,
        id: result.item.id || randomUUID(),
        created_at: result.item.created_at || now(),
      });
    }
    return { sender, actions: senderActions, senderErrors, empty: suggested.length === 0 };
  };

  const perSender = await mapWithConcurrency(
    [...bySender],
    DRAFT_CONCURRENCY,
    ([sender, batch]) => draftOne(sender, batch),
  );

  // Fold results back in sender order (deterministic, independent of which
  // LLM call finished first).
  for (const r of perSender) {
    if (r.error !== undefined) errors.push({ sender: r.sender, error: r.error });
    actions.push(...r.actions);
    if (r.senderErrors.length > 0) dropped.push({ sender: r.sender, errors: r.senderErrors });
    if (r.empty) empty.push(r.sender);
  }

  return { actions, errors, dropped, empty };
}

// Build a resolvePersona function from a persona list. Indexes every
// handle (slack id, gmail, wechat) → persona for exact-match lookup.
export function buildPersonaResolver(personas: Persona[]): {
  resolve: (handle: string) => Persona | null;
  keys: string[];
} {
  const index = new Map<string, Persona>();
  // Fallback index by display name. WeChat messages carry the contact's
  // DISPLAY NAME as senderHandle (the WeChat source has only the name, not the
  // wxid), while the persona's handle is the wxid — so a handle-only lookup
  // never resolves a
  // WeChat contact and every WeChat card would draft for a "stranger". The
  // display name is the only join key the WeChat source provides. Handle
  // match stays primary; name is consulted only when no handle matches.
  const byName = new Map<string, Persona>();
  for (const p of personas) {
    for (const h of Object.values(p.handles)) {
      if (h) index.set(h.toLowerCase(), p);
    }
    if (p.displayName) byName.set(p.displayName.toLowerCase(), p);
  }
  return {
    resolve: (handle: string) => {
      const key = handle.toLowerCase();
      return index.get(key) ?? byName.get(key) ?? null;
    },
    keys: personas.map((p) => p.key),
  };
}
