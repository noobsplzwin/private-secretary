// P1 — durable task identity. The plan layer (loop-state.plans / planOverrides)
// and the cockpit clusters key a task unit by `task_id ?? fallback`. Two leaks
// made that identity non-durable:
//
//   1. Supersede dropped task_id. When a fresh draft replaced a still-suggested
//      same-sender card (scan-loop phase 3, or the refresh pass), the new card
//      carried NO task_id — consolidation assigns it later — so the plan +
//      cockpit cluster detached from the task on every supersede.
//      inheritSupersededTaskIds closes this by COPYING the doomed card's
//      task_id onto its replacement (never minting a new one — round-commit
//      must not invent task_ids).
//
//   2. The standalone fallback `__ungrouped_<actionId>` changed on every
//      supersede (fresh card, fresh id), orphaning plans/overrides keyed to
//      it. unitKey now derives the fallback from the conversation key
//      (platform + sender) via stableHash, so it survives a supersede; the
//      action id is only the last resort for a sender-less card (which never
//      supersedes anyway).
//
// Pure core: no I/O, no imports beyond types.

import type { ActionItem } from "./action-item.js";

// Conversation-cluster key: platform (from the source_message_id prefix) +
// sender handle. Null when there's no sender to cluster on — a sender-less
// card never supersedes and falls back to its own id. Two cards with the same
// key are the same conversation.
export function clusterKey(a: ActionItem): string | null {
  const sender = a.context?.sender_handle;
  if (!sender) return null;
  const platform = a.source_message_id.split(":")[0] ?? "";
  return `${platform}::${sender}`;
}

// Tiny deterministic FNV-1a (32-bit, hex). MUST STAY STABLE FOREVER —
// persisted unit keys (plans, planOverrides) derive from it; changing the
// algorithm orphans every stored standalone-unit key.
export function stableHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

// The unit key a plan / cockpit cluster attaches to. task_id wins; a
// standalone card keys by its CONVERSATION (stable across supersede), not its
// action id (which changes on every supersede). The `__ungrouped_` prefix is
// kept so existing string handling stays valid.
export function unitKey(a: ActionItem): string {
  if (a.task_id) return a.task_id;
  const k = clusterKey(a);
  return k ? `__ungrouped_${stableHash(k)}` : `__ungrouped_${a.id}`;
}

// A cockpit cluster identity (`unit_key` — the select/re-tier target) is
// either a task_id or `__ungrouped_<actionId>` — UNIQUE per cluster, because
// several ungrouped cards from one conversation must not share a select id
// (that would select/highlight them together). Plans and tier overrides
// attach to the STABLE conversation key instead (`__ungrouped_<hash>`), which
// survives a supersede. This resolves an identity key to that stable key:
// task_id passes through; an ungrouped identity re-derives `unitKey` from the
// action. Unknown identities fall back to themselves (defensive).
export function resolvePlanKey(identityKey: string, actions: ActionItem[]): string {
  const PREFIX = "__ungrouped_";
  if (!identityKey.startsWith(PREFIX)) return identityKey;
  const action = actions.find((a) => a.id === identityKey.slice(PREFIX.length));
  return action ? unitKey(action) : identityKey;
}

// Supersede task_id inheritance (leak 1): a fresh card replacing a still-
// suggested same-conversation card inherits that card's task_id, so the plan
// and cockpit cluster stay attached to the task. Only COPIES — a card with
// its own task_id is left alone, and no new ids are minted. Inputs are not
// mutated.
export function inheritSupersededTaskIds(
  incoming: ActionItem[],
  superseded: ActionItem[],
): ActionItem[] {
  const byKey = new Map<string, string>();
  for (const s of superseded) {
    if (!s.task_id) continue;
    const k = clusterKey(s);
    if (k && !byKey.has(k)) byKey.set(k, s.task_id);
  }
  if (byKey.size === 0) return incoming;

  // ONLY when the replacement is unambiguous: exactly one incoming card for
  // that conversation.
  //
  // WHY: inheritance is keyed by conversation (platform::sender), so when one
  // dropped card's task_id met SEVERAL fresh cards, every one of them claimed
  // it. One tick produced three cards from Cody — an applicant review, a
  // background check on Kevin Yang, and a Jira ticket he sent — and all three
  // were absorbed into "Senior Android JD 修订版", a task minted three days
  // earlier for a different subject. Repeat that and a contact's task_id
  // accumulates everything they ever say, under whichever title came first.
  // That is what made the owner's list unusable.
  //
  // It also contradicted consolidate-prompt, which already states the right
  // rule — "The SAME sender is NOT enough to group" — and then lost to this,
  // because this runs on every tick.
  //
  // A 1:1 supersede still inherits, which is the case P1 was about: one chatty
  // contact, one evolving card, whose plan/override must not detach. When a
  // conversation yields several fresh cards there is no basis for saying which
  // one continues the old task, so none does and consolidate decides on merit.
  const incomingPerKey = new Map<string, number>();
  for (const a of incoming) {
    const k = clusterKey(a);
    if (k) incomingPerKey.set(k, (incomingPerKey.get(k) ?? 0) + 1);
  }

  return incoming.map((a) => {
    if (a.task_id) return a;
    const k = clusterKey(a);
    if (!k || incomingPerKey.get(k) !== 1) return a;
    const inherited = byKey.get(k);
    return inherited ? { ...a, task_id: inherited } : a;
  });
}
