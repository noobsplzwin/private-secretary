// Single scan tick. Fires on the scheduler's interval (or once via the
// CLI), reads new messages from every Direct-API source, runs the
// trigger filter, persists cursor advances + a shadow-log record, and
// returns a per-source summary.
//
// This is the FALLBACK PRE-LLM path: we record everything but don't yet
// drive Claude to draft action items. Drafting lives in the cockpit/LLM
// integration that ships in the T-cockpit / T-llm slabs. Until then the
// shadow-log is the audit trail and the marks/sourceErrors fields
// continue to track cursors per source.
//
// Per-source fault isolation: a failing Slack channel or Gmail mailbox
// records itself in sourceErrors and does NOT advance its cursor; the
// other sources still get processed. This matches the /relay skill's
// existing semantics so swapping the skill out for a daemon is a no-op
// from loop-state's point of view.

import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendShadowRecord } from "../io/shadow-log.js";
import {
  buildShadowRecord,
  shouldWriteShadowRecord,
  type ShadowFilterRejection,
  type ShadowRecordInput,
} from "../core/shadow.js";
import { advance, isNew } from "../core/dedup.js";
import { appendActivity, activityPathFor, type ActivityKind } from "../io/activity-log.js";
import { evaluateTrigger, isAutomatedSender } from "../core/trigger-filter.js";
import { acquireLock, loadState, releaseLock, saveState, type LoopState } from "../io/state.js";
import { appendLabels, buildLabel, labelsPathFor } from "../io/labels.js";
import type { InboundMessage } from "../core/types.js";
import type { ActionItem } from "../core/action-item.js";
import {
  isCalendarRedundant,
  isSupersedeExempt,
  redundantPendingCalendarIds,
} from "../core/action-item.js";
import { draftActions, type DraftDeps } from "./draft.js";
import { clusterKey, unitKey, inheritSupersededTaskIds } from "../core/unit-key.js";
import { executeAction, type ExecuteDeps } from "./execute.js";
import { approveAction } from "../core/action-item.js";
import { syncToTickTick, cardRows, readbackFromTickTick, taskUnitsFrom, type TickTickWriter, type TickTickReader } from "./ticktick-sync.js";
import type { TaskUnit } from "../core/ticktick-plan.js";
import { deriveLedgerTasks } from "../core/ledger-list.js";
import { markAssessed, personsNeedingAssessment, recordTraffic } from "../core/person-queue.js";
import type { Commitment } from "../core/persona-v3.js";
import { loadSyncMap, saveSyncMap } from "../io/ticktick-sync-store.js";
import { machineTimeZone } from "../io/settings.js";
import { updatePersonaCommitments, type PersonaUpdateDeps } from "./persona-update.js";
import { scanSlackDirect } from "../sources/slack-direct.js";
import { resolveSlackUserNames } from "../io/slack-users.js";
import type { SlackClient } from "../io/slack-api.js";
import { GmailClient } from "../io/gmail-api.js";
import { scanGmailDirect } from "../sources/gmail-direct.js";
import {
  createSlackClientFromKeychain,
  SLACK_ACCOUNTS,
  SLACK_TOKEN_ACCOUNT,
} from "../io/slack-api.js";

export interface ScanLoopOptions {
  // Absolute path to loop-state.json. The scan-loop owns lock acquire +
  // atomic save; callers shouldn't poke this file mid-scan.
  statePath: string;
  // Optional Slack client; if omitted, built from Keychain.
  slackClient?: SlackClient;
  // Optional filter for which Slack channels to poll. By default we
  // ONLY poll IMs (1:1 DMs) + MPIMs (group DMs). Polling all 400+
  // workspace channels would take minutes per tick and most of them
  // never address the user. Set to "all" to poll everything (you almost
  // never want this in steady state).
  slackChannelScope?: "ims-and-mpims" | "ims-only" | "all";
  // Optional Gmail clients keyed by email; if omitted, built from the
  // KNOWN_MAILBOXES list using the per-mailbox Keychain bundles.
  gmailClients?: Record<string, GmailClient>;
  // Force a "wake" tick — widens windows and treats this scan as a
  // catch-up after sleep.
  onWake?: boolean;
  // If true, do NOT actually mutate state — useful for a dry-run smoke.
  dryRun?: boolean;
  // When provided, filtered candidates are drafted into ActionItems via
  // the LLM and committed to the queue. Absent = scan-only (shadow-log +
  // cursors, no queue rows) — the pre-LLM behaviour.
  draft?: DraftDeps;
  // Cap on how many candidates get drafted this tick (cost control for a
  // cold-cursor catch-up — the first real run can surface thousands).
  // When more candidates exist than the cap, the NEWEST are drafted and
  // the rest are reported in `draftSkipped` (NOT silently dropped). Undefined
  // = draft all candidates (steady state, where each tick's delta is small).
  maxDraftCandidates?: number;
  // When provided, a task-consolidation pass runs after drafting: groups open
  // cards that are the same real-world task under a shared task_id (cross-sender).
  // Absent = no consolidation (each card stays its own cluster). See
  // specs/task-consolidation.md (Stage 1).

  // When provided, a task-refresh pass runs after consolidation: re-reads the
  // full thread for conversations that already have an open card and re-decides
  // the card (updates it, or emits a calendar action when a meeting was agreed).
  // See specs/task-consolidation.md (Stage 2).
  // When provided, a daily-plan pass runs after refresh: ranks all open task
  // specs/daily-todo.md.
  // When provided, the ranked to-do list is pushed into TickTick after the plan
  // pass (specs/ticktick-migration.md). Absent = no sync, and the cockpit stays
  // the only surface.
  ticktickWriter?: TickTickWriter;
  /** Read side: completions the owner ticked off in TickTick (PHASE 6a). */
  ticktickReader?: TickTickReader;
  /** Personas WITH their commitment ledgers — the LIST's source (PHASE 6b). */
  /** Tick-to-execute (invites/tool items). Absent → a ticked line records done only. */
  execute?: Omit<ExecuteDeps, "persistClaim">;
  ledgerPersonas?: () => ReadonlyArray<{ key: string; display_name?: string; commitments?: Commitment[] }>;
  /** The owner's live matter ids (io/matters.ts). Absent is survivable now that
   * the verdict promotes: an unfiled row still reaches him. */
  activeMatters?: () => ReadonlySet<string>;
  /** The matters he CLOSED — work inside one sinks whatever the verdict says. */
  closedMatters?: () => ReadonlySet<string>;
  /** Owner's IANA zone for TickTick due dates / time labels. */
  ownerTimeZone?: string;
  // When provided, a persona-update pass runs after planning: extracts NEW
  // commitments from each open contact's thread and writes them to the persona's
  // Commitments Ledger via the R1 chokepoint (Phase B, specs/persona-v3.md).
  personaUpdate?: PersonaUpdateDeps;
  /**
   * Maps a raw sender handle to a persona key, for the person-first traffic
   * cursor. Deliberately NOT part of personaUpdate: traffic is recorded even
   * when the person pass is off, so enabling it later does not start blind.
   */
  resolvePersonaKey?: (handle: string) => string | null;
  /** Contacts assessed per tick. Bounds one busy hour's fan-out. */
  maxPersonsPerTick?: number;
  // Which sources to poll this tick. Notification mode runs each source on
  // its OWN cadence (WeChat fast / Gmail medium / Slack slow), so each timer
  // calls runScanTick with a single source. Default = slack+gmail (the
  // pre-notification behaviour; WeChat is opt-in).
  sources?: Array<"slack" | "gmail" | "wechat">;
  // WeChat (injectable for tests): get_recent_sessions text + per-contact
  // get_chat_history text. Prod defaults to wechatSessions / wechatHistory.
  wechatFetchSessions?: () => Promise<string>;
  wechatFetchHistory?: (name: string, limit: number) => Promise<string>;
  // get_contacts text, for filtering out 公众号/服务号. Defaults to a cached
  // get_contacts call.
  wechatFetchContacts?: () => Promise<string>;
}

export interface SourceSummary {
  source: string;
  inboundCount: number;
  triggered: number;
  filtered: number;
  newCursor?: string;
  error?: string;
}

export interface ScanLoopResult {
  startedAtMs: number;
  durationMs: number;
  perSource: SourceSummary[];
  totalInbound: number;
  totalTriggered: number;
  shadowWritten: boolean;
  // # of ActionItems the LLM drafted into the queue this tick (0 when
  // drafting is disabled).
  drafted: number;
  // # of triggered candidates NOT drafted this tick because they exceeded
  // maxDraftCandidates. The NEWEST were drafted; this counts the older
  // remainder. They keep their cursor mark (so they won't re-surface) — a
  // deliberate cost-control drop, reported here so it's never silent.
  draftSkipped: number;
  // # of Gmail messages excluded at ingestion as non-primary (promo /
  // newsletter / social / forums). Counted (not silent) so a mis-filter of
  // real mail is detectable; each is also in the shadow log with its reason.
  promoFiltered: number;
}

// Single source-error normalizer so a thrown SlackApiError / GmailApiError
// / unrelated crash all land as the same shape in sourceErrors.
function errString(e: unknown): string {
  const err = e as { message?: string };
  return err.message ?? String(e);
}

// ─── Slack tick ─────────────────────────────────────────────────────

interface SlackSliceState {
  channels: Record<string, { lastTs: string }>;
}

// Per-account cursor slice key. Taiv keeps the legacy "_slackDirect" key (so its
// existing cursors survive); each additional workspace gets its own namespaced
// slice, so two workspaces sharing a channel id can't clobber each other's
// per-channel slack-ts pointers.
function slackSliceKey(account: string): string {
  return account === SLACK_TOKEN_ACCOUNT ? "_slackDirect" : `_slackDirect__${account}`;
}

function getSlackState(
  stateMarks: Record<string, { lastTimestampMs: number; seenIds: string[] }>,
  account: string,
): SlackSliceState {
  // We use marks for round-commit dedup at the message-id level; the
  // Slack-direct cursor is a separate per-channel slack-ts pointer. Stash
  // it in a per-account sibling subfield. loadState tolerates unknown fields
  // (it only reads the typed slots) so writing here doesn't break the schema.
  const key = slackSliceKey(account);
  const meta = (stateMarks as unknown as Record<string, SlackSliceState | undefined>)[key];
  return meta ?? { channels: {} };
}

function setSlackState(
  stateMarks: Record<string, { lastTimestampMs: number; seenIds: string[] }>,
  account: string,
  next: SlackSliceState,
): void {
  (stateMarks as unknown as Record<string, SlackSliceState | undefined>)[slackSliceKey(account)] = next;
}

// ─── Gmail tick ─────────────────────────────────────────────────────

interface GmailSliceState {
  mailboxes: Record<string, { historyId: string }>;
}

function getGmailState(stateMarks: Record<string, { lastTimestampMs: number; seenIds: string[] }>): GmailSliceState {
  const meta = (stateMarks as unknown as { _gmailDirect?: GmailSliceState })._gmailDirect;
  return meta ?? { mailboxes: {} };
}

function setGmailState(
  stateMarks: Record<string, { lastTimestampMs: number; seenIds: string[] }>,
  next: GmailSliceState,
): void {
  (stateMarks as unknown as { _gmailDirect?: GmailSliceState })._gmailDirect = next;
}

// Cached 公众号/服务号 display-name set (get_contacts is heavy; refresh every
// 10 min). Module-level so it persists across ticks within a daemon process.
let officialAcctCache: { names: Set<string>; atMs: number } | null = null;
const OFFICIAL_ACCT_TTL_MS = 10 * 60 * 1000;

// Consolidation runs on every tick that drafted new cards; when nothing new was
// drafted but pre-existing cards are still ungrouped, it re-attempts at most
// once per this idle window (so we don't spend an LLM call every 30s tick).
let lastConsolidateMs = 0;
const CONSOLIDATE_IDLE_MS = 30 * 60 * 1000;

// Daily-plan (ranking) re-runs when new cards were drafted, else at most once per
// this idle window (ranking is global + costs an LLM call).
let lastPlanMs = 0;
const PLAN_IDLE_MS = 30 * 60 * 1000;

// Error-only ticks repeat verbatim every poll while a source is down (a dead
// WeChat MCP logs the same ERR line every 10s — ~8k/day of pure noise that
// would bury the signal). Suppress exact repeats: the FIRST occurrence and
// every CHANGE (error appears, message changes) is logged.
// Keyed PER errored-source-set: alternating single-source ticks (wechat ERR,
// gmail ERR, wechat ERR…) each differ from their immediate predecessor, so a
// single "last sig" slot lets them all through. Module-level so it persists
// across ticks within a daemon process.
const lastErrorTickSigByScope = new Map<string, string>();

// ─── one tick ───────────────────────────────────────────────────────

// Acquire the state lock, retrying briefly. Used for the phase-3 re-acquire:
// the only competitor is the cockpit, which holds the lock for a single fast
// mutation, so a few short retries reliably win it back.
async function acquireLockWithRetry(stateDir: string, tries = 10, delayMs = 200): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (acquireLock(stateDir)) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

export async function runScanTick(opts: ScanLoopOptions): Promise<ScanLoopResult> {
  const startedAtMs = Date.now();
  const perSource: SourceSummary[] = [];
  const sourceMessages: InboundMessage[] = [];
  // P0: carry the message TEXT of everything we filter out. Without it the
  // trigger filter's recall is unmeasurable (and recall cannot be recovered from
  // the approve/skip log — that only covers what was surfaced).
  const filteredOut: ShadowFilterRejection[] = [];
  const sourceErrors: Record<string, string> = {};
  let promoFiltered = 0; // Gmail non-primary mail dropped at ingestion this tick
  // Hoisted so phase 2 (drafting, unlocked) + phase 3 (commit) can read them.
  let draftInput: InboundMessage[] = [];
  let draftSkipped = 0;

  const stateDir = dirname(opts.statePath);
  // Activity-log sink for this tick (F3): one JSONL line per engine event,
  // beside the state file. NEVER throws — the log narrates the engine, it
  // must never break it; dryRun narrates nothing.
  const activityPath = activityPathFor(opts.statePath);
  const logActivity = (kind: ActivityKind, summary: string, data?: Record<string, unknown>): void => {
    if (opts.dryRun) return;
    try {
      appendActivity(activityPath, {
        at: new Date().toISOString(),
        kind,
        summary,
        ...(data ? { data } : {}),
      });
    } catch {
      /* logging is observability, never a failure mode */
    }
  };
  // PHASE 0 (UNLOCKED snapshot): take a consistent read of state WITHOUT the
  // lock. saveState writes atomically (tmp + rename) and carries a revision
  // guard, so an unlocked read sees old-or-new bytes, never a torn file —
  // exactly like the cockpit's lockless getState. The daemon OWNS cursors /
  // marks / sourceErrors (the cockpit only ever mutates state.actions), so
  // reading them here lock-free is race-free; the brief phase-3 commit reloads
  // fresh state under a (retrying) lock and transplants our daemon-owned fields.
  // Holding NO lock through the slow scan + draft + consolidate + refresh means a
  // tick can never fail with "another tick is running" just because the cockpit
  // (or a prior commit) briefly held the lock — that was the source of the
  // intermittent contention noise.
  let state: LoopState;
  try {
    state = loadState(opts.statePath);
    const sources = opts.sources ?? ["slack", "gmail"];

    // ── Slack pass (one per workspace account) ─────────────────
    // Each configured workspace is scanned via its own Keychain token, its own
    // selfId (authTest inside scanSlackDirect → self-message filter is correct
    // per account), its own cursor slice, and its own source label. A failing
    // account is isolated and never sinks the others. An injected client (tests)
    // scans as the single Taiv account.
    if (sources.includes("slack")) {
      const slackMarks = state.marks as Record<string, { lastTimestampMs: number; seenIds: string[] }>;
      const slackAccounts = opts.slackClient
        ? [{ account: SLACK_TOKEN_ACCOUNT, label: "slack:direct", client: opts.slackClient }]
        : SLACK_ACCOUNTS.map((a) => ({ ...a, client: undefined as SlackClient | undefined }));
      // Default scope: just DMs and group DMs. Iterating all 400+ workspace
      // channels would take minutes per tick and most wouldn't address the user.
      const scope = opts.slackChannelScope ?? "ims-and-mpims";
      for (const acct of slackAccounts) try {
        const slack = acct.client ?? (await createSlackClientFromKeychain({}, acct.account));
        const prev = getSlackState(slackMarks, acct.account);
        const allChannels = await slack.listAllConversations();
        const channels = scope === "all"
          ? allChannels
          : allChannels.filter((c) => {
              if (scope === "ims-only") return c.is_im === true;
              return c.is_im === true || c.is_mpim === true;
            });
        const r = await scanSlackDirect({
          client: slack,
          channels,
          state: prev,
          perChannelLimit: opts.onWake ? 500 : 200,
        });
        // Cosmetic display names: resolve this tick's distinct sender IDs →
        // Slack display names via a 24h disk cache (relay/io/slack-users.ts),
        // so cards show a name instead of "U0B…". Cost is bounded — one
        // users.info per uncached id — and every failure is silent (the raw
        // ID fallback remains). Self messages never reach r.inbound
        // (pollResultToInbound drops them).
        try {
          const names = await resolveSlackUserNames(
            slack,
            r.inbound.map((m) => m.senderHandle),
            join(stateDir, "slack-users.json"),
          );
          for (const m of r.inbound) {
            const n = names.get(m.senderHandle);
            if (n) m.senderName = n;
          }
        } catch {
          // name resolution is best-effort
        }
        if (!opts.dryRun) setSlackState(slackMarks, acct.account, r.nextState);
        let triggered = 0;
        let filtered = 0;
        for (const m of r.inbound) {
          const decision = evaluateTrigger(m);
          if (decision.relay) {
            triggered++;
            sourceMessages.push(m);
          } else if (decision.reason === "already-answered") {
            // NOT dropped any more. evaluateTrigger only answers "does this
            // deserve a REPLY" — using it as the total gate discarded 1,550
            // messages unseen, and those are where the owner's own commitments
            // live ("好", "我去订", a confirmed appointment). Analysed here for
            // task / calendar; core/trigger-filter.mayProduceActionType blocks
            // a second reply deterministically.
            triggered++;
            sourceMessages.push(m);
          } else {
            filtered++;
            filteredOut.push({ id: m.id, reason: decision.reason, text: m.text, sender: m.senderHandle, platform: m.platform });
          }
        }
        // Per-channel failures are isolated inside scanSlackDirect: the
        // healthy channels still advanced their cursors above. Surface the
        // failures without discarding those successes.
        const partialErr = r.errors.length
          ? r.errors.map((e) => `channel=${e.channelId}: ${e.error}`).join("; ")
          : undefined;
        if (partialErr) sourceErrors[acct.label] = partialErr;
        perSource.push({
          source: acct.label,
          inboundCount: r.inbound.length,
          triggered,
          filtered,
          ...(partialErr ? { error: partialErr } : {}),
        });
      } catch (e) {
        sourceErrors[acct.label] = errString(e);
        perSource.push({
          source: acct.label,
          inboundCount: 0,
          triggered: 0,
          filtered: 0,
          error: errString(e),
        });
      }
    }

    // ── Gmail pass (all 4 mailboxes via google-oauth.KNOWN_MAILBOXES) ─
    if (sources.includes("gmail")) try {
      const { KNOWN_MAILBOXES } = await import("../io/google-oauth.js");
      const clients: Record<string, GmailClient> =
        opts.gmailClients ??
        Object.fromEntries(
          KNOWN_MAILBOXES.map((email) => [email, new GmailClient({ email })]),
        );
      const prev = getGmailState(state.marks as Record<string, { lastTimestampMs: number; seenIds: string[] }>);
      const r = await scanGmailDirect({
        clients,
        state: prev,
        bootstrapWindowDays: opts.onWake ? 14 : 7,
        perMailboxLimit: opts.onWake ? 400 : 200,
      });
      if (!opts.dryRun) {
        setGmailState(
          state.marks as Record<string, { lastTimestampMs: number; seenIds: string[] }>,
          r.nextState,
        );
      }
      let triggered = 0;
      let filtered = 0;
      // Gmail: the LLM is the judge of whether a new email becomes a card. We
      // do NOT apply the deterministic addressed-to-user / already-answered
      // gate here (those heuristics drop real mail — list/forwarded/cc-only —
      // that the LLM should weigh). We keep only the cheap automated-sender
      // guard: noreply/mailer-daemon/notifications are machine mail, never
      // person-to-person (the hard constraint) and not worth a draft token.
      // Everything else goes to drafting; the LLM returns ignore (→ auto-
      // handled, no human card) or reply/task/calendar (→ a card).
      for (const m of r.inbound) {
        if (isAutomatedSender(m.senderHandle)) {
          filtered++;
          filteredOut.push({ id: m.id, reason: "bot-or-noreply", text: m.text, sender: m.senderHandle, platform: m.platform });
        } else {
          triggered++;
          sourceMessages.push(m);
        }
      }
      // Promo/non-primary mail dropped at ingestion (before the trigger
      // filter). Fold into filteredOut so each is dedup-marked seen + recorded
      // in the shadow log with its reason; count it so a mis-filter of
      // real mail is detectable. It never reaches drafting. Self-sent mail
      // ("gmail:self") is logged the same way but is NOT promo — don't count
      // it in the promo metric.
      for (const f of r.filtered) {
        filtered++;
        if (f.reason !== "gmail:self") promoFiltered++;
        filteredOut.push({ id: f.id, reason: f.reason });
      }
      // Per-mailbox failures are isolated inside scanGmailDirect: healthy
      // mailboxes advanced their cursors above. Surface failures without
      // discarding those successes.
      const partialErr = r.errors.length
        ? r.errors.map((e) => `mailbox=${e.mailbox}: ${e.error}`).join("; ")
        : undefined;
      if (partialErr) sourceErrors["gmail:direct"] = partialErr;
      perSource.push({
        source: "gmail:direct",
        inboundCount: r.inbound.length + r.filtered.length,
        triggered,
        filtered,
        ...(partialErr ? { error: partialErr } : {}),
      });
    } catch (e) {
      sourceErrors["gmail:direct"] = errString(e);
      perSource.push({
        source: "gmail:direct",
        inboundCount: 0,
        triggered: 0,
        filtered: 0,
        error: errString(e),
      });
    }

    // ── WeChat pass (local-DB; 1:1 only) ───────────────────────────
    // Trigger on unread sessions (get_recent_sessions), pull the actual
    // incoming messages with direction + full context (get_chat_history).
    if (sources.includes("wechat")) try {
      const { scanWechatInbox, parseOfficialAccountNames } = await import("../sources/wechat-direct.js");
      const { wechatSessions, wechatHistory, wechatRaw } = await import("../io/wechat-cli.js");
      // 公众号/服务号 set (gh_ accounts) to drop. get_contacts is heavy, so cache
      // it — the set barely changes. Stale-on-error: never block the scan on it.
      const fetchContacts =
        opts.wechatFetchContacts ?? (() => wechatRaw("get_contacts", { query: "", limit: 1000 }));
      let officialNames =
        officialAcctCache && startedAtMs - officialAcctCache.atMs < OFFICIAL_ACCT_TTL_MS
          ? officialAcctCache.names
          : undefined;
      if (!officialNames) {
        try {
          officialNames = parseOfficialAccountNames(await fetchContacts());
          officialAcctCache = { names: officialNames, atMs: startedAtMs };
        } catch {
          officialNames = officialAcctCache?.names; // keep the last good set if any
        }
      }
      const r = await scanWechatInbox({
        fetchSessions: opts.wechatFetchSessions ?? (() => wechatSessions({ limit: 30 })),
        fetchHistory:
          opts.wechatFetchHistory ?? ((name, limit) => wechatHistory(name, { limit })),
        officialNames,
        nowMs: startedAtMs,
      });
      // The unread set is the full current state each tick; persisted marks
      // dedup at the id level so a restart / re-poll re-surfaces ONLY genuinely
      // new incoming messages (never swallows, never re-cards a handled one).
      const fresh = r.inbound.filter((m) =>
        isNew(m.source, m.id, m.timestampMs, state.marks),
      );
      let triggered = 0;
      let filtered = 0;
      for (const m of fresh) {
        const decision = evaluateTrigger(m);
        if (decision.relay) {
          triggered++;
          sourceMessages.push(m);
        } else {
          filtered++;
          filteredOut.push({ id: m.id, reason: decision.reason, text: m.text, sender: m.senderHandle, platform: m.platform });
        }
      }
      perSource.push({
        source: "wechat:direct",
        inboundCount: fresh.length,
        triggered,
        filtered,
      });
    } catch (e) {
      sourceErrors["wechat:direct"] = errString(e);
      perSource.push({
        source: "wechat:direct",
        inboundCount: 0,
        triggered: 0,
        filtered: 0,
        error: errString(e),
      });
    }

    // ── persist sourceErrors + advance per-message marks ────────
    if (!opts.dryRun) {
      // sourceErrors: any error this tick is recorded; sources that
      // succeeded clear their entry. (matches /relay skill behaviour)
      const okSources = perSource
        .filter((s) => !s.error)
        .map((s) => s.source);
      for (const src of okSources) delete state.sourceErrors[src];
      const nowIso = new Date(startedAtMs).toISOString();
      for (const [src, message] of Object.entries(sourceErrors)) {
        state.sourceErrors[src] = { message, at: nowIso };
      }
      // Mark every seen message in core/dedup so the existing
      // cursor-check helper sees them as "seen" if the LLM-driven path
      // ever asks. We advance one marks slot per source bucket so we
      // don't blow up seenIds with thousands of ids per mailbox.
      let marks = state.marks;
      for (const m of sourceMessages) {
        marks = advance(m.source, m.id, m.timestampMs, marks);
      }
      for (const f of filteredOut) {
        // Filtered messages still need to be "seen" so we don't
        // re-evaluate them next tick. We don't have the timestampMs
        // for the filtered-out msg without scanning the InboundMessage
        // we discarded — but we kept the id only. Recover the ts from
        // the slack ":<ts>" / gmail historyId path is non-trivial;
        // simplest correct thing: mark them all under a pseudo-source
        // "filtered:<source>" with a current ts. dedup tolerates
        // duplicates so this is safe.
        const src = f.id.startsWith("slack:")
          ? "slack:direct"
          : f.id.startsWith("gmail:")
            ? "gmail:direct"
            : "filtered";
        marks = advance(src, f.id, startedAtMs, marks);
      }
      state.marks = marks;
      // PERSON-FIRST TRIGGER. The scan already knows who spoke, so the cursor
      // costs nothing extra — the alternative was polling 75 personas to find
      // out. Only messages that resolve to a known persona count; an unmapped
      // handle cannot be assessed, and inventing a key for it would create a
      // ghost contact.
      if (opts.resolvePersonaKey) {
        const spoke: Array<{ personaKey: string; timestampMs: number }> = [];
        for (const m of sourceMessages) {
          const key = opts.resolvePersonaKey(m.senderHandle);
          if (key) spoke.push({ personaKey: key, timestampMs: m.timestampMs });
        }
        state.personTraffic = recordTraffic(state.personTraffic ?? {}, spoke);
      }
    }

    // Cap: when a cold-cursor catch-up surfaces more candidates than we're
    // willing to pay to draft, take the NEWEST `maxDraftCandidates` and
    // report the older remainder. Their cursor marks were already advanced
    // above, so the skipped ones won't re-surface next tick — this is an
    // explicit, counted drop (draftSkipped), never a silent one.
    draftInput = sourceMessages;
    if (
      opts.maxDraftCandidates !== undefined &&
      sourceMessages.length > opts.maxDraftCandidates
    ) {
      draftInput = [...sourceMessages]
        .sort((a, b) => b.timestampMs - a.timestampMs)
        .slice(0, opts.maxDraftCandidates);
      draftSkipped = sourceMessages.length - draftInput.length;
    }

    // Cursors/marks/sourceErrors live on the in-memory `state`; they're
    // committed in phase 3 (along with the drafted actions) so the lock is held
    // only for that brief write, never across the scan.
  } finally {
    // PHASE 0 holds no lock (atomic reads), so there is nothing to release here.
    // The only locked sections are the brief phase 1.5 / 3 / 4 / 5 commits.
  }

  // Commit our daemon-owned fields (cursors / marks / scan sourceErrors) onto a
  // FRESH reload, under a briefly re-acquired lock; `mutate` adds anything extra
  // (drafted actions, the shadow record). Reloading fresh preserves the
  // cockpit's concurrent approve/skip/edit — it only ever touches state.actions.
  // Returns false if the lock couldn't be re-acquired within the retry window.
  const commitUnderLock = async (mutate: (fresh: LoopState) => void): Promise<boolean> => {
    if (!(await acquireLockWithRetry(stateDir))) return false;
    try {
      const fresh = loadState(opts.statePath);
      fresh.marks = state.marks;
      fresh.sourceErrors = state.sourceErrors;
      // personTraffic is owned by THIS tick (the scan sets it), so it is carried
      // over. personAssessed is owned only by the phase-7 mutate, so it is NOT:
      // loadState fills a missing field with {}, and `{}` is truthy — copying it
      // from the tick's start-of-run snapshot silently wiped the cursor a phase
      // later, and the pass then re-assessed the same person every single tick.
      fresh.personTraffic = state.personTraffic ?? fresh.personTraffic;
      mutate(fresh);
      saveState(opts.statePath, fresh);
      return true;
    } finally {
      releaseLock(stateDir);
    }
  };

  // ── PHASE 1.5 (re-locked, brief): commit cursors/marks NOW, BEFORE the slow
  // draft. The draft is exactly when the cockpit is most likely to be holding
  // the lock, so committing cursors first means a later phase-3 miss can only
  // drop drafts (re-drafted next tick) — never cursor progress (losing that
  // would re-surface + re-scan already-handled messages, breaking dedup).
  if (!opts.dryRun) await commitUnderLock(() => {});

  // ── PHASE 2 (UNLOCKED): the slow LLM drafting (+ vision decode). No lock is
  // held, so the cockpit stays responsive even through a long or hung draft.
  let draftedActions: ActionItem[] = [];
  let llmDraftError: string | undefined;
  // Every sender failed — a systemic outage, not a per-sender fault.
  let llmDraftOutage = false;
  // Senders whose draft call succeeded but produced ZERO cards — the silent
  // skip (cursor already advanced). Surfaced as llm:draft-empty in phase 3.
  let draftEmpty: string[] = [];
  if (opts.draft && draftInput.length > 0) {
    try {
      console.log(`[progress] drafting ${draftInput.length} candidate(s)…`);
      const r = await draftActions(draftInput, opts.draft);
      draftedActions = r.actions;
      draftEmpty = r.empty;
      if (r.errors.length > 0) {
        // The DENOMINATOR is the whole point. "陈古龙: claude -p exit 1: …" is
        // what an expired subscription session looked like for two days
        // (2026-09-02 → 09-04) — one arbitrary contact, indistinguishable from
        // a flake. "ALL 12/12 senders failed" is not mistakable for anything.
        // A claim this loud needs more than one data point. 2026-09-05, the day
        // after this shipped: a tick with a single sender timed out and the
        // engine announced THE BRAIN IS DOWN. "All 1 of 1 failed" is not
        // evidence of a systemic failure, it is one failure — and an alarm that
        // cries wolf on a slow contact is an alarm the owner learns to ignore,
        // which is the exact failure this was built to prevent.
        llmDraftOutage = r.senders >= 2 && r.errors.length === r.senders;
        llmDraftError =
          `${llmDraftOutage ? "ALL " : ""}${r.errors.length}/${r.senders} sender(s) failed: ` +
          r.errors.map((e) => `${e.sender}: ${e.error}`).join("; ");
        if (llmDraftOutage) {
          // Loud, and on the way past: a brain that cannot think at all is not
          // a per-sender fault to be swallowed by the isolation policy.
          console.error(`[llm] OUTAGE — every one of ${r.senders} sender(s) failed: ${r.errors[0]!.error}`);
        }
      }
    } catch (e) {
      llmDraftError = errString(e);
    }
  }

  // ── PHASE 3 (re-locked, brief): commit the drafted actions + the llm error +
  // the shadow record. Append + supersede still-suggested same-sender cards (a
  // user-touched card is never "suggested", so it stays). `drafted`/
  // `shadowWritten` reflect ONLY what actually committed — if the lock can't be
  // re-acquired, the drafts are dropped this tick (cursors are already safe from
  // phase 1.5) and a chatty sender re-drafts next tick.
  const shadowInput: ShadowRecordInput = {
    runtime: "phase3-t-proc",
    source_messages: sourceMessages,
    filtered: filteredOut,
  };
  const willWrite = shouldWriteShadowRecord(draftedActions, shadowInput);
  let shadowWritten = false;
  let draftedCount = 0;
  // Supersede bookkeeping for the activity log, filled inside the phase-3
  // commit (which may not run) and logged after it resolves.
  let supersededCount = 0;
  let supersedeExemptCount = 0;
  if (!opts.dryRun && (draftedActions.length > 0 || llmDraftError !== undefined || draftEmpty.length > 0 || willWrite)) {
    const committed = await commitUnderLock((fresh) => {
      if (draftedActions.length > 0) {
        // Don't re-surface an already-BOOKED meeting: drop a fresh suggested
        // calendar whose task_id OR exact start matches an EXECUTED calendar. The
        // event already exists — a later re-mention shouldn't spawn a duplicate
        // card (the '看房 already created, why still here' bug).
        const toCommit = draftedActions.filter((a) => !isCalendarRedundant(a, fresh.actions));
        // Cross-tick clustering: a fresh SUGGESTED card for a sender supersedes
        // the prior still-suggested card(s) for that sender — one chatty contact
        // yields one evolving card, not a flood. EXEMPTION (see
        // isSupersedeExempt in core/action-item.ts): a suggested calendar with
        // a concrete params.start is a commitment, not an evolving draft — it
        // stays in the queue AND gets no "superseded" label. If the meeting
        // time changes in the thread, the old-time card survives alongside the
        // new one; the user picks the right one and skips the other.
        const freshKeys = new Set(toCommit.map(clusterKey).filter((k): k is string => !!k));
        // Exempt survivors (suggested calendar w/ concrete start — a commitment,
        // not an evolving draft): counted so the activity log can say "dropped N,
        // kept M exempt" instead of leaving a vanished-card mystery.
        const exemptKept = fresh.actions.filter((a) => {
          if (a.status !== "suggested" || !isSupersedeExempt(a)) return false;
          const k = clusterKey(a);
          return !!(k && freshKeys.has(k));
        }).length;
        const superseded = fresh.actions.filter((a) => {
          if (a.status !== "suggested") return false;
          if (isSupersedeExempt(a)) return false;
          const k = clusterKey(a);
          return !!(k && freshKeys.has(k));
        });
        // P0 label rescue: a superseded card NEVER reaches a terminal status, so
        // no "export the terminal actions" pass can ever recover it — this is the
        // bigger of the two leaks (502 shadow ids → 173 surviving). Write the
        // label BEFORE dropping; if the append fails, keep the cards (a duplicate
        // card beats a lost label) and let the next tick supersede them.
        let supersedeOk = true;
        if (superseded.length > 0) {
          try {
            appendLabels(
              labelsPathFor(opts.statePath),
              superseded.map((a) => buildLabel({ action: a, decision: "superseded" })),
            );
          } catch {
            supersedeOk = false;
          }
        }
        if (supersedeOk) {
          const doomed = new Set(superseded.map((a) => a.id));
          fresh.actions = fresh.actions.filter((a) => !doomed.has(a.id));
          supersededCount = superseded.length;
          supersedeExemptCount = exemptKept;
        }
        // P1 durable identity: a replacement card INHERITS the superseded
        // card's task_id (copy, never mint) so the plan + cockpit cluster
        // stay attached to the task across the supersede. Computed from the
        // superseded list regardless of whether the drop committed — the
        // cards are doomed next tick anyway, and a copied id is idempotent.
        fresh.actions.push(...inheritSupersededTaskIds(toCommit, superseded));
      }
      if (llmDraftError !== undefined) {
        fresh.sourceErrors["llm:draft"] = { message: llmDraftError, at: new Date(startedAtMs).toISOString() };
      } else {
        delete fresh.sourceErrors["llm:draft"];
      }
      // A separate key for the systemic case. `llm:draft` churns — one flaky
      // contact overwrites it every tick — so an outage buried there reads as
      // routine noise. This key appears ONLY when nothing could think, and any
      // successful round clears it.
      if (llmDraftOutage) {
        fresh.sourceErrors["llm:draft-outage"] = {
          message: `THE BRAIN IS DOWN — ${llmDraftError}`,
          at: new Date(startedAtMs).toISOString(),
        };
      } else if (draftedActions.length > 0 || draftEmpty.length > 0) {
        delete fresh.sourceErrors["llm:draft-outage"];
      }
      // Silent-empty drafts (LLM answered, zero cards) are the invisible
      // failure: the cursor advanced, so the message is gone unless someone
      // notices. Surface the handles in the cockpit error strip; the raw
      // model responses are in llm-draft-raw.jsonl next to the state file.
      if (draftEmpty.length > 0) {
        fresh.sourceErrors["llm:draft-empty"] = {
          message: `${draftEmpty.length} sender(s) triggered but drafted 0 cards: ${draftEmpty.join(", ")} — raw responses in llm-draft-raw.jsonl`,
          at: new Date(startedAtMs).toISOString(),
        };
      } else {
        delete fresh.sourceErrors["llm:draft-empty"];
      }
      if (willWrite) {
        appendShadowRecord(
          join(stateDir, "shadow-log.jsonl"),
          buildShadowRecord(new Date(startedAtMs).toISOString(), draftedActions, shadowInput),
        );
      }
    });
    if (committed) {
      draftedCount = draftedActions.length;
      shadowWritten = willWrite;
      if (supersededCount > 0 || supersedeExemptCount > 0) {
        logActivity(
          "supersede",
          `superseded ${supersededCount} suggested card(s), kept ${supersedeExemptCount} exempt calendar card(s)`,
          { phase: "draft-commit", dropped: supersededCount, exemptKept: supersedeExemptCount },
        );
      }
    } else {
      // The lock never came back — drafts are dropped this tick (cursors are
      // safe from phase 1.5). Invisible in state, so it MUST be visible here.
      logActivity(
        "error",
        `phase-3 commit failed (lock busy) — ${draftedActions.length} draft(s) dropped, will re-draft next tick`,
        { phase: "draft-commit", drafts: draftedActions.length },
      );
    }
  }

  // Silent-empty drafts (LLM answered, zero cards — usually a parse-failure,
  // see llm-draft-raw.jsonl) are the invisible permanent skip: the cursor is
  // already past those messages. sourceErrors surfaces them in the cockpit but
  // the next tick's phase-3 WIPES that entry — the durable record lives here.
  if (draftEmpty.length > 0) {
    logActivity(
      "error",
      `${draftEmpty.length} sender(s) triggered but drafted 0 cards: ${draftEmpty.join(", ")} — raw responses in llm-draft-raw.jsonl`,
      { phase: "draft", senders: draftEmpty },
    );
  }

  // PHASES 4–6 (consolidate / refresh / plan) are RETIRED — spec §7 phase 5.
  // The list derives from the commitment ledger now, so nothing groups cards
  // into tasks, re-reads threads per card, or ranks units into tiers. Between
  // them the three passes were ~90% of the LLM bill, and every list-quality
  // failure the owner struck (umbrella merges, resurrected cards, flapping
  // tiers) lived in this stretch of the file.

  // ── PHASE 6a (UNLOCKED, no LLM): pull completions BACK from TickTick.
  //
  // Runs BEFORE the push, so a task the owner just finished is closed here and
  // is no longer eligible in the push below — rather than being re-written and
  // only closed on the next tick.
  //
  // Non-fatal, like the push: TickTick being unreachable must never stop a scan.
  if (!opts.dryRun && opts.ticktickReader) {
    try {
      const remote = await opts.ticktickReader.listActive();
      const snapshot = loadState(opts.statePath);
      const { ticked, closed, map, unitsClosed } = readbackFromTickTick(
        snapshot,
        loadSyncMap(opts.statePath),
        remote,
      );

      // TICK-TO-EXECUTE (specs/ticktick-migration.md §1): a ticked EXECUTABLE
      // line — the labelled invite/tool lines are the only tracked ones — is the
      // owner's approval, and it executes here. executeAction is idempotent by
      // receipt, and persistClaim writes the durable "executing" mark BEFORE the
      // side effect, so a crash between claim and receipt surfaces as
      // NeedsVerification instead of a silent double-send.
      const executedNow: ActionItem[] = [];
      if (ticked.length > 0 && opts.execute) {
        for (const id of ticked) {
          const action = snapshot.actions.find((a) => a.id === id);
          if (!action || action.status === "executed" || action.status === "rejected") continue;
          if (action.action_type !== "calendar" && action.action_type !== "tool") continue;
          try {
            // The tick is the approval — but approveAction still runs the
            // missing-info gate (ASK-not-GUESS): a card with unresolved params
            // refuses here, loudly, instead of sending something half-built.
            const approved = action.status === "suggested" ? approveAction(action) : action;
            const r = await executeAction(approved, {
              ...opts.execute,
              persistClaim: async (claimed) => {
                await commitUnderLock((fresh) => {
                  fresh.actions = fresh.actions.map((a) => (a.id === claimed.id ? claimed : a));
                });
              },
            });
            executedNow.push(r.action);
            console.log(`[ticktick] ticked → executed: ${action.action_type} "${String(action.params.title ?? action.headline ?? action.id)}" (${r.receipt?.ref ?? "no ref"})`);
          } catch (e) {
            // Loud, never silent: an invite the owner asked for that did NOT go
            // out is exactly the failure that must not hide in a counter.
            console.error(`[ticktick] ticked ${action.action_type} FAILED to execute: ${errString(e)}`);
            await commitUnderLock((fresh) => {
              fresh.sourceErrors["llm:tick-execute"] = {
                message: `${action.id}: ${errString(e)}`,
                at: new Date(startedAtMs).toISOString(),
              };
            }).catch(() => undefined);
          }
        }
      }

      // Everything else the readback learned: whole-task closes always record
      // done; ticked items record done too when no executor is configured
      // (the pre-§1 behaviour — a tick means "I already did it").
      const done = new Set([...closed, ...(opts.execute ? [] : ticked)]);

      // The MAP is saved on its own signal. `done` counts card-derived actions,
      // and a ledger row has no action behind it — gating the save on `done`
      // threw away every tombstone the owner earned by finishing ledger tasks.
      // Measured on the real account before this fix: 141 tracked records, 0
      // tombstones, 87 tasks already gone from TickTick. No tombstone is what
      // mints twins, because a re-listed to-do then creates instead of reopens.
      // `unitsClosed` is exactly how many records were tombstoned this pass, so
      // it is the map-changed signal.
      if (unitsClosed > 0) saveSyncMap(opts.statePath, map);

      if (done.size > 0 || executedNow.length > 0) {
        const byId = new Map(executedNow.map((a) => [a.id, a]));
        await commitUnderLock((fresh) => {
          fresh.actions = fresh.actions.map((a) => {
            const exec = byId.get(a.id);
            if (exec) return exec; // the executed action, receipt and all
            return done.has(a.id) && (a.status === "suggested" || a.status === "approved")
              ? { ...a, status: "executed" as const }
              : a;
          });
        });
      }
      if (done.size > 0 || executedNow.length > 0 || unitsClosed > 0) {
        console.log(
          `[ticktick] read back ${done.size} finished, ${executedNow.length} executed-by-tick, ${unitsClosed} task(s) closed`,
        );
      }
      await commitUnderLock((fresh) => {
        delete fresh.sourceErrors["llm:ticktick-readback"];
      }).catch(() => undefined);
    } catch (e) {
      console.error(`[ticktick] read-back FAILED: ${errString(e)}`);
      await commitUnderLock((fresh) => {
        fresh.sourceErrors["llm:ticktick-readback"] = {
          message: errString(e),
          at: new Date(startedAtMs).toISOString(),
        };
      }).catch(() => undefined);
    }
  }

  // ── PHASE 6b (UNLOCKED, no LLM): push the ranked to-do list into TickTick.
  // Runs AFTER planning because the tier it writes as the TickTick priority is
  // what planning just computed. No LLM call, so it is cheap enough to run every
  // tick; the hash gate in core/ticktick-sync.ts means a tick where nothing
  // changed makes ZERO API calls. Non-fatal — TickTick being down must never
  // stop the scan (records llm:ticktick so the cockpit surfaces it).
  if (!opts.dryRun && opts.ticktickWriter) {
    try {
      const snapshot = loadState(opts.statePath);
      const zone = opts.ownerTimeZone ?? machineTimeZone();
      const nowMs = Date.now();
      // THE LIST IS THE LEDGER (spec §7 phase 4): rows derive from open who=me
      // commitments the assess pass judged needs_leo. Cards contribute only what
      // the ledger cannot: executable invite/tool lines, and persona-less work.
      const ledger = opts.ledgerPersonas
        ? deriveLedgerTasks(
            opts.ledgerPersonas(),
            zone,
            nowMs,
            opts.activeMatters?.() ?? new Set(),
            opts.closedMatters?.() ?? new Set(),
          )
        : [];
      const personaLess = (unit: TaskUnit): boolean =>
        opts.resolvePersonaKey
          ? unit.members.every((m) => {
              const h = m.context?.sender_handle;
              return !h || opts.resolvePersonaKey!(h) === null;
            })
          : false;
      const rows = [
        ...ledger.map((d) => ({ ...d, executable: [] })),
        ...cardRows(snapshot, zone, nowMs, personaLess),
      ];
      console.log(`[ticktick] desired: ${ledger.length} ledger row(s) + ${rows.length - ledger.length} card row(s)`);
      // Live remote list for orphan reconciliation — non-fatal: without it the
      // sync still works, it just cannot see its own strays this tick.
      const remoteActive = opts.ticktickReader
        ? await opts.ticktickReader.listActive().catch(() => undefined)
        : undefined;
      const { map, report } = await syncToTickTick(rows, loadSyncMap(opts.statePath), opts.ticktickWriter, remoteActive);
      saveSyncMap(opts.statePath, map);
      if (report.created || report.updated || report.completed || report.failed) {
        appendActivity(activityPathFor(opts.statePath), {
          at: new Date().toISOString(),
          kind: "tick",
          summary:
            `ticktick: +${report.created} ~${report.updated} ✓${report.completed} ` +
            `(${report.skipped} unchanged${report.failed ? `, ${report.failed} FAILED` : ""})`,
          data: { ...report },
        });
      }
      await commitUnderLock((fresh) => {
        delete fresh.sourceErrors["llm:ticktick"];
      }).catch(() => undefined);
    } catch (e) {
      await commitUnderLock((fresh) => {
        fresh.sourceErrors["llm:ticktick"] = {
          message: errString(e),
          at: new Date(startedAtMs).toISOString(),
        };
      }).catch(() => undefined);
    }
  }

  // ── PHASE 7: the PERSON pass. Writes persona YAML files through R1, plus the
  // assessment cursor in loop-state.
  //
  // Triggered by WHO SPOKE, not by who has a card open. The card-driven version
  // could not see a contact whose traffic never became a card — and it re-ran on
  // a 10-minute TTL whether or not anything had been said, which is the same
  // clock-gated waste that made refresh 69% of the token bill. A quiet tick now
  // costs nothing, which is the cost argument for person-first (spec §5).
  if (!opts.dryRun && opts.personaUpdate) {
    const cursors = loadState(opts.statePath);
    const queue = personsNeedingAssessment(
      cursors.personTraffic ?? {},
      cursors.personAssessed ?? {},
      opts.maxPersonsPerTick ?? 3,
    );
    if (queue.length > 0) {
      try {
        console.log(`[progress] assessing ${queue.length} contact(s) with new traffic…`);
        const pu = await updatePersonaCommitments(queue, opts.personaUpdate);
        // Cursors advance for everyone taken off the queue, including the
        // unreadable — otherwise one contact with no mapped handle sits at the
        // head of the oldest-first queue every tick and starves the rest. Their
        // next message re-queues them, so nothing is lost permanently.
        if (pu.attempted.length > 0) {
          await commitUnderLock((fresh) => {
            fresh.personAssessed = markAssessed(fresh.personAssessed ?? {}, pu.attempted);
          });
        }
        // Spec §6.2 wants this reported, never a silent skip: a contact
        // reachable on no mapped handle is invisible to their own pass, and that
        // is a data bug about the persona file, not a quiet no-op.
        if (pu.unreadable.length > 0) {
          console.log(
            `[persona] no corpus for ${pu.unreadable.length} contact(s) — unmapped handles or every source down: ${pu.unreadable.join(", ")}`,
          );
        }
        // The discard rate is a FINDING, not noise: each one is a commitment or
        // status change whose supporting quote was not in the corpus — i.e. the
        // model creating. Silent-failure lessons apply (consolidate timed out
        // invisibly for days), so it goes to the console, not just a counter.
        if (pu.discarded > 0) {
          console.log(`[persona] discarded ${pu.discarded} ungrounded extraction(s) (evidence quote not in corpus)`);
        }
        // The ASSESS verdicts are what the derived list is built from, so the
        // count and the discard rate beside it are the signal for whether the
        // model is judging or inventing. Printed even at zero when work was
        // read: silently assessing NOTHING would look identical to a healthy
        // quiet tick, and the derived list would just be empty.
        if (pu.assessed > 0 || pu.discarded > 0) {
          console.log(`[persona] assessed ${pu.assessed} open commitment(s), ${pu.discarded} discarded`);
        }
        if (pu.updated.some((u) => u.statusChanged > 0)) {
          console.log(
            `[persona] status transitions: ${pu.updated
              .filter((u) => u.statusChanged > 0)
              .map((u) => `${u.key}×${u.statusChanged}`)
              .join(", ")}`,
          );
        }
        await commitUnderLock((fresh) => {
          delete fresh.sourceErrors["llm:persona"];
        }).catch(() => undefined);
      } catch (e) {
        await commitUnderLock((fresh) => {
          fresh.sourceErrors["llm:persona"] = {
            message: errString(e),
            at: new Date(startedAtMs).toISOString(),
          };
        }).catch(() => undefined);
      }
    }
  }

  // ── tick summary (activity log). One line per tick that DID something —
  // fully-idle ticks are skipped on purpose: a 10s WeChat poll would
  // otherwise bury the signal under ~8k noise lines a day. The same flood
  // logic applies to a down source: an error-only tick whose signature is
  // identical to the previous one is a repeat, not news.
  const totalInbound = perSource.reduce((s, p) => s + p.inboundCount, 0);
  const totalTriggered = perSource.reduce((s, p) => s + p.triggered, 0);
  const erroredSources = perSource.filter((s) => s.error).map((s) => s.source);
  const hasActivity =
    totalInbound > 0 || draftedCount > 0 || draftSkipped > 0 || promoFiltered > 0;
  const hasError = erroredSources.length > 0 || llmDraftError !== undefined;
  if (hasActivity || hasError) {
    const tickSig = JSON.stringify([
      perSource.map((s) => [s.source, s.inboundCount, s.triggered, s.error ?? null]),
      draftedCount,
      draftSkipped,
      promoFiltered,
      llmDraftError ?? null,
    ]);
    // Repeat suppression applies only to error-only ticks, scoped by WHICH
    // sources are failing (see the map's comment).
    const scope = hasError
      ? [...erroredSources, ...(llmDraftError !== undefined ? ["llm:draft"] : [])].sort().join(",")
      : "";
    const isRepeat = !hasActivity && lastErrorTickSigByScope.get(scope) === tickSig;
    if (!isRepeat) {
      const parts = perSource.map(
        (s) => `${s.source} ${s.inboundCount} in/${s.triggered} trig${s.error ? " ERR" : ""}`,
      );
      let summary = `${parts.join("; ") || "no sources"} → drafted ${draftedCount}`;
      if (draftSkipped > 0) summary += `, ${draftSkipped} skipped (cap)`;
      if (promoFiltered > 0) summary += `, ${promoFiltered} promo filtered`;
      if (llmDraftError !== undefined) summary += `, llm ERR`;
      logActivity("tick", summary, {
        durationMs: Date.now() - startedAtMs,
        drafted: draftedCount,
        draftSkipped,
        promoFiltered,
        ...(draftEmpty.length > 0 ? { draftEmpty } : {}),
        // Full error text per failing source (truncated) — "ERR" alone would
        // send you right back to guessing, which is what this log exists to kill.
        ...(erroredSources.length > 0
          ? {
              erroredSources,
              errors: Object.fromEntries(
                perSource.filter((s) => s.error).map((s) => [s.source, s.error!.slice(0, 200)]),
              ),
            }
          : {}),
        ...(llmDraftError !== undefined ? { llmDraftError } : {}),
      });
      if (!hasActivity) lastErrorTickSigByScope.set(scope, tickSig);
    }
  }

  return {
    startedAtMs,
    durationMs: Date.now() - startedAtMs,
    perSource,
    totalInbound,
    totalTriggered,
    shadowWritten,
    drafted: draftedCount,
    draftSkipped,
    promoFiltered,
  };
}
