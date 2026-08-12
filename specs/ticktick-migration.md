# TickTick as the surface (design)

Status: ACCEPTED (2026-08-12). Branch `feat/ticktick`.

Moves the engine's OUTPUT from the local cockpit to TickTick: the daily
prioritised to-do list, the background needed to act on each item, and
confirmed calendar events. Scanning is unchanged — 2 Slack accounts, 4
mailboxes and WeChat already feed the same passes.

## 1. What this is not

TickTick does **not** become an input. Nothing in TickTick triggers execution in
v1, so the daemon never polls it for approval. That is a deliberate scope cut,
and it is what makes v1 safe: there is no gesture in TickTick that can send a
message to a human.

The cockpit is NOT retired. It keeps exactly one job — approving reply / relay /
forward — until the owner decides how sends should work.

## 2. Decisions (owner, 2026-08-12)

**Calendar auto-creation is gated on ATTENDEES, not on being a calendar.**
A confirmed meeting with NO attendees is a block on the owner's own calendar and
emails nobody, so the engine creates it directly (the 剪头发 case: agreed in
WeChat, address already known from history). The moment an event has attendees,
Google emails them an invite — that is a send, and it still requires explicit
approval.

This narrows CLAUDE.md's "calendar always requires approval" rather than
abandoning it: the rule exists to stop the engine reaching other people
unbidden, and attendee-less events do not reach anybody. **`ALWAYS_CONFIRM` must
keep `calendar` for the attendee case** — the exemption is checked at execution,
not by removing the type from the set.

**Sends are inert in TickTick.** reply / relay / forward appear as checklist
items so the to-do reads completely, but they carry no executable payload and
ticking one does nothing. Rationale: TickTick's `OpenChecklistItem` has only
`title / status / sortOrder / startDate / isAllDay / timeZone` — **no
description field**. A send approved from a checklist item would be approved
without its draft being visible, which defeats both the wrong-recipient rule and
the `owner-voice` pass. Reviewing a draft needs a field that can hold it.

## 3. The duplicate problem (the core engineering risk)

A to-do has no durable identity across ticks — it is regenerated every refresh
(README, "Known gaps"). Pushing that to TickTick every 30 minutes would create a
fresh copy of the same to-do on every cycle.

So the sync is **create-or-update**, keyed by `unitKey(action)` (core/unit-key.ts
— already durable across supersede), through a persisted map:

```
state/ticktick-sync.json
  { "<unitKey>": { "ticktickId": "...", "projectId": "...", "hash": "<sha of payload>" } }
```

- unknown unitKey → create, record the id
- known unitKey, hash changed → update in place
- known unitKey, hash equal → **no call** (most cycles do nothing)
- task no longer open → complete it in TickTick

The hash gate matters: without it every cycle rewrites 40 tasks and the account
gets rate-limited for no change.

`TICKTICK_BATCH_MAX = 50` (core/mstodo.ts) applies here too — batch_add_tasks
truncates silently above it.

## 4. Mapping

| engine | TickTick |
| --- | --- |
| open task (TaskPlan) | task in the destination list |
| `plan.tier` A/B/C/D | priority 5 / 3 / 1 / 0 |
| `plan.why` + `entities` | description |
| sub-action, assignee `me` | checklist item |
| sub-action, send | checklist item, inert (§2) |
| task done / rejected | completed in TickTick |
| confirmed event, no attendees | Google Calendar event, created directly |
| confirmed event, with attendees | stays a cockpit approval |

Descriptions carry **only what is needed to act** — the address, the amount, the
constraint. No replay of how the agreement was reached and no note about where
the fact came from; the owner called that redundant, and it is: the point of the
description is to be read while doing the task, not to justify itself.

## 5. Order of work

1. `state/ticktick-sync.json` + the pure diff (create / update / complete / skip)
2. the sync pass, batched and hash-gated
3. attendee-less calendar auto-create, with the `ALWAYS_CONFIRM` carve-out tested
4. daemon wiring, after the plan pass

## 6. Open

- Sends: what gesture, if any, ever executes them from TickTick.
- Whether the cockpit's to-do view is retired once this is trusted.
