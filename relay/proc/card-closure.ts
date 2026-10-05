// Close the CARDS a sender's conversation shows already done
// (core/closure-check.ts explains the gate).
//
// Run in the analyse lane, which owns actions, on the batch it just drafted:
// those messages and their thread context are exactly what the drafter read,
// and the thread context is where Leo's own lines live (「我: …」). 2026-10-03
// he sent 李冰 the demo video in that chat; the card 「发6490 live切换demo视频给
// 李冰Bezos」 stayed open because the drafter never saw it.

import type { ActionItem } from "../core/action-item.js";
import type { InboundMessage } from "../core/types.js";
import { findClosures, spokenFromBatch } from "../core/closure-check.js";
import type { JsonRequest } from "../core/types.js";

export async function closeDoneCards(
  actions: readonly ActionItem[],
  batch: readonly InboundMessage[],
  /** Senders whose draft call failed — their batch was not read, so nothing is concluded. */
  skip: ReadonlySet<string>,
  json: (req: JsonRequest) => Promise<unknown>,
): Promise<Array<{ id: string; evidence: string }>> {
  const bySender = new Map<string, InboundMessage[]>();
  for (const m of batch) {
    if (skip.has(m.senderHandle)) continue;
    bySender.set(m.senderHandle, [...(bySender.get(m.senderHandle) ?? []), m]);
  }
  const out: Array<{ id: string; evidence: string }> = [];
  for (const [sender, msgs] of bySender) {
    // Exact sender match only: a card is this conversation's or it is not.
    const cards = actions.filter(
      (a) =>
        (a.status === "suggested" || a.status === "approved") &&
        a.action_type === "task" &&
        a.context?.sender_handle === sender,
    );
    if (cards.length === 0) continue;
    const items = cards.map((a, i) => ({
      handle: `R${i + 1}`,
      what: a.headline ?? String(a.params.title ?? ""),
      side: "me" as const,
      origin: [a.context?.original_message ?? ""],
    }));
    const name = msgs[0]!.senderName ?? sender;
    for (const f of await findClosures(name, items, spokenFromBatch(msgs), json)) {
      out.push({ id: cards[items.indexOf(f.item as (typeof items)[number])]!.id, evidence: f.evidence });
    }
  }
  return out;
}
