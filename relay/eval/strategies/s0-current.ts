// S0 — the CONTROL: production, run end to end.
//
// This strategy deliberately owns no logic of its own. It writes each frozen
// ledger to a scratch persona file, calls the production extraction
// (proc/persona-update.ts) against it, and then runs the production derive
// (core/ledger-list.ts) over the result. What the scorecard measures is what
// would land in TickTick.
//
// It used to re-implement the pipeline instead — same prompt, its own copy of
// the assembly. That copy is why the bench could not see the gates: on
// 2026-09-04 a run reported precision unchanged after shipping three of them,
// because the strategy never entered the code they lived in. Then the promotion
// gate, the chase rule and the two-sided assess all shipped equally unmeasured,
// and the regression that followed — nine 催 rows minted off six-week-old
// deadlines — was caught by the owner's eyes, not by a scorecard.
//
// So: no copies. If a rule ships in production and this strategy cannot see it,
// the bench is decoration.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import type { EvalInput, L2AStrategy, ProposedTodo } from "../l2a.js";
import { extractCommitmentsOnce } from "../../proc/persona-update.js";
import { deriveLedgerTasks } from "../../core/ledger-list.js";
import { readPersonaV3File } from "../../io/persona-store.js";

export type JsonCaller = (req: {
  system: string;
  userText: string;
  toolInputSchema: Record<string, unknown>;
}) => Promise<unknown>;

/** A scratch persona file holding one frozen person's ledger, nothing else. */
function seed(dir: string, p: EvalInput["persons"][number]): string {
  const file = join(dir, `${p.personaKey}.yaml`);
  writeFileSync(
    file,
    stringify({
      schema: "persona-v3",
      key: p.personaKey,
      display_name: p.displayName,
      commitments: p.ledger,
      provenance: { commitments: "inferred" },
      evidence: { commitments: "frozen bench snapshot" },
    }),
  );
  return file;
}

/** The 依据 line the derive writes into every row — the row's own provenance. */
function evidenceOf(payload: { content?: string; desc?: string }): string[] {
  const note = payload.content ?? payload.desc ?? "";
  const m = note.match(/依据:\s*"([^"]+)"/);
  return m?.[1] ? [m[1]] : [];
}

/**
 * How many extraction passes each person gets before the derive.
 *
 * TWO, because that is what production reaches. A commitment extracted this
 * round carries no verdict yet — needs_leo is what promotes it — so a
 * single-pass bench renders none of the work it just found, and the
 * 2026-09-07 run missed all seven real items for exactly that reason while
 * the only rows it proposed were old ledger entries carrying old verdicts.
 * The second pass assesses what the first one wrote, which is what a
 * contact's next tick does in production.
 */
const ROUNDS = 2;

export function s0Current(json: JsonCaller): L2AStrategy {
  return {
    name: "s0-current",
    async propose(input: EvalInput): Promise<ProposedTodo[]> {
      const dir = mkdtempSync(join(tmpdir(), "s0-bench-"));
      try {
        let n = 0;
        for (const person of input.persons) {
          console.log(`[s0] (${++n}/${input.persons.length}) ${person.personaKey}…`);
          const file = seed(dir, person);
          for (let round = 1; round <= ROUNDS; round++) {
            try {
              // PRODUCTION. Every gate it applies — grounding, speaker, recency,
              // hedges, verdict coherence — applies here by construction.
              const r = await extractCommitmentsOnce({
                file,
                displayName: person.displayName,
                corpus: person.corpus,
                json,
                now: () => input.frozenAt,
              });
              console.log(
                r
                  ? `[s0]   round ${round}: +${r.added} 新增, ${r.assessed} 裁决, ${r.discarded} 丢弃`
                  : `[s0]   round ${round}: 无结果(解析失败或语料为空)`,
              );
            } catch (e) {
              // A dead call is a loud zero for this person, never a silent skip.
              console.error(`[s0] ${person.personaKey}: LLM failed — ${(e as Error).message.split("\n")[0]}`);
              break;
            }
          }
        }

        // PRODUCTION derive, over the ledgers the pass just wrote. This is the
        // step the bench was blind to: the promotion gate, the chase rule and
        // the "still open, just not now" floor all live here.
        const personas = input.persons.flatMap((p) => {
          try {
            const f = readPersonaV3File(join(dir, `${p.personaKey}.yaml`));
            return [{ key: f.key, display_name: f.display_name, commitments: f.commitments ?? [] }];
          } catch {
            return [];
          }
        });
        const live = new Set(input.matters);
        const rows = deriveLedgerTasks(
          personas,
          "America/Winnipeg",
          Date.parse(input.frozenAt),
          live,
          new Set(input.closedMatters ?? []),
        );

        // Only the WORKING list is a proposal. A sunk row is the floor — still
        // tracked, deliberately not being asked of him today — and counting the
        // pool would score the bench on work the owner was never shown.
        return rows.filter((r) => !r.payload.project).map((row) => {
          const key = row.unitKey.replace(/^ledger_/, "").replace(/_[0-9a-f]+$/, "");
          return {
            personaKey: key,
            title: row.payload.title,
            ...(row.payload.dueDate ? { due: row.payload.dueDate } : {}),
            evidence: evidenceOf(row.payload),
          };
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
