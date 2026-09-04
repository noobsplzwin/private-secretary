// S0 — the CURRENT production theory, wrapped as a bench strategy. The control
// group: every other theory has to beat this number or the rebuild isn't worth
// it.
//
// What S0 believes (as shipped): one LLM call per person does everything at
// once — extract new commitments, judge status changes on tracked ones, and
// judge needs_leo per open who=me commitment. The to-do list is then
//   (tracked open who=me judged needs_leo) ∪ (freshly extracted open who=me).
// The only mechanical defence is the quote gate (evidenceGrounded).
//
// PURE: this reuses the production prompt builder and parsers verbatim but
// writes nothing — no persona files, no state, no TickTick.

import {
  buildPersonaUpdateRequest,
  parseExtractedAssessments,
  parseExtractedCommitments,
} from "../../proc/persona-update-prompt.js";
import { evidenceGrounded } from "../../core/quote-check.js";
import { indexCorpus, mintable } from "../../core/corpus-lines.js";
import type { Commitment } from "../../core/persona-v3.js";
import type { EvalInput, L2AStrategy, ProposedTodo } from "../l2a.js";

export type JsonCaller = (req: { system: string; userText: string; toolInputSchema: Record<string, unknown> }) => Promise<unknown>;

export function s0Current(json: JsonCaller): L2AStrategy {
  return {
    name: "s0-current",
    async propose(input: EvalInput): Promise<ProposedTodo[]> {
      const out: ProposedTodo[] = [];
      for (const person of input.persons) {
        const existing = person.ledger as Commitment[];
        let raw: unknown;
        try {
          raw = await json(
            buildPersonaUpdateRequest({
              name: person.displayName,
              existing,
              thread: person.corpus,
            }),
          );
        } catch (e) {
          // A dead call is a loud zero for this person, never a silent skip.
          console.error(`[s0] ${person.personaKey}: LLM failed — ${(e as Error).message.split("\n")[0]}`);
          continue;
        }

        const grounded = <T extends { evidence?: string }>(xs: T[]): T[] =>
          xs.filter((x) => x.evidence && evidenceGrounded(person.corpus, x.evidence));

        // The SAME structural gates production runs (core/corpus-lines.ts).
        // They used to live only on the production orchestrator, which this
        // strategy does not enter — so the 2026-09-04 re-run scored the ungated
        // path and reported no change from shipping them. A gate the bench
        // cannot see is a gate the bench cannot score.
        const lines = indexCorpus(person.corpus);
        const nowMs = Date.parse(input.frozenAt);

        // Tracked open who=me the model judged needs_leo — the assess half.
        for (const a of grounded(parseExtractedAssessments(raw, existing.length))) {
          const target = existing[a.index]!;
          if (target.who !== "me" || target.status !== "open" || !a.needs_leo) continue;
          out.push({
            personaKey: person.personaKey,
            title: target.what,
            ...(target.matter_id ? { matterId: target.matter_id } : {}),
            ...(target.due ? { due: target.due } : {}),
            evidence: [a.evidence],
          });
        }

        // Freshly extracted who=me — the extraction half. In production these
        // wait a round for assessment; steady-state they render, so they count.
        for (const c of grounded(parseExtractedCommitments(raw))) {
          if (c.who !== "me" || (c.status ?? "open") !== "open") continue;
          if (!mintable(lines, c, nowMs)) continue;
          out.push({
            personaKey: person.personaKey,
            title: c.what,
            ...(c.matter_id ? { matterId: c.matter_id } : {}),
            ...(c.due ? { due: c.due } : {}),
            evidence: c.evidence ? [c.evidence] : [],
          });
        }
      }
      return out;
    },
  };
}
