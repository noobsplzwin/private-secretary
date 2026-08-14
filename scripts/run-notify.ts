#!/usr/bin/env -S npx tsx
// Notification daemon — the reactive engine. Each source runs on its OWN
// cadence (decoupled), all feeding the same draft → queue → cockpit pipeline:
//   WeChat : local-DB poll (recent-sessions unread + chat-history), fast — near-real-time
//   Gmail  : delta poll per mailbox (historyId), medium
//   Slack  : conversations.history poll, slow (Slack has no DM push + rate limits)
// An in-process mutex serializes ticks so they never contend on the state lock.
// Cursors must already be seeded to "now" (scripts/seed-cursors-now.ts) so the
// daemon only surfaces messages that arrive from here on.
//
//   npx tsx scripts/run-notify.ts [--state p] [--personas p]
//     [--wechat-ms 10000] [--gmail-ms 180000] [--slack-ms 600000] [--max-draft N]
//     [--once] [--no-draft] [--consolidate-timeout-ms 600000]
//
// --once runs ONE tick per source, in order, then exits 0. This is the only
// entry point that wires every pass (draft → refresh → consolidate → plan →
// TickTick sync), so it is also how you re-run the full pipeline over existing
// state after changing prompt or mapping logic. run-secretary.ts --once passes
// `draft` ALONE: it produces cards that are never grouped, tiered, or synced.

import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describeIdentity } from "../relay/io/identity.js";
import { loadSettings } from "../relay/io/settings.js";
import { effectiveToolSpecs } from "../relay/io/tools.js";
import { createTickTickWriter, createTickTickReader } from "../relay/io/ticktick-mcp.js";
import { mcpAuthServiceFor } from "../relay/io/mcp-tool.js";
import type { TickTickWriter, TickTickReader } from "../relay/proc/ticktick-sync.js";
import { dirname, join, resolve } from "node:path";
import { runScanTick, type ScanLoopResult } from "../relay/proc/scan-loop.js";
import { notify } from "../relay/proc/notify.js";
import { loadPersonas } from "../relay/io/personas.js";
import { buildPersonaResolver, type DraftDeps } from "../relay/proc/draft.js";
import { loadProjects, loadLeoProfile } from "../relay/io/projects.js";
import { renderProjectCatalog } from "../relay/core/project.js";
import { createAnthropicLlmCaller, createAnthropicJsonCaller } from "../relay/proc/llm-anthropic.js";
import { createClaudeCliLlmCaller, createClaudeCliJsonCaller } from "../relay/proc/llm-claude-cli.js";
import { createDeepseekLlmCaller, createDeepseekJsonCaller } from "../relay/proc/llm-deepseek.js";
import type { ConsolidateDeps } from "../relay/proc/consolidate.js";
import type { RefreshDeps } from "../relay/proc/refresh.js";
import type { PlanDeps } from "../relay/proc/plan.js";
import type { PersonaUpdateDeps } from "../relay/proc/persona-update.js";
import { wechatDecodeImage, wechatHistory } from "../relay/io/wechat-cli.js";
import { createSlackClientFromKeychain, SLACK_ACCOUNTS, type SlackClient } from "../relay/io/slack-api.js";
import { resolveSlackCredential } from "../relay/io/slack-oauth.js";
import { GmailClient, getHeader } from "../relay/io/gmail-api.js";
import { extractText } from "../relay/sources/gmail-direct.js";
import { KNOWN_MAILBOXES } from "../relay/io/google-oauth.js";
import type { InboundMessage, Persona } from "../relay/core/types.js";
import type { ActionItem, TranscriptMessage } from "../relay/core/action-item.js";
import { resolveSlackUserNames } from "../relay/io/slack-users.js";
import { mentionedUserIds, renderSlackText } from "../relay/io/slack-mrkdwn.js";

// Decode a message's image attachments to local file paths the LLM can read.
// WeChat: decode_image (the V2 AES image key must be in the decrypt config).
// A decode that throws/times out is skipped — the draft proceeds text-only.
// Slack/Gmail vision is not wired yet (their byte-fetch differs).
async function resolveImages(m: InboundMessage): Promise<string[]> {
  if (m.platform !== "wechat") return [];
  const imgs = (m.attachments ?? []).filter((a) => a.kind === "image");
  const paths: string[] = [];
  for (const a of imgs) {
    try {
      const out = await wechatDecodeImage(m.senderHandle, Number(a.id));
      const match = out.match(/\/[^\s"']+\.(?:jpg|jpeg|png|gif|webp)/i);
      if (match && existsSync(match[0])) paths.push(match[0]);
    } catch {
      /* skip this image — draft text-only */
    }
  }
  return paths;
}

type Source = "wechat" | "gmail" | "slack";

function num(flag: string, def: number): number {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : def;
}
function str(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}
// Like str() but distinguishes "flag absent" from "flag present": settings
// that also live in config/secretary-settings.json need the three-level
// precedence CLI flag > config file > built-in default.
function strOpt(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : undefined;
}

const statePath = resolve(str("--state", resolve(process.cwd(), "state/loop-state.json")));
const personaDir = resolve(str("--personas", resolve(process.cwd(), "personas")));
// 3-layer RAG sources (local-only, gitignored). projects = the project layer;
// leoProfile = how Leo decides + his own durable facts/assets (house, logistics).
const projectsDir = resolve(str("--projects", resolve(process.cwd(), "projects/_staged")));
const leoProfilePath = resolve(process.cwd(), "projects/LEO-DECISION-PROFILE.md");
const leoFactsPath = resolve(process.cwd(), "projects/LEO-FACTS.md");
// Slack's cadence follows the CREDENTIAL, because the two differ by ~50x.
//
// A token from the user's own Slack app is an internal custom app to Slack:
// 50+ requests a minute, so polling every minute is comfortable. Our
// distributed app is capped at 1 request a minute until it is listed on the
// Marketplace — at a one-minute cadence a workspace with six conversations
// would spend every round being throttled, backing off, and arriving later
// than if it had simply waited. Conservative wins there.
//
// Mixed setups take the conservative value: one throttled workspace is enough
// to make a fast loop counterproductive.
const SLACK_MS_UNTHROTTLED = 60_000;
const SLACK_MS_THROTTLED = 600_000;

async function slackIntervalMs(): Promise<number> {
  const explicit = process.argv.some((a) => a.startsWith("--slack-ms"));
  if (explicit) return num("--slack-ms", SLACK_MS_THROTTLED);
  if (SLACK_ACCOUNTS.length === 0) return SLACK_MS_THROTTLED;
  try {
    const kinds = await Promise.all(
      SLACK_ACCOUNTS.map(async ({ account }) => (await resolveSlackCredential(account))?.kind),
    );
    return kinds.every((k) => k === "legacy") ? SLACK_MS_UNTHROTTLED : SLACK_MS_THROTTLED;
  } catch {
    return SLACK_MS_THROTTLED;
  }
}

const intervals: Record<Source, number> = {
  wechat: num("--wechat-ms", 10_000),
  gmail: num("--gmail-ms", 180_000),
  slack: await slackIntervalMs(),
};
const maxDraft = num("--max-draft", 20);
// Drafting backend: "cli" (Claude Code subscription via `claude -p`, no API
// spend — the current default, temporarily standing in for the API), "api"
// (the Anthropic API path), or "deepseek" (DeepSeek chat-completions, key from
// DEEPSEEK_API_KEY env or Keychain). Precedence: --llm/--draft-model flags >
// config/secretary-settings.json (written by the cockpit Settings screen) >
// the cli/opus defaults. The file's mode vocabulary is cli|anthropic|deepseek;
// "anthropic" maps onto the historical internal name "api". loadSettings is
// total — a missing/corrupt file can never stop the daemon from starting.
const fileSettings = loadSettings(statePath);
// The owner's zone anchors every relative date the model resolves. Configured
// in the cockpit; falls back to this machine.
const ownerTimeZone = fileSettings.timezone;
const llmFlag = strOpt("--llm");
const llmMode = (llmFlag ?? fileSettings.llm.mode) === "anthropic" ? "api" : (llmFlag ?? fileSettings.llm.mode);
const draftModel = strOpt("--draft-model") ?? fileSettings.llm.draftModel;
const visionEnabled = process.argv.includes("--vision");
// Task consolidation (specs/task-consolidation.md, Stage 1): group open cards
// that are the same real-world task. ON by default; --no-consolidate opts out.
const consolidateEnabled = !process.argv.includes("--no-consolidate");
// Task refresh (specs/task-consolidation.md, Stage 2): re-read the full thread
// for conversations with an open card + emit calendar actions on agreed meetings.
// ON by default; --no-refresh opts out. --refresh-ttl-min overrides the cooldown.
const refreshEnabled = !process.argv.includes("--no-refresh");
const onceMode = process.argv.includes("--once");
const consolidateTimeoutMs = num("--consolidate-timeout-ms", 600_000);
// --no-draft must ALSO stop polling, because a scan without a drafter still
// ADVANCES CURSORS ("Absent = scan-only (shadow-log + cursors, no queue rows)"),
// which would permanently skip every message that arrived during the run. It
// also means a passes-only run cannot hang on a source: the first attempt sat
// 9 minutes on an unresponsive WeChat MCP server before reaching consolidation.
const noDraft = process.argv.includes("--no-draft");
const refreshTtlMin = num("--refresh-ttl-min", 10);
// How many open conversations to re-read per scan. The default cap of 3 meant a
// full inbox of ~7 open cards took ~3 scans (~90 min) to all catch up. Cover the
// whole open set each scan so every card tracks its latest reply within one cycle.
const refreshMaxPerTick = num("--refresh-max", 12);
const heartbeatPath = `${dirname(statePath)}/notify-heartbeat.json`;
const daemonLockPath = `${dirname(statePath)}/run-notify.pid`;
// Same disk cache the scan loop uses, so a name looked up there is free here.
const SLACK_NAME_CACHE = `${dirname(statePath)}/slack-users.json`;

// Single-instance guard. Parallel Claude sessions kept launching duplicate daemons
// that raced the shared state file (cost real work on 2026-06-28). Refuse to start
// if another run-notify is alive; reclaim a stale lock (PID dead). Returns false →
// caller exits 0 (clean, so launchd KeepAlive=SuccessfulExit doesn't hammer-respawn).
function acquireDaemonLock(): boolean {
  try {
    if (existsSync(daemonLockPath)) {
      const pid = Number(readFileSync(daemonLockPath, "utf8").trim());
      if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, 0); // signal 0 = liveness probe; throws if gone
          // Liveness alone is NOT enough: after a kill -9 the lockfile survives, and
          // the OS eventually REUSES that pid for some unrelated process — then this
          // guard would refuse to start forever ("daemon keeps not running"). Confirm
          // the pid is really a run-notify before yielding to it.
          const cmd = execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], {
            encoding: "utf8",
          });
          if (cmd.includes("run-notify")) return false; // genuinely another instance
          /* pid reused by something else — stale lock, reclaim below */
        } catch {
          /* no such process — stale lock, reclaim below */
        }
      }
    }
    writeFileSync(daemonLockPath, String(process.pid));
    return true;
  } catch {
    return true; // a lockfile fs hiccup shouldn't hard-block the daemon
  }
}
function releaseDaemonLock(): void {
  try {
    if (existsSync(daemonLockPath) && readFileSync(daemonLockPath, "utf8").trim() === String(process.pid))
      unlinkSync(daemonLockPath);
  } catch {
    /* best-effort */
  }
}

async function buildDraft(): Promise<DraftDeps | undefined> {
  // Skipping draft leaves the later passes (refresh/consolidate/plan/sync) to run
  // over EXISTING cards — which is how you iterate on a grouping or ranking
  // prompt without a 20-minute drafting round, and without new cards muddying the
  // before/after.
  if (noDraft) {
    console.log("[notify] drafting DISABLED (--no-draft) — sources are not polled either");
    return undefined;
  }
  try {
    const llm =
      llmMode === "api"
        ? await createAnthropicLlmCaller()
        : llmMode === "deepseek"
          // rawLogPath: capture the raw response whenever a draft comes back
          // empty/unparseable — the silent-skip evidence trail. draftModel MUST
          // be passed (it used to be dropped here, silently pinning the backend
          // to the built-in default regardless of the Settings screen).
          ? await createDeepseekLlmCaller({
              rawLogPath: join(dirname(statePath), "llm-draft-raw.jsonl"),
              model: draftModel,
            })
          : createClaudeCliLlmCaller({ model: draftModel });
    const personas = loadPersonas(personaDir);
    const { resolve: resolvePersona, keys } = buildPersonaResolver(personas);
    // 3-layer RAG: project layer + Leo's decision profile, with his own durable
    // facts/assets appended so a message about his house/logistics has grounding.
    const projects = loadProjects(projectsDir);
    const decisionProfile = loadLeoProfile(leoProfilePath);
    const facts = loadLeoProfile(leoFactsPath).trim();
    const leoProfile = facts
      ? `${decisionProfile}\n\n## LEO'S OWN FACTS / ASSETS (durable; use when a message concerns Leo's house, assets, or family logistics):\n${facts}`
      : decisionProfile;
    console.log(
      `[notify] drafting enabled via ${llmMode} (model=${draftModel}) (${keys.length} personas, ${projects.length} projects, leo-profile ${decisionProfile.trim() ? "on" : "off"})`,
    );
    // Vision is OPT-IN (--vision) and cli-only (claude -p reads the staged image
    // via Read; the API caller has no image blocks yet). Off by default because
    // decode_image can HANG to its full timeout, and that stalls the whole tick
    // (and holds the state lock) — only enable once decode is reliable.
    const vision = visionEnabled && llmMode === "cli" ? { resolveImages } : {};
    if (visionEnabled && llmMode === "cli") console.log("[notify] image vision ENABLED (cli)");
    return { llm, resolvePersona, knownPersonaKeys: keys, projects, leoProfile: leoProfile.trim() || undefined, personas, fetchRelatedThread, ownerTimeZone, ...vision };
  } catch (e) {
    console.log(`[notify] drafting DISABLED — ${(e as Error).message.split("\n")[0]}`);
    return undefined;
  }
}

// ── Stage-2 thread re-read (specs/task-consolidation.md). Per-platform readers,
// lazily built. fetchThread returns the recent thread text (both sides, newest
// last) for a card's conversation, or null when unavailable → that conversation
// is skipped this tick.
// Slack clients + self-ids cached per workspace account (Taiv, OSYX, …).
const slackClients = new Map<string, Promise<SlackClient>>();
const slackSelves = new Map<string, Promise<string>>();
function slackClientForAccount(account: string): Promise<SlackClient> {
  let p = slackClients.get(account);
  if (!p) { p = createSlackClientFromKeychain({}, account); slackClients.set(account, p); }
  return p;
}
function slackSelfForAccount(account: string): Promise<string> {
  let p = slackSelves.get(account);
  if (!p) {
    p = slackClientForAccount(account).then((c) => c.authTest()).then((a) => a.user_id);
    slackSelves.set(account, p);
  }
  return p;
}
const gmailClients = new Map<string, GmailClient>();
function gmailClientFor(email: string): GmailClient {
  let c = gmailClients.get(email);
  if (!c) { c = new GmailClient({ email }); gmailClients.set(email, c); }
  return c;
}

// Returns the LLM-facing text AND, when the reader can supply it, the same
// conversation as structured messages. The text keeps the exact shape the
// refresh prompt was tuned on; the structured form exists because the cockpit
// cannot render a name or a time out of "U07VD53V7M3: hi".
export interface FetchedThread {
  text: string;
  messages?: TranscriptMessage[];
}

// One person, EVERY source their handles reach — the input the persona-update
// pass needs to judge a commitment's state. Its single-thread view is how the
// engine concluded "PCB agreements signed & returned by Yang" from a Gmail
// message on 07-30 and still re-derived the signing as fresh work from the
// (unchanged) Slack thread two weeks later: the two conversations were never in
// front of the model at once.
//
// Slices, each under a labelled header, every line dated:
//   slack  — the rep card's own conversation (fetchThread). By-handle lookup
//            when the rep is from another platform needs conversations.list
//            per workspace; deferred until a real case needs it.
//   gmail  — recent threads exchanged with the persona's address, found by
//            query across our mailboxes. Capped: 2 threads per mailbox, the
//            newest first — the ledger needs recent movement, not an archive.
//   wechat — the persona's chat history, which arrives pre-dated.
// A failing slice is skipped (partial context beats none); all-empty → null so
// the caller can fall back.
async function fetchAllForPerson(persona: Persona, rep: ActionItem): Promise<string | null> {
  const slices: string[] = [];

  const repSlice = await fetchThread(rep).catch(() => null);
  if (repSlice?.text) {
    const platform = rep.source_message_id.split(":")[0] ?? "rep";
    slices.push(`=== ${platform} (rep conversation) ===\n${repSlice.text}`);
  }

  const email = persona.handles?.gmail;
  if (email) {
    for (const mailbox of KNOWN_MAILBOXES) {
      try {
        const list = await gmailClientFor(mailbox).messagesList({
          q: `(from:${email} OR to:${email}) newer_than:21d`,
          maxResults: 10,
        });
        const threadIds = [...new Set((list.messages ?? []).map((m) => m.threadId))].slice(0, 2);
        for (const id of threadIds) {
          if (!id) continue;
          // The rep conversation is already the first slice — do not repeat it.
          if (rep.context?.thread_ref === id) continue;
          const t = await gmailClientFor(mailbox).getThread({ id, format: "full" });
          const text = (t.messages ?? [])
            .map((m) => {
              const ms = Number(m.internalDate ?? 0);
              const day = ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "?";
              return `[${day}] From ${getHeader(m.payload, "From") ?? "?"}:\n${extractText(m)}`;
            })
            .join("\n---\n");
          if (text.trim()) slices.push(`=== gmail (${mailbox}) ===\n${text}`);
        }
      } catch {
        /* one mailbox failing must not sink the person */
      }
    }
  }

  const wechat = persona.handles?.wechat;
  if (wechat && !rep.source_message_id.startsWith("wechat")) {
    try {
      const text = await wechatHistory(wechat, { limit: 60 });
      if (text.trim()) slices.push(`=== wechat ===\n${text}`);
    } catch {
      /* wechat reader down — proceed with what we have */
    }
  }

  return slices.length > 0 ? slices.join("\n\n") : null;
}

async function fetchThread(card: ActionItem): Promise<FetchedThread | null> {
  const prefix = card.source_message_id.split(":")[0];
  try {
    if (prefix === "wechat") {
      const name = card.context?.sender_handle;
      if (!name) return null;
      // Refresh asks "did the conversation move on since this card?" — so it MUST
      // see the latest messages. The default order (no oldest_first, no start) is
      // newest-anchored: the server returns the most-recent `limit` messages, sorted
      // chronologically within that window. Two earlier bugs this avoids:
      //   • `oldest_first:true` with no start re-anchored on the chat's very first
      //     messages (the 古龙换汇 bug);
      //   • `oldest_first:true` + a start floor returns the OLDEST N from the floor,
      //     which TRUNCATES the newest messages in a busy conversation — so 詹毅's
      //     07-06 Damon update was cut off and the card stayed stale.
      // Newest-anchored always includes the latest reply, whatever the volume.
      // WeChat's reader hands back pre-formatted prose, so there is no
      // structure to extract — the cockpit falls back to the text for these.
      return { text: await wechatHistory(name, { limit: 60 }) };
    }
    if (prefix === "slack") {
      const channel = card.source_message_id.split(":")[1];
      if (!channel) return null;
      // The card doesn't record WHICH workspace it came from (the message id is
      // just slack:<channel>:<ts>), so probe each configured account — the
      // workspace that owns this channel returns history, the others throw
      // channel_not_found. First hit wins. So OSYX cards refresh too, not just Taiv.
      for (const { account } of SLACK_ACCOUNTS) {
        try {
          const client = await slackClientForAccount(account);
          const self = await slackSelfForAccount(account);
          const r = await client.conversationsHistory({ channel, limit: 40 });
          if (!r.messages || r.messages.length === 0) continue;
          const ordered = [...r.messages].reverse(); // oldest-first for reading
          const lines: string[] = [];
          const structured: TranscriptMessage[] = [];
          // One users.info round per unseen id, cached on disk across ticks.
          // Speakers AND anyone mentioned inside the text: "<@U08M6C96P2P>"
          // is unreadable, and the cockpit has no way to resolve it later.
          const ids = new Set<string>();
          for (const m of ordered) {
            if (m.user && m.user !== self) ids.add(m.user);
            for (const id of mentionedUserIds(m.text ?? "")) ids.add(id);
          }
          const names = await resolveSlackUserNames(client, [...ids], SLACK_NAME_CACHE);
          const nameOf = (u?: string): string =>
            u === self ? "me" : (u ? names.get(u) ?? u : "?");
          const atOf = (ts?: string): number => (ts ? Math.round(Number(ts) * 1000) : 0);
          // Each line carries its own DATE. Without it the refresh pass has only
          // CURRENT TIME to anchor against, so "Thursday 2-3pm" written two weeks
          // ago resolves onto THIS week — every tick — and a visit that already
          // happened can never expire off the list.
          const dayOf = (ts?: string): string => {
            const ms = atOf(ts);
            return ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "?";
          };
          for (const m of ordered) {
            lines.push(`[${dayOf(m.ts)}] ${m.user === self ? "me" : (m.user ?? "?")}: ${m.text ?? ""}`);
            structured.push({
              speaker: nameOf(m.user),
              self: m.user === self,
              at: atOf(m.ts),
              text: renderSlackText(m.text ?? "", names),
            });
            // Pull thread REPLIES too — conversations.history returns only top-level
            // messages, so a decision made in a thread (e.g. a meeting time confirmed
            // in a reply: "That works for me") is otherwise invisible to the refresh.
            const rc = (m as { reply_count?: number }).reply_count ?? 0;
            if (rc > 0 && m.ts) {
              try {
                const rep = await client.conversationsReplies({ channel, ts: m.ts, limit: 30 });
                for (const t of (rep.messages ?? []).slice(1)) {
                  // slice(1): skip the parent (already added)
                  lines.push(`  ↳ ${t.user === self ? "me" : (t.user ?? "?")}: ${t.text ?? ""}`);
                  structured.push({
                    speaker: nameOf(t.user),
                    self: t.user === self,
                    at: atOf(t.ts),
                    text: renderSlackText(t.text ?? "", names),
                    threadReply: true,
                  });
                }
              } catch {
                /* replies unavailable for this parent → skip */
              }
            }
          }
          return { text: lines.join("\n"), messages: structured };
        } catch {
          /* not this workspace (channel_not_found) → try the next account */
        }
      }
      return null;
    }
    if (prefix === "gmail") {
      const threadId = card.context?.thread_ref;
      if (!threadId) return null; // legacy card without the thread locator
      const mailbox = typeof card.params?.mailbox === "string" ? card.params.mailbox : KNOWN_MAILBOXES[0]!;
      const t = await gmailClientFor(mailbox).getThread({ id: threadId, format: "full" });
      const msgs = t.messages ?? [];
      return {
        // Dated, for the same reason as the Slack lines above: a relative date in
        // an old mail must resolve against ITS date, not against today.
        text: msgs
          .map((m) => {
            const ms = Number(m.internalDate ?? 0);
            const day = ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "?";
            return `[${day}] From ${getHeader(m.payload, "From") ?? "?"}:\n${extractText(m)}`;
          })
          .join("\n---\n"),
        messages: msgs.map((m) => ({
          speaker: getHeader(m.payload, "From") ?? "?",
          // Gmail threads are read for a mailbox we own, but the reader has no
          // cheap "is this me" signal here — leave it false rather than guess.
          self: false,
          at: Number(m.internalDate ?? 0),
          text: extractText(m),
        })),
      };
    }
  } catch {
    return null; // reader unavailable / fetch failed → skip this conversation
  }
  return null;
}

// P10 multi-party: a mentioned third party's recent conversation, by persona handle
// — so a decision with one person can inform + act on another. Recency-windowed,
// best-effort (null when unavailable). WeChat (by chat name), Slack (DM via the IM
// map, probing each workspace), Gmail (newest thread with that email). The slack IM
// map (user id → DM channel) is cached per account so it's listed once.
const slackImMaps = new Map<string, Promise<Map<string, string>>>();
function slackImMap(account: string): Promise<Map<string, string>> {
  let p = slackImMaps.get(account);
  if (!p) {
    p = slackClientForAccount(account)
      .then((c) => c.listAllConversations({ types: "im" }))
      .then((ims) => {
        const m = new Map<string, string>();
        for (const im of ims) {
          const u = (im as { user?: string }).user;
          if (u && im.id) m.set(u, im.id);
        }
        return m;
      })
      .catch(() => new Map<string, string>());
    slackImMaps.set(account, p);
  }
  return p;
}

async function fetchRelatedThread(p: Persona): Promise<string | null> {
  try {
    if (p.handles?.wechat) {
      const start = new Date(Date.now() - 14 * 24 * 3600_000).toISOString().slice(0, 10);
      return await wechatHistory(p.displayName, { limit: 30, oldestFirst: true, start });
    }
    if (p.handles?.slack) {
      const userId = p.handles.slack;
      for (const { account } of SLACK_ACCOUNTS) {
        const channel = (await slackImMap(account)).get(userId);
        if (!channel) continue;
        const self = await slackSelfForAccount(account);
        const r = await (await slackClientForAccount(account)).conversationsHistory({ channel, limit: 25 });
        if (!r.messages || r.messages.length === 0) continue;
        return [...r.messages]
          .reverse()
          .map((m) => `${m.user === self ? "me" : "them"}: ${m.text ?? ""}`)
          .join("\n");
      }
      return null;
    }
    if (p.handles?.gmail) {
      const mailbox = KNOWN_MAILBOXES[0]!;
      const list = await gmailClientFor(mailbox).messagesList({
        q: `from:${p.handles.gmail} OR to:${p.handles.gmail}`,
        maxResults: 1,
      });
      const tid = list.messages?.[0]?.threadId;
      if (!tid) return null;
      const t = await gmailClientFor(mailbox).getThread({ id: tid, format: "full" });
      return (t.messages ?? [])
        .map((m) => `From ${getHeader(m.payload, "From") ?? "?"}:\n${extractText(m)}`)
        .join("\n---\n");
    }
  } catch {
    /* reader unavailable → skip this third party */
  }
  return null;
}

async function buildRefresh(): Promise<RefreshDeps | undefined> {
  if (!refreshEnabled) return undefined;
  try {
    const llm =
      llmMode === "api"
        ? await createAnthropicLlmCaller()
        : llmMode === "deepseek"
          ? await createDeepseekLlmCaller({ model: draftModel })
          : createClaudeCliLlmCaller({ model: draftModel });
    const { resolve: resolvePersona } = buildPersonaResolver(loadPersonas(personaDir));
    const projectCatalog = renderProjectCatalog(loadProjects(projectsDir));
    console.log(`[notify] task refresh enabled via ${llmMode} (TTL ${refreshTtlMin}min)`);
    // Same tool keys drafting gets: refresh can now emit a ticket, and without
    // the keys it would guess a params.tool the registry rejects.
    return {
      llm,
      resolvePersona,
      fetchThread,
      projectCatalog,
      toolKeys: Object.keys(effectiveToolSpecs(statePath)),
      ownerTimeZone,
      personas: loadPersonas(personaDir),
      ttlMs: refreshTtlMin * 60_000,
      maxPerTick: refreshMaxPerTick,
    };
  } catch (e) {
    console.log(`[notify] refresh DISABLED — ${(e as Error).message.split("\n")[0]}`);
    return undefined;
  }
}

// The TickTick sync writer, or undefined when TickTick is not connected — in
// which case the sync phase is skipped and the cockpit stays the only surface.
// Same config shape the executor reads (SETUP.md §5).
function buildTickTickWriter(): TickTickWriter | undefined {
  const cfg = effectiveToolSpecs(statePath).ticktick?.config ?? {};
  if (cfg.type !== "mcp" || !cfg.url) {
    console.log("[notify] TickTick sync OFF — no ticktick url in config/tools.json");
    return undefined;
  }
  console.log(`[notify] TickTick sync ON → ${cfg.project ?? "(Inbox)"}`);
  return createTickTickWriter({
    url: cfg.url,
    authService: mcpAuthServiceFor("ticktick", cfg.authService),
    ...(cfg.project ? { project: cfg.project } : {}),
  });
}

// The read side (PHASE 6a). Same config as the writer — if the push is on, the
// read-back is on, because a list you write to but never read from is exactly
// how finished work stayed open forever.
function buildTickTickReader(): TickTickReader | undefined {
  const cfg = effectiveToolSpecs(statePath).ticktick?.config ?? {};
  if (cfg.type !== "mcp" || !cfg.url || !cfg.project) return undefined;
  return createTickTickReader({
    url: cfg.url,
    authService: mcpAuthServiceFor("ticktick", cfg.authService),
    project: cfg.project,
  });
}

async function buildConsolidate(): Promise<ConsolidateDeps | undefined> {
  if (!consolidateEnabled) return undefined;
  try {
    const json =
      llmMode === "api"
        ? await createAnthropicJsonCaller()
        : llmMode === "deepseek"
          ? await createDeepseekJsonCaller({ model: draftModel })
          // Consolidation is ONE call that must re-list every open card, so it
          // scales with the queue, not with the tick. At 73 open cards it blew
          // through the 180s default and left every grouping untouched — twice,
          // silently, while a prompt fix was being "tested" against it.
          : createClaudeCliJsonCaller({ model: draftModel, timeoutMs: consolidateTimeoutMs });
    console.log(
      `[notify] task consolidation enabled via ${llmMode} (timeout ${consolidateTimeoutMs / 1000}s)`,
    );
    return { json };
  } catch (e) {
    console.log(`[notify] consolidation DISABLED — ${(e as Error).message.split("\n")[0]}`);
    return undefined;
  }
}

async function buildPlan(): Promise<PlanDeps | undefined> {
  if (process.argv.includes("--no-plan")) return undefined;
  try {
    const json =
      llmMode === "api"
        ? await createAnthropicJsonCaller()
        : llmMode === "deepseek"
          ? await createDeepseekJsonCaller({ model: draftModel })
          : createClaudeCliJsonCaller({ model: draftModel });
    console.log(`[notify] daily plan (ranking) enabled via ${llmMode}`);
    return { json };
  } catch (e) {
    console.log(`[notify] plan DISABLED — ${(e as Error).message.split("\n")[0]}`);
    return undefined;
  }
}

async function buildPersonaUpdate(): Promise<PersonaUpdateDeps | undefined> {
  if (process.argv.includes("--no-persona-update")) return undefined;
  try {
    const json =
      llmMode === "api"
        ? await createAnthropicJsonCaller()
        : llmMode === "deepseek"
          ? await createDeepseekJsonCaller({ model: draftModel })
          : createClaudeCliJsonCaller({ model: draftModel });
    const { resolve: resolvePersona } = buildPersonaResolver(loadPersonas(personaDir));
    console.log(`[notify] persona commitments update enabled via ${llmMode}`);
    return {
      json,
      resolvePersona,
      fetchAllForPerson,
      personaDir,
    };
  } catch (e) {
    console.log(`[notify] persona update DISABLED — ${(e as Error).message.split("\n")[0]}`);
    return undefined;
  }
}

// In-process mutex: only one tick runs at a time (so ticks never collide on
// the state file lock, regardless of which timer fires).
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(() => undefined, () => undefined);
  return run as Promise<T>;
}

async function main(): Promise<void> {
  mkdirSync(dirname(statePath), { recursive: true });
  if (!acquireDaemonLock()) {
    console.log(`[notify] another run-notify instance is already running (see ${daemonLockPath}); exiting cleanly.`);
    process.exit(0);
  }
  console.log(`[notify] state=${statePath}`);
  console.log(`[notify] ${describeIdentity()}`);
  console.log(`[notify] timezone: ${ownerTimeZone}`);
console.log(
  `[notify] cadence: wechat=${intervals.wechat / 1000}s gmail=${intervals.gmail / 1000}s ` +
    `slack=${intervals.slack / 1000}s (${intervals.slack === SLACK_MS_UNTHROTTLED ? "own-app token, unthrottled" : "rate-limited credential or override"})`,
);
  const draft = await buildDraft();
  const consolidate = await buildConsolidate();
  const refresh = await buildRefresh();
  const plan = await buildPlan();
  const personaUpdate = await buildPersonaUpdate();
  const ticktickWriter = buildTickTickWriter();
  const ticktickReader = buildTickTickReader();

  let consecutiveErrors = 0;

  const tick = (source: Source): Promise<void> =>
    serialize(async () => {
      try {
        const r: ScanLoopResult = await runScanTick({
          statePath,
          // No drafter → nothing to do with inbound messages, and polling would
          // advance cursors past them. See noDraft above.
          sources: noDraft ? [] : [source],
          draft,
          consolidate,
          refresh,
          plan,
          personaUpdate,
          ownerTimeZone,
          ...(ticktickWriter ? { ticktickWriter } : {}),
          ...(ticktickReader ? { ticktickReader } : {}),
          maxDraftCandidates: maxDraft,
        });
        if (r.totalInbound > 0 || r.drafted > 0) {
          console.log(
            `[notify:${source}] inbound=${r.totalInbound} triggered=${r.totalTriggered} drafted=${r.drafted} (${r.durationMs}ms)`,
          );
        }
        writeFileSync(
          heartbeatPath,
          JSON.stringify({ source, atMs: r.startedAtMs, drafted: r.drafted, durationMs: r.durationMs }),
        );
        consecutiveErrors = 0;
      } catch (e) {
        console.error(`[notify:${source}] ERROR: ${(e as Error).message}`);
        if (++consecutiveErrors === 5) {
          void notify({ title: "Secretary notify failing", body: (e as Error).message.slice(0, 200) });
        }
      }
    });

  const sources: Source[] = ["wechat", "gmail", "slack"];

  // One tick per source, sequentially, then exit — no timers, no daemon. tick()
  // already swallows its own errors, so a failing source cannot strand the run
  // with the lock held.
  if (onceMode) {
    for (const s of sources) await tick(s);
    console.log("[notify] --once complete");
    releaseDaemonLock();
    process.exit(0);
  }

  // Stagger the initial ticks so they don't queue up at once; then interval.
  sources.forEach((s, i) => {
    setTimeout(() => void tick(s), i * 2000);
    setInterval(() => void tick(s), intervals[s]);
  });

  const shutdown = (sig: string): void => {
    console.log(`[notify] ${sig} — shutting down`);
    releaseDaemonLock();
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("exit", releaseDaemonLock);
  setInterval(() => {}, 1 << 30).unref();
}

main().catch((e) => {
  console.error("[notify] crashed:", (e as Error).message);
  process.exit(1);
});
