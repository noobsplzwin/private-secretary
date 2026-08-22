// Task-consolidation pass (specs/task-consolidation.md, Stage 1). Runs AFTER
// per-sender drafting, over ALL currently-open cards (this tick's new ones +
// already-open). The daemon never assigned task_id, so every card showed as its
// own "Standalone" cluster; this is the missing LLM grouping step. Pure-core
// split holds: the LLM proposes groupings (consolidate-prompt), tasks.ts dedups
// deterministically (dedupTaskMints, title-keyed).
//
// Stage 1 = cross-sender grouping only. No thread re-read, no calendar (Stage 2).

import { createHash } from "node:crypto";
import { CallGate } from "../core/call-gate.js";
import type { ActionItem } from "../core/action-item.js";
import {
  dedupTaskMints,
  normalizeTaskTitle,
  type TaskRegistry,
} from "../core/tasks.js";
import {
  buildConsolidationRequest,
  parseAssignments,
  type ConsolidationRequest,
} from "./consolidate-prompt.js";

// A generic structured-JSON LLM call (system + userText + schema → parsed
// object). Provided by llm-claude-cli (createClaudeCliJsonCaller) or the
// anthropic adapter; stubbed in tests.
export type JsonCaller = (req: ConsolidationRequest) => Promise<unknown>;

export interface ConsolidateDeps {
  json: JsonCaller;
  now?: () => string;
}

export interface ConsolidateResult {
  // Cards whose task_id changed (caller writes these back into state.actions).
  updatedActions: ActionItem[];
  // New tasks to merge into the loop-state task registry.
  registryAdditions: TaskRegistry;
}

// Deterministic, stable task_id from a title: same title → same id across ticks
// and restarts, so re-running the pass is idempotent. (dedupTaskMints still
// guards against a pre-existing entry with the same title but a different id.)
export function stableTaskId(title: string): string {
  return "task_" + createHash("sha256").update(normalizeTaskTitle(title)).digest("hex").slice(0, 12);
}

const EMPTY: ConsolidateResult = { updatedActions: [], registryAdditions: {} };

// Identical open cards + identical registry = identical grouping. Measured:
// 502 real calls carried only 307 distinct inputs, so 39% of this pass paid to
// re-derive a grouping it had already derived. See relay/core/call-gate.ts.
// EMPTY is the pass's own existing no-op path, so a skip changes nothing
// downstream — the previous identical answer was already applied.
const groupingGate = new CallGate();

export async function consolidateTasks(
  openCards: Array<ActionItem & { sender_name?: string }>,
  registry: TaskRegistry,
  deps: ConsolidateDeps,
): Promise<ConsolidateResult> {
  // Nothing to merge with fewer than two cards.
  if (openCards.length < 2) return EMPTY;
  const now = deps.now ?? (() => new Date().toISOString());

  const req = buildConsolidationRequest({ cards: openCards, registry });
  // The request text IS the determining input — cards and registry both feed it.
  const sig = CallGate.signature(req.userText);
  if (groupingGate.answered("consolidate", sig)) return EMPTY;
  const assignments = parseAssignments(await deps.json(req));
  groupingGate.record("consolidate", sig); // only once the call RETURNED
  if (assignments.length === 0) return EMPTY;

  const cardIds = new Set(openCards.map((c) => c.id));
  const idByCard = new Map<string, string>();
  const candidateMints: TaskRegistry = {};
  for (const { card_id, task_title } of assignments) {
    if (!cardIds.has(card_id)) continue; // ignore hallucinated ids
    const id = stableTaskId(task_title);
    idByCard.set(card_id, id);
    if (!registry[id]) candidateMints[id] = { title: task_title.trim(), created_at: now() };
  }

  // Deterministic guard: fold any mint whose title already exists under a
  // different id into that existing id.
  const { additions, rewrites } = dedupTaskMints(registry, candidateMints);
  for (const [cid, id] of idByCard) if (rewrites[id]) idByCard.set(cid, rewrites[id]!);

  // Count members per final task id (among the open cards).
  const counts = new Map<string, number>();
  for (const id of idByCard.values()) counts.set(id, (counts.get(id) ?? 0) + 1);

  // The pass is AUTHORITATIVE (self-healing): each run the model's assignments
  // are the full truth about groupings. A card's kept task_id is the proposed
  // one ONLY if it attaches to an EXISTING task (any count) or a NEW task with
  // ≥2 members; otherwise it keeps none. A card that currently HAS a task_id but
  // is no longer kept this run gets DETACHED (task_id cleared) — so a past
  // over-merge (e.g. a small-talk card wrongly folded into a task) does not stay
  // frozen forever. This relies on the prompt telling the model to re-list every
  // card that still belongs to its task; omission means "standalone".
  const updatedActions: ActionItem[] = [];
  const keptIds = new Set<string>();
  for (const c of openCards) {
    const proposed = idByCard.get(c.id);
    const keptId =
      proposed && (!!registry[proposed] || (counts.get(proposed) ?? 0) >= 2)
        ? proposed
        : undefined;
    if (keptId) keptIds.add(keptId);
    if (keptId === c.task_id) continue; // no change (covers both being undefined)
    const { sender_name: _drop, task_id: _old, ...rest } = c;
    void _drop;
    void _old;
    // keptId set → attach/reassign; keptId undefined → detach (task_id omitted).
    updatedActions.push(keptId ? { ...rest, task_id: keptId } : (rest as ActionItem));
  }

  const registryAdditions: TaskRegistry = {};
  for (const [id, meta] of Object.entries(additions)) {
    if (keptIds.has(id)) registryAdditions[id] = meta;
  }

  return { updatedActions, registryAdditions };
}

/** Test seam: forget which groupings have already been derived. */
export function _resetGroupingGate(): void {
  groupingGate.clear();
}
