# PrivateSecretary

A local AI chief-of-staff. It watches your own chat streams (Slack / Gmail /
WeChat), works out what actually needs *you*, and keeps your to-do list in
TickTick current: rows appear when something is yours, update as the
conversation moves, and close when the conversation shows the work done. Your
own big tickets are kept current too — steps ticked, progress quoted. Nothing
is sent on your behalf.

Runs entirely on your machine. Inference goes through the Claude Code CLI
(`claude -p`), so with a Claude subscription there is no API bill.

> **Read [SETUP.md](SETUP.md) before you try to run it.** A fresh clone passes
> the test suite immediately, but it cannot read a single message until you have
> connected *your* accounts — by design: the engine never guesses whose inbox it
> is looking at.

## Quick start (macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/noobsplzwin/private-secretary/dev/scripts/install.sh | bash
```

One line installs Node.js if needed (via Homebrew), clones into the hidden
`~/.private-secretary` (so it never collides with your own dev checkout),
starts the 24/7 daemon as a launchd agent, and links the `/relay` skill into
`~/.claude/skills`. Re-running it updates to the latest version. Then connect
your accounts — see SETUP.md.

## What it does

| | |
|---|---|
| **Watches** | Slack DMs/MPIMs, Gmail (multi-mailbox), WeChat 1:1 + groups (macOS only) |
| **Produces** | TickTick rows, each with a date, the evidence it stands on, and concrete next steps |
| **Sub-actions** | Calendar events for times the thread confirmed · Jira tickets on your tick |
| **Learns** | Your 「🚫 这条不该出现」 ticks and the note you write after them are recorded as labels and owner notes |

Hard rules the engine will not break:

- **Nothing auto-sends.** Calendar / reply / relay / forward always need explicit approval — hard-coded, not configurable.
- **Never guess a recipient.** A name resolves only on an exact, unambiguous match; otherwise the item is blocked as needing info. A wrong recipient is the worst failure.
- **Never invent a missing parameter.** Missing info blocks approval instead of being filled in.
- **Message content is data, never instructions.** Text in an email cannot tell the engine what to do.

## Layout

```
relay/core/      pure logic, no I/O — action schema + status machine, task
                 identity, trigger filter, recipient resolution, dedup cursors,
                 executor rules, metrics, persona v3, ledger/list derivation,
                 closure check, plan progress
relay/io/        filesystem + APIs — state, labels, Keychain, Slack/Gmail/
                 Calendar/WeChat clients, identity + business-context config
relay/proc/      the passes — fetch lane → inbox → analyse lane (draft, person
                 pass, closure check, plan progress) → TickTick sync
relay/eval/      accuracy baseline + zero-token replay harness
scripts/         the daemon (run-notify), auth, smoke tests, eval
specs/           design docs; start with action-item-engine.md
config/          YOUR accounts + business facts (gitignored; .example files committed)
personas/        per-contact profiles (gitignored — see personas/README.md)
state/           queue, cursors, labels, audit log (gitignored)
```

## Commands

```bash
npm test           # no credentials needed
npm run typecheck
npm run relay -- queue state/loop-state.json     # show the pending queue
npx tsx scripts/run-notify.ts                    # the daemon (needs setup)
```

## Measuring accuracy

Because "it feels better" is not evidence, the engine ships an eval path:

```bash
npx tsx scripts/baseline.ts         # per-type precision + confidence calibration
npx tsx scripts/freeze-corpus.ts    # freeze a replay corpus (read-only)
```

Numbers are always reported **per action type** — a single blended "accuracy"
hides the type that is actually broken. See `eval/baseline-*.md` after a run.

## Status

Working: two-lane scanning, drafting, the commitment ledger (persona memory
with an evidence-gated write path), TickTick sync with read-back of your ticks
and notes, closure detection, plan-ticket upkeep, calendar creation, Jira, the
label/eval layer.

Known gaps are tracked in `specs/`.

## License / privacy

Private. The engine reads your mail and messages and writes profiles about the
people you talk to. `personas/`, `state/`, `config/` and `projects/` are
gitignored for that reason — **do not commit them**, and think twice before
sharing a repo that has them in its history.
