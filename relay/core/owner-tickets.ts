// The owner's OWN tickets — tasks he wrote himself in TickTick, untouched by
// the engine — and how the models refer to them.
//
// WHY: he keeps long chains of work in tickets of his own (「股权变更：A/B 并行 →
// 四笔转让 → 增资」, 「S32N7/i.MX95 机器人安全方案定案」), and the engine never
// read them. So a step of one came back as its own row: 2026-10-03 he dismissed
// two with 「股权变更那个大任务的一部分」, and on 10-04 the backfill drafted
// 「审阅投资协议并签署承诺函」 an hour after that step had gone into his ticket.
//
// The models see the tickets under short handles (T1, T2 …) and may answer
// with one; code maps the handle back to a real ticket, so an invented handle
// covers nothing. Matching is the model's call on the WORK, never a string
// heuristic here — there is no fuzzy matcher in this file on purpose.

import { ENGINE_TAG } from "./ticktick.js";
import type { RemoteTask } from "./ticktick-readback.js";
import type { SyncMap } from "./ticktick-sync.js";

export interface OwnerTicket {
  id: string;
  title: string;
  /** Its open checklist steps, in his order. */
  steps: string[];
  /** TickTick item ids of `steps`, same order — how a proven step is ticked. */
  stepIds?: string[];
  /** Its description — what the plan already knows, so news is not news twice. */
  desc?: string;
}

/** His open tasks among those read: neither tagged by the engine nor tracked by it. */
export function ownerTicketsFrom(remote: readonly RemoteTask[], map: SyncMap): OwnerTicket[] {
  const tracked = new Set(Object.values(map).map((r) => r.ticktickId));
  return remote
    .filter((t) => t.status === 0 && !tracked.has(t.id) && !(t.tags ?? []).includes(ENGINE_TAG) && !!t.title?.trim())
    .map((t) => {
      const open = (t.items ?? []).filter((i) => i.status === 0 && !!i.title?.trim());
      return {
        id: t.id,
        title: t.title!.trim(),
        steps: open.map((i) => i.title!.trim()),
        stepIds: open.map((i) => i.id),
        ...(t.desc?.trim() ? { desc: t.desc.trim() } : {}),
      };
    });
}

/** The tickets as a prompt block, one handle each. Empty when there are none. */
export function ticketBlock(tickets: readonly OwnerTicket[]): string {
  return tickets
    .map((t, i) => [`T${i + 1}. ${t.title}`, ...t.steps.map((s, j) => `    [${j + 1}] ${s}`)].join("\n"))
    .join("\n");
}

/** The ticket a model's handle names, or null — an unknown handle covers nothing. */
export function ticketByHandle(tickets: readonly OwnerTicket[], handle: unknown): OwnerTicket | null {
  if (typeof handle !== "string") return null;
  const m = /^\s*T(\d+)\s*$/i.exec(handle);
  if (!m) return null;
  return tickets[Number(m[1]) - 1] ?? null;
}

/** The `covered_by` a commitment carries when it lives in one of his tickets. */
export function coveredByTicket(t: OwnerTicket): string {
  return `owner-ticket:${t.id} ${t.title}`;
}
