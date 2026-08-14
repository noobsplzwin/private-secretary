// Task-refresh pass (specs/task-consolidation.md, Stage 2). For each open
// conversation (platform + sender) that already has a card, re-read its FULL
// recent thread and re-decide what the card should be NOW — so a card stays
// alive as the conversation evolves, and a settled meeting becomes a calendar
// action. The deliberate departure from unread-gating: we re-read messages Leo
// already read, but ONLY for conversations with an open card, and at most once
// per TTL (default 10 min) per conversation.
//
// Reuses the drafting LlmCaller + ActionItem validation; the only new piece is
// the refresh prompt and the per-conversation thread fetch (injected, so the
// daemon supplies the WeChat/Slack/Gmail readers and tests stub them).

import { randomUUID } from "node:crypto";
import { findUnverifiedNames, rosterAliases } from "../core/name-check.js";
import {
  validateActionItem,
  type ActionContext,
  type ActionItem,
  type TranscriptMessage,
  initialStatus,
  type ActionType,
} from "../core/action-item.js";
import type { Persona, Platform } from "../core/types.js";
import { nowLocalIn } from "../core/when.js";
import { machineTimeZone } from "../io/settings.js";
import { clusterKey } from "../core/unit-key.js";
import { buildRefreshRequest } from "./refresh-prompt.js";
import type { LlmCaller } from "./draft.js";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export interface RefreshDeps {
  /** The OWNER's IANA zone — anchors every relative date. Defaults to the machine. */
  ownerTimeZone?: string;
  llm: LlmCaller;
  resolvePersona: (handle: string) => Persona | null;
  // Re-read the recent thread (both sides) for a card's conversation. Returns
  // null when unavailable (no reader for the platform, or the fetch failed) —
  // that conversation is skipped this tick.
  // Returns the LLM-facing text plus, when available, the same conversation as
  // structured messages. The prompt still gets the text it was tuned on.
  fetchThread: (card: ActionItem) => Promise<{ text: string; messages?: TranscriptMessage[] } | null>;
  // Full project catalog (renderProjectCatalog) so refresh can re-assign a wrong
  // project_id (e.g. a MISC card that actually belongs to a project).
  projectCatalog?: string;
  // Connected tool keys, forwarded to the prompt so a refreshed card can become
  // a ticket with a VALID params.tool instead of a guessed one.
  toolKeys?: string[];
  // The roster, for the invented-name check below. Without it the check cannot
  // tell a real colleague from a hallucination, so it is skipped.
  personas?: Persona[];
  ttlMs?: number;
  // Cap on conversations refreshed per tick (each is one LLM call). The
  // least-recently-refreshed eligible conversations go first, so load spreads
  // across ticks instead of firing N calls at once. Default 3.
  maxPerTick?: number;
  now?: () => string; // ISO, for created_at
  nowMs?: () => number; // epoch ms, for the TTL clock
}

export interface RefreshResult {
  // Conversation keys (platform::sender) whose old suggested cards to drop.
  refreshedKeys: string[];
  // The refreshed + calendar actions to append (carry task_id + matching key).
  newActions: ActionItem[];
}

function platformOf(card: ActionItem): Platform | undefined {
  const prefix = card.source_message_id.split(":")[0];
  if (prefix === "slack" || prefix === "gmail" || prefix === "wechat") return prefix;
  return card.target?.platform ?? undefined;
}

// Per-conversation TTL across ticks (module-level; resets on daemon restart).
const lastRefreshMs = new Map<string, number>();

export async function refreshOpenTasks(
  openCards: Array<ActionItem & { sender_name?: string }>,
  deps: RefreshDeps,
): Promise<RefreshResult> {
  const ttl = deps.ttlMs ?? DEFAULT_TTL_MS;
  const now = deps.now ?? (() => new Date().toISOString());
  const ownerZone = deps.ownerTimeZone || machineTimeZone();
  const nowMs = (deps.nowMs ?? (() => Date.now()))();

  // Group open cards by conversation; the newest card represents it.
  const byConv = new Map<string, ActionItem>();
  for (const c of openCards) {
    const k = clusterKey(c);
    if (!k) continue;
    const cur = byConv.get(k);
    if (!cur || c.created_at > cur.created_at) byConv.set(k, c);
  }

  const refreshedKeys: string[] = [];
  const newActions: ActionItem[] = [];

  // Eligible = past the TTL cooldown; oldest-refreshed first; capped per tick so
  // one tick never fires a call for every open conversation.
  const maxPerTick = deps.maxPerTick ?? 3;
  const eligible = [...byConv.entries()]
    .filter(([k]) => !lastRefreshMs.has(k) || nowMs - lastRefreshMs.get(k)! >= ttl)
    .sort(([a], [b]) => (lastRefreshMs.get(a) ?? 0) - (lastRefreshMs.get(b) ?? 0))
    .slice(0, maxPerTick);

  for (const [key, rep] of eligible) {
    lastRefreshMs.set(key, nowMs); // claim the slot even if the fetch/LLM no-ops

    const fetched = await deps.fetchThread(rep);
    if (!fetched) continue;
    const thread = fetched.text;
    if (!thread) continue;

    const sender = rep.context!.sender_handle!;
    const persona = deps.resolvePersona(sender);
    // Clock anchor for the refresh prompt — same construction as draft.ts.
    // The un-anchored refresh pass hallucinated dates into 2023–2025 and the
    // approvals of those cards became REAL bogus calendar events (2026-08-01).
    const nowIso = now();
    // Rendered in the OWNER's configured zone. Using the machine's offset was
    // the same thing until the owner travelled or this ran on a server, at
    // which point every "tomorrow 9am" resolved to the wrong day, silently.
    const nowLocal = nowLocalIn(nowIso, ownerZone);
    let actions;
    try {
      actions = await deps.llm(buildRefreshRequest({ card: rep, thread, persona, projectCatalog: deps.projectCatalog, toolKeys: deps.toolKeys, now: nowIso, nowLocal }));
    } catch {
      continue; // a single conversation's failure must not sink the pass
    }
    if (!actions || actions.length === 0) continue;

    const platform = platformOf(rep);
    // The transcript already resolved this person's display name; without
    // copying it here the card's provenance line falls back to the raw handle
    // ("slack · U07VD53V7M3 · 08-09"), which identifies nobody. Only a name
    // that is not itself an id counts.
    const speakerName = fetched.messages?.find(
      (m) => !m.self && m.speaker && !/^U[A-Z0-9]{8,}$/.test(m.speaker),
    )?.speaker;
    const ctx: ActionContext = {
      sender_handle: sender,
      ...(speakerName ? { sender_name: speakerName } : {}),
      original_message: thread,
      ...(fetched.messages?.length ? { original_transcript: fetched.messages } : {}),
      ...(rep.context?.thread_ref ? { thread_ref: rep.context.thread_ref } : {}),
    };
    let produced = 0;
    for (const s of actions) {
      // reply/relay/forward are retired from production (owner, 2026-08-14) —
      // same rule as drafting: a needed answer is a task, never a drafted reply.
      if (s.action_type === "reply" || s.action_type === "relay" || s.action_type === "forward") continue;
      const target = s.target ?? {};
      // An INVENTED person in a next_action — the same check draft.ts runs.
      // It was in draft ALONE, and refresh rewrites next_actions every tick, so
      // the warning evaporated on the first refresh while the invented name
      // stayed: "发给 Fabian" survived on a Cody thread that never says Fabian
      // and a roster that has no such person, with nothing on the card to say so.
      const params: Record<string, unknown> = { ...(s.params ?? {}) };
      if (Array.isArray(s.next_actions) && deps.personas) {
        const unverified = findUnverifiedNames(s.next_actions as string[], {
          threadText: thread,
          aliases: rosterAliases(deps.personas),
        });
        if (unverified.length > 0) params.unverified_names = unverified;
      }
      const raw = {
        action_type: s.action_type,
        target,
        reason: s.reason,
        confidence: s.confidence,
        params,
        // Same null-tolerance as draft.ts: the model writes explicit nulls
        // for "none", which would fail validation and kill the card.
        ...(typeof s.draft === "string" ? { draft: s.draft } : {}),
        ...(typeof s.headline === "string" ? { headline: s.headline } : {}),
        ...(typeof s.summary === "string" ? { summary: s.summary } : {}),
        ...(Array.isArray(s.next_actions) ? { next_actions: s.next_actions } : {}),
        // Prefer the LLM's fresh project link; fall back to the rep card's.
        ...(s.project_id ?? rep.project_id ? { project_id: s.project_id ?? rep.project_id } : {}),
        status: initialStatus(s.action_type as ActionType),
        // Keep the rep's source id so clusterKey + task grouping stay coherent.
        source_message_id: rep.source_message_id,
        context: ctx,
        ...(rep.task_id ? { task_id: rep.task_id } : {}),
      };
      const result = validateActionItem(raw);
      if (!result.ok) continue;
      newActions.push({
        ...result.item,
        id: randomUUID(),
        created_at: now(),
      });
      produced++;
    }
    if (produced > 0) refreshedKeys.push(key);
  }

  return { refreshedKeys, newActions };
}

// Test seam: clear the TTL memory so a test starts cold.
export function _resetRefreshTtl(): void {
  lastRefreshMs.clear();
}
