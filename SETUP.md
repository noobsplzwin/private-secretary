# SETUP — connecting the engine to YOUR accounts

Work top to bottom. After each step there is a command that proves the step
worked; if it doesn't print what's shown, stop there rather than continuing.

**Platform:** macOS. Secrets live in the macOS Keychain and the WeChat reader
depends on macOS-only decryption. Slack + Gmail + Calendar would port to Linux;
WeChat would not.

---

## 0. Prerequisites

| Need | Why | Check |
|---|---|---|
| Node 20+ | runtime | `node -v` |
| A **Claude subscription** + the `claude` CLI logged in | all inference runs through `claude -p`, so there is no API bill | `claude -p "say OK"` prints `OK` |
| macOS Keychain access | every token is read from there, never from a file | — |

```bash
npm install
npm test          # 552 passing. Needs no credentials — do this first.
```

If the suite passes you have a working engine with no data. Everything below is
about giving it *your* data.

---

## 1. Tell it who you are  ← do this before anything else

```bash
cp config/identity.example.json config/identity.json
$EDITOR config/identity.json
```

This is the only place the engine learns whose messages it reads. With no
config it is deliberately **inert** — it polls nothing rather than reaching for
whatever happens to be in your Keychain.

```jsonc
{
  "primaryEmail": "you@yourcompany.com",
  "slackAccounts": [{ "account": "you@yourcompany.com", "label": "slack:direct" }],
  "mailboxes": ["you@yourcompany.com"],
  "calendarMailbox": "you@yourcompany.com"
}
```

- `slackAccounts` — one entry per Slack **workspace**. `account` is the Keychain
  account name you'll store that workspace's token under (step 2). The first
  entry is the primary; its cursor slice keeps the legacy key.
- `mailboxes` — every Gmail address to poll. Each needs its own OAuth bundle
  (step 3).
- `label` values key persisted state (cursors, per-source errors). **Don't rename
  a label after you've been running**, or that source starts from scratch.

Verify:

```bash
npx tsx -e 'import{describeIdentity}from"./relay/io/identity.js";console.log(describeIdentity())'
# identity: you@yourcompany.com (from …/config/identity.json) — slack=slack:direct mailboxes=1 calendar=you@…
```

---

## 2. Slack

You need a **user** token (`xoxp-`), not a bot token — the engine reads your DMs
as you.

1. Create an app at <https://api.slack.com/apps> → **OAuth & Permissions**.
2. Add **User Token Scopes**: `channels:history`, `groups:history`, `im:history`,
   `mpim:history`, `channels:read`, `groups:read`, `im:read`, `mpim:read`,
   `users:read`, `users.profile:read`, `chat:write`, `files:read`.
3. Install to workspace, copy the **User OAuth Token** (`xoxp-…`).
4. Store it under the Keychain account you put in `identity.json`:

```bash
security add-generic-password -U -s taiv-secretary-slack \
  -a you@yourcompany.com -w 'xoxp-…'
```

Repeat per workspace, one Keychain entry per `slackAccounts[].account`.

```bash
npx tsx scripts/smoke-slack-direct.ts     # lists your DM channels
```

---

## 3. Gmail + Calendar (per mailbox)

1. Google Cloud console → new project → enable **Gmail API** and **Google
   Calendar API**.
2. **OAuth consent screen** → External → add yourself as a Test user.
3. **Credentials** → OAuth client ID → *Desktop app* → download the client JSON.
4. Store the client JSON once:

```bash
security add-generic-password -U -s taiv-secretary-google-client \
  -a default -w "$(cat ~/Downloads/client_secret_*.json)"
```

5. Authorise each mailbox (opens a browser; grants
   `gmail.modify` + `calendar.events`):

```bash
npx tsx scripts/run-cockpit.ts --port 4317   # then use the re-auth link in the UI
# …or drive it directly:
npx tsx -e 'import{startGmailReauth}from"./relay/cockpit/reauth.js";startGmailReauth("you@yourcompany.com")'
```

```bash
npx tsx scripts/smoke-gmail-direct.ts     # recent messages per mailbox
npx tsx scripts/smoke-calendar.ts         # lists calendars
```

**Gmail tokens expire.** When the daemon logs
`OAuth refresh failed … HTTP 400`, that mailbox needs re-authorising — re-run
step 5. Nothing else recovers it.

---

## 4. WeChat (optional, macOS only, version-pinned)

Skip this unless you need WeChat. It is the most fragile part of the system.

Requires the `wechat-decrypt` MCP server and **WeChat 4.1.8.106 specifically** —
4.1.10+ changes the in-memory key layout and the scanner finds nothing. You must
also re-sign WeChat ad-hoc so its memory is readable, and turn OFF WeChat's
auto-update or it will silently upgrade and break the chain.

Full walkthrough, including the `0 unique keys` decision tree:
`specs/wechat-local-decrypt.md` and `specs/wechat-decrypt-migration.md`.

```bash
npx tsx scripts/smoke-wechat-mcp.ts       # prints recent sessions
```

WeChat 1:1 has **no official send API** — approved WeChat replies wait for you
to paste them manually. That is intentional, not a missing feature.

---

## 5. TickTick (optional — where approved to-dos land)

Without this, an approved `task` card stays local (a `local` receipt) exactly as
before. With it, the card becomes a real TickTick to-do: title, notes, the
`next_actions` as a checklist, and a priority mapped from the daily plan's tier
(**A→high, B→medium, C→low, D→none**).

Add a `ticktick` entry in the cockpit's **Settings → Tools**, or write
`config/tools.json` directly:

```json
{
  "tools": {
    "ticktick": {
      "label": "TickTick",
      "requiredParams": ["title"],
      "config": {
        "type": "mcp",
        "url": "https://mcp.ticktick.com/",
        "project": "💼Work"
      }
    }
  }
}
```

`https://mcp.ticktick.com/` is TickTick's official remote MCP server. It supports
**dynamic client registration** and PKCE (`S256`), which is exactly what
`relay/io/mcp-tool.ts` already does — no app to register at
developer.ticktick.com, no client secret to store. Scopes are `tasks:read` +
`tasks:write`.

`project` is the destination list **NAME** and must match exactly — resolution is
ASK-not-GUESS (an exact unambiguous match or an error), so a typo fails loudly
instead of filing the to-do somewhere you never look. Omit it to use the Inbox.
The first approve opens a browser for OAuth; the token is stored in Keychain
under `taiv-secretary-mcp-ticktick`.

**TickTick tokens cannot be silently refreshed.** Its authorisation server
advertises `grant_types_supported: ["authorization_code"]` only — no
`refresh_token`. So when the access token expires the daemon cannot renew it in
the background the way Slack/Google do; you have to re-authorise through the
browser. Same operational shape as the Gmail note in §3.

Connect (first run opens the browser) and verify — creates nothing:

```bash
npx tsx scripts/smoke-ticktick.ts
```

It prints the server's tools and your lists, and fails loudly if the configured
destination list doesn't resolve — which is where a typo surfaces, rather than at
approve time.

**Meetings are NOT mirrored into TickTick.** Calendar cards already create a real
Google Calendar event and email the attendees their invites
(`sendUpdates: "all"`). To see those in TickTick, subscribe to the calendar in
TickTick's own settings — that shows the real event, with attendees, and no
duplicate row to keep in sync.

Four TickTick API limits worth knowing, all of which fail silently:

- `batch_add_tasks` / `batch_update_tasks` **cap at 50 tasks per call and
  truncate without an error** — ask for 100 and you get 50 back with an *empty*
  `id2error`. Pinned as `TICKTICK_BATCH_MAX` in `relay/core/mstodo.ts`.
- `create_task` **ignores `status: 2`** — a task cannot be created already
  completed; completion is a second `batch_update_tasks` pass.
- There is **no `completedTime` field at all**, so an original completion date
  cannot be restored.
- Completing a task that carries a `repeatFlag` makes TickTick spawn the **next
  occurrence**, so recurrence must be stripped from anything being archived.

### Migrating a Microsoft To Do export

```bash
npx tsx scripts/migrate-mstodo-to-ticktick.ts --dry-run
npx tsx scripts/migrate-mstodo-to-ticktick.ts
```

Reads `todo-export/todo_export.json`. Completed tasks go to the
`📥 MS To Do Archive` list, open ones to `--open-list` (default `💼Work`), with
notes, checklists, due dates and recurrence preserved. Because TickTick cannot
accept a historical completion date, each task's **real** Microsoft dates are
written into its notes, and the whole archive will show as completed on the day
you run it.

Idempotent: a Microsoft id is recorded in `state/mstodo-migration.jsonl` only
after its whole chunk is confirmed created, and recorded ids are skipped on a
re-run — so an interrupted, rate-limited or short-counted run just resumes. A
chunk that comes back short is deliberately left *unrecorded* and the script
exits non-zero; re-running finishes it.

If a run ever leaves the archive inconsistent (active tasks that should be
completed, or a ledger claiming more than TickTick holds), this reconciles it
against TickTick rather than the ledger:

```bash
npx tsx scripts/repair-mstodo-migration.ts          # read-only report
npx tsx scripts/repair-mstodo-migration.ts --apply
```

It matches rows by **fingerprint** (title + notes, `relay/core/mstodo.ts`), not
by title — 42 of the exported titles repeat, one of them 43 times, so a title
join would mark 317 uncreated rows as done.

---

## 6. Contact profiles (personas)

The engine works without them but reads intent much worse: no sense of who this
person is, what they own, or how they write.

`personas/` is gitignored — a persona is a private dossier on a real colleague.
See `personas/README.md`, and `personas/_example/` for the schema.

Build your own (one-time, never part of the scan loop):

```
/persona-bootstrap --contacts top:10
```

Output lands in `personas/_staged/` for review; a separate promote step moves it
live. Start with your 5–10 most frequent contacts.

---

## 7. Business facts (recommended)

```bash
cp config/business-context.example.md config/business-context.md
$EDITOR config/business-context.md
```

Stops the model inventing a business reality (who is a customer vs a partner,
what stage the company is at). Without it the drafting prompt forbids asserting
any business fact not stated verbatim in the message — safe, just less useful.

Same idea for how *you* write: `config/owner-voice.md` (see the `owner-voice`
skill). Without it drafts read as generically human rather than as you.

---

## 8. Run it

```bash
# Build the cockpit web app first (React + Vite; only needed after checkout
# or frontend changes). The server shows a build-hint page if you skip this.
npm run cockpit:build

# The triage UI — start here, it works with an empty queue.
npx tsx scripts/run-cockpit.ts --port 4317

# One scan round, then exit (safe first run: nothing sends).
npx tsx scripts/run-secretary.ts --once

# The daemon.
npx tsx scripts/run-notify.ts
```

Frontend dev loop: `npm run cockpit:dev` starts Vite on its own port and
proxies `/api` to a running cockpit on 4317 — edit React code with hot reload,
no rebuild. `npm run cockpit:typecheck` type-checks the web app (the root
`npm run typecheck` excludes it).

Useful daemon flags: `--no-consolidate`, `--no-plan`, `--no-persona-update`,
`--no-refresh`, `--refresh-max N`, `--max-draft N`, `--draft-model <model>`,
`--wechat-ms / --gmail-ms / --slack-ms <interval>`.

To run it at login, see `scripts/launchagent/install.sh`. One trap worth knowing:
**launchd cannot write logs under `~/Documents`** (TCC blocks it) — the job dies
with exit 78 and no output. Keep log paths in `~/Library/Logs`.

---

## 9. Prove it works end-to-end

```bash
npx tsx scripts/run-secretary.ts --once
npm run relay -- queue state/loop-state.json    # rows should appear
```

Then open <http://127.0.0.1:4317>, pick a card, and press **Edit** (not Approve)
to confirm the drafting looks sane before you let anything leave the machine.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `identity: UNCONFIGURED` | no `config/identity.json` | step 1 |
| Everything scans but no cards | `claude` not logged in — every LLM pass fails while platform scans still succeed, so it *looks* healthy | `claude -p "say OK"`; log in |
| `OAuth refresh failed … HTTP 400` | Gmail token expired | re-run step 3.5 for that mailbox |
| WeChat `0 unique keys` | wrong WeChat version, or app not re-signed / not logged in | `specs/wechat-local-decrypt.md` |
| `channel_not_found` on Slack | that channel belongs to a different workspace | expected while probing multi-workspace; harmless |
| launchd job dies, exit 78, empty log | log path under `~/Documents` | move logs to `~/Library/Logs` |
| Queue looks stale / duplicated | concurrent writers | **stop the daemon before any manual state surgery** — `pkill -f run-notify.ts` and confirm none remain |

> **Never edit `state/loop-state.json` by hand while the daemon is running.**
> Concurrent writers corrupt the queue; this has cost real work before.
