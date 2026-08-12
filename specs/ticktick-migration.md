# TickTick as the surface (design)

Status: ACCEPTED (2026-08-12). Branch `feat/ticktick`.

Moves the engine's OUTPUT from the local cockpit to TickTick: the daily
prioritised to-do list, the background needed to act on each item, and
confirmed calendar events. Scanning is unchanged — 2 Slack accounts, 4
mailboxes and WeChat already feed the same passes.

## 1. What TickTick can and cannot trigger

TickTick IS an input. The daemon polls it for checklist state, and **two** kinds
of ticked sub-action execute (owner, 2026-08-12):

- **sending the invites** for a calendar event that has attendees
- **creating a tool item**, e.g. a Jira ticket

Everything else there is inert.

A tickable action must pass BOTH tests:

1. **Does the material content fit in ONE LINE?** A checklist item has no
   description field (`OpenChecklistItem` is only `title / status / sortOrder /
   startDate / isAllDay / timeZone`), so whatever the line does not say, the
   owner cannot see before ticking.
2. **Is a mistake CORRECTABLE afterwards?**

The two exits pass for different reasons, which is worth keeping straight. A
Jira ticket passes mainly on (2) — its body does not fit in a line, but a wrong
ticket can be edited or deleted. An invite passes mainly on (1) — who and when
fit, and a wrong one can at least be updated or cancelled. A reply fails both:
its wording does not fit, and a sent message cannot be unsent. That is why
reply / relay / forward keep their cockpit approval — not because they matter
more.

Whatever the kind, the line must name WHO it reaches by RESOLVED ADDRESS, never
a display name: "invite Kevin" is not reviewable, `kevin.chen@acme.com` is.

Note the consequence: once polling exists, replies staying inert is a DECISION,
no longer an architectural impossibility. Do not let it erode by accident.

The cockpit is NOT retired. It keeps approving reply / relay / forward.

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

**An event WITH attendees is invited by ticking its sub-action.** The event is
created on the owner's calendar the same way; the invite emails are the separate,
ticked step. Three rules make that tick safe enough to be worth it:

1. **The item text carries the resolved EMAIL ADDRESSES and the exact local
   time** — never display names alone. Wrong-recipient is this product's worst
   failure, and "invite Kevin" is not reviewable while
   `kevin.chen@acme.com` is. If the item does not show what the tick will do,
   the tick is not an approval.
2. **Unresolvable attendees produce NO executable item.** ASK-not-GUESS is
   unchanged: the sub-action degrades to a "me" item saying which name could not
   be resolved. An unresolved name must never reach a tickable send.
3. **Ticking is idempotent and one-way.** Execution goes through the existing
   receipt machinery, so a re-poll of an already-executed item does nothing.
   UN-ticking does NOT cancel and does NOT re-send — undoing a checkbox cannot
   un-email anybody, so pretending otherwise would be a lie.

**Other sends are inert.** reply / relay / forward appear as checklist items so
the to-do reads completely, but carry no executable payload — see §1 for why the
line falls between an invite and a reply.

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
