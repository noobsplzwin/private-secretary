# Person-first consolidation (design)

Status: PROPOSED (2026-08-13). Author note: triggered by an item-by-item review
of a 19-row list in which the owner struck **7 whole tasks as already finished or
never his** — 37% of the output. His diagnosis: "最核心的问题是你加入了很多已经
结束的ticket和提醒，跟进，确认这种无意义的ticket", and his proposed shape:

> Person first → commitments → read all the new messages from all sources →
> 分析当前事情的进度 → 看看有没有新的 commitment，进行更新 → 创建 item 以及
> sub item 的一键创建 jira 和 calendar

**The unit of OUTPUT is still the task, not the person** (owner, 2026-08-12:
"应该按任务分组，以我（用户为核心）的任务"). Person-first is the axis of
RETRIEVAL and ANALYSIS. A contact never becomes a row.

## 1. Why it fails today (grounded in code)

**The axis is the CONVERSATION, end to end.** `clusterKey` is
`platform::sender_handle`; `refreshOpenTasks` re-reads one thread per card;
`persona-update` calls `fetchThread(card)` — one card, one conversation, one
platform. Nothing in the engine ever assembles what one PERSON said across
sources.

The case that proved it. A Slack channel thread about getting a manufacturing
agreement counter-signed ends 2026-07-29 with the work outstanding — and the
channel has had no message since, so that thread is complete and reads
unresolved forever. On 2026-07-30 the engine ingested a Gmail message and drew
the right conclusion, emitting two cards typed `ignore`:

    [gmail:19fb298c…]  PCB/PCBA供应协议已签回
    [gmail:19fb21fa…]  PCB agreements signed & returned by Yang

Two weeks later the refresh pass re-read the unchanged Slack thread and produced
"Get factory to sign manufacturing agreement" as fresh work. **The engine knew
the answer and could not reach it**: the evidence sits in a Gmail conversation,
the resurrected card in a Slack one, and no pass joins them.

**Closing a card means nothing.** Refresh re-derives the work from the thread.
Cards hand-closed that morning came back the same evening because a sibling card
from the same message was still open, so refresh re-read the thread and re-emitted
the whole set. A card dies only if (a) its event date passed, or (b) its own
thread contains the resolution.

**The commitment ledger is write-only.** `persona-update` extracts commitments
into the persona file through the R1 chokepoint every tick. Grep for consumers of
`commitments` outside that pass, the schema validator and file I/O: **there are
none.** The draft prompt does not include it. So the engine computes "what is
outstanding between Leo and this person" every round, stores it, and then decides
the to-do list from an entirely separate path (message → card → cluster → rank).

**Everything we have been fixing is a symptom of the axis.** The invented
umbrella that merged a VPN recommendation, a car sale and a repo-access check;
the keyword merge that folded two unrelated NDAs together; a task_id absorbing
whatever one contact said next. Each was patched with a prompt rule, and the next
round found a new way through, because grouping by conversation has no notion of
what the work IS.

## 2. What already exists (build on these — do NOT reinvent)

- **Commitment ledger, populated and structured.** `Commitment { who: "me" |
  "them", what, due?, status: open|done|…, source_message_id? }` in
  `relay/core/persona-v3.ts`, stored per persona. Real entries exist today,
  including `status: done` ones.
- **Cross-source identity.** `handles: { slack, gmail, wechat }` per persona;
  `buildPersonaResolver` maps a handle to a persona.
- **`persona-update` pass** with the R1 write chokepoint (`writePersonaFile`
  actor="llm", manual fields never touched, evidence required).
- **Ranking/tiering** (`plan`), the TickTick push, and the completion read-back
  (PHASE 6a) — the output half needs no change.
- **Quote-grounding precedent**: `params.time_quote` already asks for the wall
  time verbatim. It is unverified by any code, which §3 fixes.

## 3. Design

    per person with new traffic
      ├─ 1. RETRIEVE   all new messages across Slack + Gmail + WeChat
      ├─ 2. ASSESS     each OPEN commitment → state, blocker, evidence quote
      ├─ 3. UPDATE     ledger via the existing R1 chokepoint
      └─ 4. DERIVE     items mechanically from the ledger — not authored

### 3.1 Retrieve — one person, all sources

A per-person cursor replaces the per-conversation one for this pass. Input is
every message involving that person since their cursor, from every source their
persona has a handle for, merged and ordered by time, each line carrying its own
`[YYYY-MM-DD]` (all three readers now emit that).

Only persons with new traffic are assessed. That is the cost bound — see §5.

### 3.2 Assess — the model judges, it does not invent

For each open commitment the pass returns one verdict:

    { commitment_id, state: advanced | blocked | done | unchanged,
      blocked_on: "leo" | "them" | "third-party" | null,
      needs_leo: boolean,
      evidence: "<verbatim quote from the retrieved corpus>",
      next_step?: "<one imperative line, only when needs_leo>" }

**Every verdict must quote.** A verdict whose `evidence` string is not found
verbatim in the retrieved corpus is DISCARDED by code before anything downstream
sees it. This is the constraint the owner asked for — "他只做逻辑分析，不会创造"
— expressed as a mechanical check rather than another prohibition. The same
check is owed to `params.time_quote`, which has never had one.

The pass is deliberately narrow: it does not decide what belongs on a list, it
reports the state of things already known to be outstanding.

### 3.3 Update — new commitments

Unchanged from today's `persona-update`, except that it now sees all sources at
once, so a commitment raised on Slack can be closed by a Gmail message. Same R1
chokepoint, same evidence requirement.

### 3.4 Derive — the list is computed, not written

An item exists **iff**:

    who == "me"  AND  status == "open"  AND  needs_leo == true

No model authors a to-do. The title is the commitment's own `what`; the sub-items
are grounded `next_step`s. This is what kills "提醒/跟进/确认" rows: a commitment
that is `blocked_on: "them"` produces nothing, no matter how much the thread
looks like it wants chasing. The owner's ping rule (7+ silent business days, or
his own deadline near) becomes a computable exception on top, not a prompt plea.

Task grouping falls out for free: a task IS a commitment, and one commitment's
evidence may come from three sources. The umbrella, the keyword merge and the
person-absorbs-everything failures cannot be expressed in this model.

`ITEM_STANDARD` stays as the wording bar for `next_step`; rules 1, 4 and 6 become
structural instead of advisory.

### 3.5 One-click Jira / calendar

Unchanged from `specs/ticktick-migration.md` §1, which already decided that
exactly two kinds of ticked sub-action execute: **sending invites** for an event
with attendees, and **creating a tool item** (e.g. a Jira ticket). The read-back
shipped in PHASE 6a records completion only and does NOT execute — that half is
still to be built, and the "ticking never executes" wording in its commit
overstates a deferral as a principle. It is a deferral.

reply/relay/forward are RETIRED from production entirely (owner, 2026-08-14:
"AI暂时不帮我回复"). A thread that needs Leo's answer surfaces as a `task`
naming the reply he owes — never a drafted message. SHELVED, on the owner's
todo: a one-click "起草回复" button that drafts the reply on demand (the
executors, the owner-voice skill, and the gmail thread locators carried on
every gmail-sourced card are kept for exactly that).

## 4. Code touch-points

| Area | Change |
| --- | --- |
| `relay/proc/persona-update.ts` | becomes the person pass: multi-source input, verdicts + new commitments |
| `relay/proc/persona-update-prompt.ts` | verdict schema; mandatory `evidence` quote |
| new `relay/core/commitment-verdict.ts` | pure: quote verification, item derivation, ping exception |
| new per-person cursor | in loop state, beside the existing source cursors |
| `scripts/run-notify.ts` | a `fetchAllForPerson(persona)` reader over the three sources |
| `relay/proc/scan-loop.ts` | new phase order; `consolidate` narrows or retires |
| `relay/core/tasks.ts` / `unit-key.ts` | task identity keyed by commitment, not conversation |
| `relay/proc/draft.ts` | keeps one-off/FYI detection; stops being the author of the list |

## 5. Cadence & cost

75 personas exist; only those with new traffic are assessed, so a quiet tick
costs nothing. A busy contact costs one call carrying their whole ledger and
their new messages — comparable to today's `persona-update`, and it REPLACES the
per-card refresh calls rather than adding to them.

The consolidation call that scaled with the whole queue (73 cards, 22.5k chars,
one 600s-timeout call) disappears: work is assessed per person, so cost grows
with people who talked, not with backlog size.

## 6. Risks / open questions

1. **Ledger quality is now load-bearing.** A missing commitment means a missing
   to-do. Today a bad ledger entry is invisible; after this it is the product.
   Mitigation: the first phase runs the ledger in SHADOW next to today's list and
   the two are diffed before anything switches over.
2. **Identity gaps.** Several personas have `wechat: null`; a person reachable on
   an unmapped handle is invisible to their own pass. Needs an unresolved-handle
   report, not a silent skip.
3. **Work that belongs to nobody.** A credit-card alert or a bank notice has no
   persona. These need a path that is not person-keyed — probably the surviving
   part of `draft`.
4. **"needs_leo" is the hard judgment** (the owner named this himself). It is one
   boolean with a quote behind it, which is the narrowest form we can ask for,
   but it is still a judgment. Phase 1 measures its agreement with the owner
   before anything depends on it.
5. **Ledger drift.** Commitments accumulate; a `done` one must not resurface, and
   a stale `open` one must age out. Needs an explicit lifecycle.

## 7. Sequencing

Each phase is verifiable on its own; none of them is a switchover.

1. **Cross-source retrieval.** `fetchAllForPerson` + per-person cursor. Nothing
   else changes; `persona-update` simply stops being single-thread. Verifiable:
   a commitment raised on Slack and closed by Gmail closes.
2. **Quote verification.** Mandatory `evidence`, verified in code, applied to the
   new verdicts and retro-fitted to `time_quote`. Report the discard rate — if it
   is high, that number is itself the finding.
3. **Shadow ledger.** Derive a list from commitments, log it beside the real one,
   diff daily. No user-visible change. This is where risk 1 and 4 are measured.
4. **Switch the list over** once the shadow list wins on the owner's own
   standard.
5. **Retire** conversation-keyed consolidation and the per-card refresh.
6. **Ticked invites / tool items execute** (`ticktick-migration.md` §1).

## 7b. Commitment chains (owner, 2026-08-14)

Reviewing the antenna case, the owner named the next structure: commitments
LINK. One real-world matter is a chain across several people's ledgers —

    leo → Leo Yang   [me]   commission the antenna purchase        done
    Leo Yang → leo   [them] buy & ship 10-20 modules to Detroit    open   ← active link
    Jansell/Ronan    [them] test locally once received             open   (waits upstream)

"每个 commitment 其实都可以通过线连接起来，然后看是否完成了." A matter is done
when its chain closes; the derived list shows an item only when the chain's
ACTIVE link is Leo's. This generalizes §3.4 (blocked_on: them → no item) from a
per-commitment judgment to a structural one: the antenna matter produced a
to-do under the old pipeline and would produce none here, while staying fully
tracked — which is exactly how the owner adjudicated it by hand.

Not built yet. Needs a link field between commitments (likely a shared
matter_id), and the assess step to place each verdict inside its chain.
Belongs after phase 4; recorded now so the shape is not lost.

## 8. Decisions

- 2026-08-12 (owner): the output unit is the TASK, centred on the owner — never
  the contact.
- 2026-08-13 (owner): keep only A/B tiers in the list; C and unranked wait.
- 2026-08-13 (owner): item language follows the SOURCE — WeChat Chinese,
  Slack/Gmail English.
- 2026-08-13 (owner): prefer prompt engineering and grounded, restrictive skills
  over hardcoded logic; hardcode only what a prompt cannot be trusted with
  (arithmetic on dates, state transitions).
