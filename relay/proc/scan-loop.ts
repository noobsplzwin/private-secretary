// One scan tick, in one of two lanes (CLAUDE.md, 「收信和分析分开排队」):
//
//   fetch   — polls every source, filters, writes new messages into
//             state.inbox, then advances cursors. No LLM.
//   analyse — drafts from the inbox, runs the person pass (commitments,
//             closure check, plan progress), reads TickTick back and syncs.
//
// `all` runs both in one tick (tests, the CLI). The shadow-log is the audit
// trail of what each round saw and drafted.
//
// Per-source fault isolation: a failing Slack channel or Gmail mailbox
// records itself in sourceErrors and does NOT advance its cursor; the
// other sources still get processed. This matches the /relay skill's
// existing semantics so swapping the skill out for a daemon is a no-op
// from loop-state's point of view.

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
import type { GroupBook } from "../core/wechat-groups.js";
import type { Participation } from "../sources/wechat-direct.js";
import type { DirectBook } from "../core/wechat-direct-cursor.js";
import type { ActionItem } from "../core/action-item.js";
import { canAutoExecute, isSystemicExecuteFailure } from "../core/executors.js";
import {
  SILENT_RETIRE_DAYS,
  cardsAnsweredSince,
  staleSuggestedCards,
  isCalendarRedundant,
  isSupersedeExempt,
} from "../core/action-item.js";
import { draftActions, type DraftDeps } from "./draft.js";
import { clusterKey, inheritSupersededTaskIds } from "../core/unit-key.js";
import { executeAction, type ExecuteDeps } from "./execute.js";
import { approveAction } from "../core/action-item.js";
import { syncToTickTick, cardRows, readbackFromTickTick, type TickTickWriter, type TickTickReader } from "./ticktick-sync.js";
import { markLedgerCommitmentsDone, markLedgerCommitmentsDropped } from "./ledger-close.js";
import { enqueue, isLlmUnavailable, settle, takeForDraft, type InboxEntry } from "../core/inbox.js";
import type { TaskUnit } from "../core/ticktick-plan.js";
import { deriveLedgerTasks, heldClosedByOwner } from "../core/ledger-list.js";
import { applyInvite, cardForInvite } from "../core/calendar-invite.js";
import type { RemoteTask } from "../core/ticktick-readback.js";
import type { SyncMap } from "../core/ticktick-sync.js";
import { markAssessed, personsNeedingAssessment, recordGroupPresence, recordTraffic } from "../core/person-queue.js";
import type { Commitment } from "../core/persona-v3.js";
import { loadSyncMap, saveSyncMap } from "../io/ticktick-sync-store.js";
import { saveOwnerTickets } from "../io/owner-tickets-store.js";
import { recordOwnerNotes } from "../io/owner-notes-store.js";
import { localDate } from "../core/ticktick-plan.js";
import { closeDoneCards } from "./card-closure.js";
import { loadOwnerTickets } from "../io/owner-tickets-store.js";
import { findPlanProgress, mergePlanUpdates, type PlanUpdate } from "../core/plan-progress.js";
import { ownerTicketsFrom } from "../core/owner-tickets.js";
import { machineTimeZone } from "../io/settings.js";
import { updatePersonaCommitments, type PersonaUpdateDeps } from "./persona-update.js";
import { ownerLastSpokeInChannels, scanSlackDirect } from "../sources/slack-direct.js";
import { resolveSlackUserNames } from "../io/slack-users.js";
import type { SlackClient } from "../io/slack-api.js";
import { GmailClient } from "../io/gmail-api.js";
import { ownerLastSpokeInThreads, scanGmailDirect } from "../sources/gmail-direct.js";
import {
  createSlackClientFromKeychain,
  SLACK_ACCOUNTS,
  SLACK_TOKEN_ACCOUNT,
} from "../io/slack-api.js";

export interface ScanLoopOptions {
  // Absolute path to loop-state.json. The scan-loop owns lock acquire +
  // atomic save; callers shouldn't poke this file mid-scan.
  statePath: string;
  /**
   * Which LANE this tick is (owner, 2026-10-01: 「收信和分析分开排队」).
   *
   *   fetch   — poll `sources`, persist new messages to the inbox, advance
   *             cursors. No LLM, so it takes seconds and never waits on one.
   *   analyze — poll NOTHING; draft from the inbox, then TickTick and the
   *             person pass. A slow `claude -p` holds only this lane.
   *   all     — the original single-lane tick, kept for tests and the CLI.
   *
   * The two lanes run concurrently, so each writes only the state it owns:
   * fetch owns marks, per-source errors, personTraffic/personGroups and the
   * WeChat books; analyze owns actions, `llm:*` errors and the person-pass
   * cursors. The inbox is the hand-off — fetch appends, analyze removes.
   */
  mode?: "all" | "fetch" | "analyze";
  // Where the persona YAMLs live. Needed so a LEDGER row the owner finished in
  // TickTick can mark its commitment done — without it the row is re-derived
  // and reopened on the next tick (proc/ledger-close.ts). Omitted in tests that
  // do not exercise the read-back.
  personaDir?: string;
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
  // When provided, the list is pushed into TickTick (specs/ticktick-migration.md).
  // Absent = no sync.
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
  // When provided, the person pass runs in the analyse lane: extracts NEW
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
  /**
   * WeChat GROUP coverage. Absent = groups stay dropped (the pre-2026-09-12
   * behaviour). The book persists which groups are work and how far each has
   * been read; see core/wechat-groups.ts for why it is persisted rather than
   * recomputed.
   */
  wechatGroups?: { load: () => GroupBook; save: (b: GroupBook) => void };
  /**
   * Cursor book for 1:1 chats. Without it every direct chat reads as first
   * contact and nothing is ever minted — so the daemon must pass it.
   */
  wechatDirect?: { load: () => DirectBook; save: (b: DirectBook) => void };
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
  /** fetch lane: messages newly added to the inbox this tick. */
  enqueued?: number;
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
  /** Cold-rotation offset (sources/slack-direct.selectChannelsToPoll). */
  rotation?: number;
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
// the competitor is the other lane's short commit, so a few short retries
// reliably win it back.
async function acquireLockWithRetry(stateDir: string, tries = 10, delayMs = 200): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (acquireLock(stateDir)) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

/**
 * Drop cards as SUPERSEDED: the label first, then the cards. If the label
 * cannot be written the cards stay (the next tick retries) — the labels.jsonl
 * contract is that no card leaves without its label. Returns how many left.
 */
function dropSuperseded(statePath: string, fresh: LoopState, cards: readonly ActionItem[]): number {
  if (cards.length === 0) return 0;
  try {
    appendLabels(labelsPathFor(statePath), cards.map((a) => buildLabel({ action: a, decision: "superseded" })));
  } catch {
    return 0;
  }
  const doomed = new Set(cards.map((a) => a.id));
  fresh.actions = fresh.actions.filter((a) => !doomed.has(a.id));
  return cards.length;
}

/** A mailbox failure in one line — the part that says what to DO about it. */
export function shortMailboxError(error: string): string {
  const flat = error.replace(/\s+/g, " ").trim();
  // invalid_grant = the refresh token is dead (expired or revoked). A Google
  // project in "Testing" publishing status expires them every 7 days.
  if (/invalid_grant/.test(flat)) return "invalid_grant — refresh token dead, re-auth needed";
  return flat.length > 70 ? `${flat.slice(0, 69)}…` : flat;
}

/**
 * Every ACTIVE task in every list the engine has a live task in.
 *
 * Absence is the readback's only evidence that the owner finished something,
 * so the set of lists read must be exactly the set the tracked tasks LIVE in.
 * It used to be a hard-coded name list, and that list was wrong twice: first
 * it held only Work while sunk rows lived in 待办池 (94 commitments closed
 * behind the owner's back), then it named 待办池 explicitly — which would have
 * turned into a permanent "read failed, close nothing" the day he deleted that
 * list. Deriving it from the map is right by construction: a list stops being
 * read when nothing lives in it, and a new one is read the moment something does.
 *
 * `complete` is false when any of those lists could not be read; the readback
 * then concludes nothing from absence (core/ticktick-readback.ts).
 */
/** Consecutive failed assessments before a person's cursor advances anyway. */
const PERSON_ASSESS_RETRIES = 3;

export async function readAllActive(
  reader: TickTickReader,
  map: SyncMap,
): Promise<{ tasks: RemoteTask[]; complete: boolean }> {
  const work = await reader.listActive();
  const seen = new Set(work.map((t) => t.projectId).filter((x): x is string => !!x));
  const elsewhere = [
    ...new Set(Object.values(map).filter((r) => !r.done && r.projectId && !seen.has(r.projectId)).map((r) => r.projectId)),
  ];
  // A reader that can only list by name is a single-list reader (the test
  // stubs, and the shape before this existed): Work is all there is to read.
  const tasks = [...work];
  let complete = true;
  if (reader.listActiveIn) {
    for (const id of elsewhere) {
      try {
        tasks.push(...(await reader.listActiveIn(id)));
      } catch (e) {
        complete = false;
        console.error(`[ticktick] list ${id} unreadable — closing nothing this tick: ${errString(e)}`);
      }
    }
  }
  // A tracked task that left the active lists was completed or deleted. Fetch
  // it: what he wrote on its 🚫 line before completing it is the verdict
  // (core/ticktick-readback.ts). Usually zero or a handful per tick. A fetch
  // that fails reads as before — finished — rather than holding every close.
  if (complete && reader.getTask) {
    const live = new Set(tasks.map((t) => t.id));
    for (const rec of Object.values(map)) {
      if (rec.done || live.has(rec.ticktickId)) continue;
      try {
        const t = await reader.getTask(rec.ticktickId);
        // Still active (in a list not read) counts as active, not finished.
        if (t) tasks.push(t);
      } catch (e) {
        console.error(`[ticktick] finished task ${rec.ticktickId} unreadable — its 🚫 line is not read: ${errString(e)}`);
      }
    }
  }
  return { tasks, complete };
}

// ─── the three source polls (FETCH lane) ────────────────────────────
//
// Each poll reads one platform, files what it read into the tick's shared
// accumulators, and records its own cursor advance in state.marks (Slack,
// Gmail) or hands it back held (WeChat — committed only after drafting).
// A poll never throws: a failure is recorded against its source and the
// other sources still run.

/** What every poll reads from, and the accumulators it files into. */
interface PollContext {
  opts: ScanLoopOptions;
  /** The tick's snapshot; polls advance their cursors in state.marks. */
  state: LoopState;
  stateDir: string;
  startedAtMs: number;
  /** Suggested reply-only cards per platform (answered-closes). */
  waitingCards: (platform: string) => ActionItem[];
  ownerSpokeAt: Map<string, number>;
  sourceMessages: InboundMessage[];
  filteredOut: ShadowFilterRejection[];
  sourceErrors: Record<string, string>;
  perSource: SourceSummary[];
}

// WeChat cursors, held between the scan and the drafter. A cursor committed
// before drafting turns any draft failure into permanent data loss: the
// messages are marked read and nothing ever looks at them again.
type PendingBook<T> = { prev: T; next: T };

interface WechatPoll {
  pendingDirect?: PendingBook<DirectBook>;
  pendingGroups?: PendingBook<GroupBook>;
  /** Who took part in what the pass read (sources/wechat-direct.ts Participation). */
  spoke: Participation[];
}

// ── Slack pass (one per workspace account) ─────────────────
// Each configured workspace is scanned via its own Keychain token, its own
// selfId (authTest inside scanSlackDirect → self-message filter is correct
// per account), its own cursor slice, and its own source label. A failing
// account is isolated and never sinks the others. An injected client (tests)
// scans as the single Taiv account.
async function pollSlack(ctx: PollContext): Promise<void> {
  const { opts, state, stateDir, waitingCards, ownerSpokeAt, sourceMessages, filteredOut, sourceErrors, perSource } = ctx;
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
        // A wake tick is the catch-up pass: the machine was asleep, so even a
        // dormant channel may hold something. Every other tick polls hot
        // channels plus a slice of the cold rotation — see
        // selectChannelsToPoll for why all 447 every minute was the bug.
        ...(opts.onWake ? { pollAll: true } : {}),
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
      // ANSWERED-CLOSES for Slack: one conversations.history per waiting card,
      // this workspace only (a foreign channel id is skipped inside).
      try {
        const cards = waitingCards("slack");
        if (cards.length > 0) {
          const byChannel = new Map<string, { handle: string; since: number }>();
          for (const a of cards) {
            const channel = a.source_message_id.split(":")[1];
            const handle = a.context?.sender_handle;
            const since = Date.parse(a.created_at);
            if (!channel || !handle || !Number.isFinite(since)) continue;
            const cur = byChannel.get(channel);
            byChannel.set(channel, { handle, since: cur ? Math.min(cur.since, since) : since });
          }
          const sinceMs = Math.min(...[...byChannel.values()].map((v) => v.since));
          const spoke = await ownerLastSpokeInChannels(slack, r.raw.selfId, [...byChannel.keys()], sinceMs);
          for (const [channel, ms] of spoke) ownerSpokeAt.set(`slack:${byChannel.get(channel)!.handle}`, ms);
        }
      } catch (e) {
        console.log(`[slack] answered-check failed — ${(e as Error).message.split("\n")[0]}`);
      }
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
async function pollGmail(ctx: PollContext): Promise<number> {
  const { opts, state, startedAtMs, waitingCards, ownerSpokeAt, sourceMessages, filteredOut, sourceErrors, perSource } = ctx;
  let promoFiltered = 0; // non-primary mail dropped at ingestion
    try {
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
      // INVITES SETTLE MEETING CARDS (core/calendar-invite.ts). The invite is
      // what a meeting's time actually is; the chat before it can be moved in a
      // thread the scan never sees. A card that matches an invite by the
      // organizer's EXACT email takes its time and loses its own invite line.
      // The invite message itself is then not drafted — the card already says
      // what it would have said, and drafting it is how a second card appears.
      // The FETCH lane only carries invites to the inbox — actions belong to
      // the analyse lane, which applies them (see applyInvites below). An
      // invite in mail he already READ is not inbound, so it travels as an
      // invite-only message: never drafted, only reconciled.
      const inviteById = new Map(r.invites.map((x) => [x.id, x.invite] as const));
      for (const m of r.inbound) {
        const inv = inviteById.get(m.id);
        if (inv) {
          m.invite = inv;
          inviteById.delete(m.id);
        }
      }
      for (const [id, invite] of inviteById) {
        sourceMessages.push({
          id,
          platform: "gmail",
          senderHandle: invite.organizer,
          timestampMs: startedAtMs,
          text: `Calendar invite: ${invite.summary ?? "(untitled)"}`,
          source: "gmail:invites",
          isDirectMessage: false,
          mentionsUser: false,
          isReplyInUserThread: false,
          recipientsIncludeUser: true,
          threadAnsweredByUserAfter: false,
          invite,
          inviteOnly: true,
        });
      }
      if (!opts.dryRun) {
        setGmailState(
          state.marks as Record<string, { lastTimestampMs: number; seenIds: string[] }>,
          r.nextState,
        );
      }
      // ANSWERED-CLOSES for Gmail: the card knows its thread (context.thread_ref)
      // but not its mailbox; the helper tries each and the owner answers.
      try {
        const cards = waitingCards("gmail").filter((a) => typeof a.context?.thread_ref === "string");
        if (cards.length > 0) {
          const spoke = await ownerLastSpokeInThreads(clients, [...new Set(cards.map((a) => a.context!.thread_ref!))]);
          for (const a of cards) {
            const ms = spoke.get(a.context!.thread_ref!);
            const handle = a.context?.sender_handle;
            if (ms !== undefined && handle) ownerSpokeAt.set(`gmail:${handle}`, Math.max(ms, ownerSpokeAt.get(`gmail:${handle}`) ?? 0));
          }
        }
      } catch (e) {
        console.log(`[gmail] answered-check failed — ${(e as Error).message.split("\n")[0]}`);
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
      // One SHORT line per failed mailbox, mailbox first. The activity log keeps
      // 200 characters of a source's error, and one OAuth failure is longer than
      // that on its own — so the second mailbox to fail was cut off and never
      // appeared anywhere. Measured 2026-09-29: zhenghleo@gmail.com had been
      // failing next to huizhezheng@gmail.com with no trace of it in the log.
      const partialErr = r.errors.length
        ? r.errors.map((e) => `mailbox=${e.mailbox}: ${shortMailboxError(e.error)}`).join("; ")
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
  return promoFiltered;
}

// ── WeChat pass (local-DB; 1:1 only) ───────────────────────────
// Trigger on unread sessions (get_recent_sessions), pull the actual
// incoming messages with direction + full context (get_chat_history).
async function pollWechat(ctx: PollContext): Promise<WechatPoll> {
  const { opts, state, startedAtMs, ownerSpokeAt, sourceMessages, filteredOut, sourceErrors, perSource } = ctx;
  let pendingWechatDirect: PendingBook<DirectBook> | undefined;
  let pendingWechatGroups: PendingBook<GroupBook> | undefined;
  const wechatSpoke: Participation[] = [];
    try {
      const { scanWechatInbox, scanWechatGroups, ownerLastSpokeIn, parseOfficialAccountNames } = await import("../sources/wechat-direct.js");
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
      const fetchHistory =
        opts.wechatFetchHistory ?? ((name: string, limit: number) => wechatHistory(name, { limit }));
      const directBefore = opts.wechatDirect?.load() ?? {};
      const r = await scanWechatInbox({
        fetchSessions: opts.wechatFetchSessions ?? (() => wechatSessions({ limit: 30 })),
        fetchHistory,
        officialNames,
        nowMs: startedAtMs,
        book: directBefore,
      });
      // NOT saved yet. The cursor is held until the drafter has had its turn:
      // a chat whose draft FAILS must be re-read next tick, or its messages are
      // gone for good. Measured 2026-09-24: the Osyx-浦软 group timed out at
      // 180s and the advance had already been committed, so the whole 股权变更
      // discussion — a 12/06 deadline, a three-stage plan, and a direct request
      // for the 财务报表 — was never seen again by anything.
      pendingWechatDirect = { prev: directBefore, next: r.book };
      wechatSpoke.push(...r.spoke);
      // GROUPS (2026-09-12) run off the same kind of per-group cursor, over an
      // allowlist the owner confirms plus an auto-admit for small groups
      // (core/wechat-groups.ts). 1:1 joined them on 2026-09-20: unread-gating
      // lost every commitment the owner handled on the spot.
      if (opts.wechatGroups) {
        try {
          const groupsBefore = opts.wechatGroups.load();
          const g = await scanWechatGroups({
            sessions: r.sessions,
            book: groupsBefore,
            fetchHistory,
            now: () => new Date(startedAtMs).toISOString(),
          });
          // Held for the same reason as the 1:1 book above.
          pendingWechatGroups = { prev: groupsBefore, next: g.book };
          r.inbound.push(...g.inbound);
          wechatSpoke.push(...g.spoke);
        } catch (e) {
          // A group-pass failure must never cost the 1:1 scan its tick.
          console.log(`[wechat] group pass failed — ${(e as Error).message.split("\n")[0]}`);
        }
      }
      // ANSWERED-CLOSES (core/action-item.ts): a card whose whole job was
      // "write back to this person" is finished the moment he writes back, and
      // he should never have to tick it. The fact cannot arrive as a message —
      // an answered WeChat thread has no unread, so it is not a scan candidate
      // at all — so it is fetched, for the handful of conversations that have
      // such a card open and no others.
      try {
        const waiting = [
          ...new Set(
            state.actions
              .filter((a) => a.status === "suggested" && a.params?.answered_closes === true)
              .map((a) => a.context?.sender_handle)
              .filter((h): h is string => !!h),
          ),
        ];
        if (waiting.length > 0) {
          for (const [h, ms] of await ownerLastSpokeIn(waiting, fetchHistory)) ownerSpokeAt.set(`wechat:${h}`, ms);
        }
      } catch (e) {
        console.log(`[wechat] answered-check failed — ${(e as Error).message.split("\n")[0]}`);
      }
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
  return { pendingDirect: pendingWechatDirect, pendingGroups: pendingWechatGroups, spoke: wechatSpoke };
}

/** Write `mutate` into fresh state under the (retried) lock; false if the lock never came. */
type CommitUnderLock = (mutate: (fresh: LoopState) => void) => Promise<boolean>;

// ── PHASE 6a (UNLOCKED, no LLM): pull completions BACK from TickTick.
//
// Runs BEFORE the push, so a task the owner just finished is closed here and
// is no longer eligible in the push below — rather than being re-written and
// only closed on the next tick.
//
// Non-fatal, like the push: TickTick being unreachable must never stop a scan.
async function applyTickTickReadback(
  opts: ScanLoopOptions,
  reader: TickTickReader,
  commitUnderLock: CommitUnderLock,
  startedAtMs: number,
): Promise<void> {
  try {
    // EVERY list a tracked task lives in — see readAllActive for why this is
    // derived from the map rather than named.
    const syncMap = loadSyncMap(opts.statePath);
    const { tasks: remote, complete } = await readAllActive(reader, syncMap);
    const snapshot = loadState(opts.statePath);
    const { ticked, closed, dismissed, closedUnitKeys, dismissedLedger, ownerNotes, map, unitsClosed } = readbackFromTickTick(
      snapshot,
      syncMap,
      remote,
      complete,
    );
    // His own tickets, for the drafter and the person pass (core/owner-tickets.ts).
    // Only from a COMPLETE read: a partial one would drop tickets and uncover work.
    if (complete) {
      try {
        saveOwnerTickets(opts.statePath, ownerTicketsFrom(remote, syncMap));
      } catch (e) {
        console.error(`[ticktick] owner tickets not saved: ${errString(e)}`);
      }
    }

    // Tick-to-execute: a ticked executable line is his approval (executeTicked).
    const executedNow =
      ticked.length > 0 && opts.execute
        ? await executeTicked(ticked, snapshot.actions, opts.execute, commitUnderLock, startedAtMs)
        : [];

    // Everything else the readback learned: whole-task closes always record
    // done; ticked items record done too when no executor is configured
    // (the pre-§1 behaviour — a tick means "I already did it").
    const done = new Set([...closed, ...(opts.execute ? [] : ticked)]);

    // CLOSE THE LOOP ON LEDGER ROWS. A ledger row is derived fresh from a
    // persona commitment every tick, so finishing it in TickTick settled
    // nothing: the commitment stayed `open`, the next tick re-derived the
    // row, and the diff REOPENED the task. 50-70 rows came back every tick
    // this way, which is why the same work kept reappearing after the owner
    // had already closed it. The completion has to land on the commitment.
    //
    // actor "human": this is the owner's own gesture, not an inference.
    const ledgerDone =
      closedUnitKeys.length > 0 && opts.personaDir
        ? markLedgerCommitmentsDone(closedUnitKeys, {
            personaDir: opts.personaDir,
            onError: (k, e) => console.error(`[ticktick] ledger close FAILED for ${k}: ${errString(e)}`),
          })
        : 0;
    if (ledgerDone > 0) console.log(`[ticktick] ${ledgerDone} ledger commitment(s) marked done`);

    // HIS NOTES after 「🚫 这条不该出现」 — on disk the moment they are seen
    // (io/owner-notes-store.ts).
    if (ownerNotes.length > 0) {
      try {
        const n = recordOwnerNotes(opts.statePath, ownerNotes);
        if (n > 0) console.log(`[ticktick] ${n} new owner note(s) after 🚫 recorded`);
      } catch (e) {
        console.error(`[ticktick] owner notes NOT recorded: ${errString(e)}`);
      }
    }

    // 🚫 on a LEDGER row: the commitment is dropped, so the next derive stops
    // listing it and the ordinary complete path takes the task away.
    const ledgerDropped =
      dismissedLedger.length > 0 && opts.personaDir
        ? markLedgerCommitmentsDropped(dismissedLedger, {
            personaDir: opts.personaDir,
            onError: (k, e) => console.error(`[ticktick] ledger dismiss FAILED for ${k}: ${errString(e)}`),
          })
        : 0;
    if (ledgerDropped > 0) console.log(`[ticktick] ${ledgerDropped} ledger commitment(s) dropped by owner (🚫)`);

    // THE ONLY VERDICT THE OWNER CAN GIVE FOR FREE. Every other exit a row has
    // — 完成, deleted, aged out, superseded — says nothing about whether the
    // row deserved to exist: the owner's own words are that he completes
    // things only because there is no other way to clear them, and the data
    // agrees (353 of 400 completions were engine rows, 0 of them meaningful).
    // Ticking DISMISS_LINE is the one gesture that can only mean "this should
    // not have been here", so it is the one that becomes a label.
    //
    // Written BEFORE the status change, per the labels.jsonl contract: if the
    // append throws, the rows stay as they are and the next tick retries.
    const dismissedSet = new Set(dismissed);
    if (dismissedSet.size > 0) {
      const rows = snapshot.actions.filter((a) => dismissedSet.has(a.id));
      appendLabels(
        labelsPathFor(opts.statePath),
        rows.map((a) =>
          buildLabel({
            action: a,
            decision: "rejected",
            existence: "not_a_thing",
            decided_at: new Date().toISOString(),
            note: "owner ticked 这条不该出现",
          }),
        ),
      );
      console.log(`[ticktick] ${rows.length} row(s) dismissed by owner → not_a_thing`);
    }

    // THE OTHER HALF OF THE VERDICT. Before DISMISS_LINE existed, completing
    // a row meant nothing — it was also the only way to clear noise, which is
    // the owner's own account of why he completed 353 engine rows without
    // meaning any of them. Now that a bad row has its own exit, a completion
    // with the dismissal line UNTICKED says what it always should have: this
    // was real work and it is finished. That is the positive class the label
    // corpus never had (131 negative / 4 positive before this).
    //
    // Honest limit: a DELETED task is indistinguishable from a completed one
    // here — both are simply absent from the active list. The owner does not
    // delete (that absence is exactly why the dismissal line had to be built),
    // so this is read as completion.
    //
    // Ledger rows are not labelled: they carry no ActionItem to snapshot, and
    // their positive signal lands as `status: done` on the commitment above.
    const closedSet = new Set(closed);
    if (closedSet.size > 0) {
      const rows = snapshot.actions.filter((a) => closedSet.has(a.id));
      try {
        appendLabels(
          labelsPathFor(opts.statePath),
          rows.map((a) =>
            buildLabel({
              action: a,
              decision: "executed",
              existence: "confirmed",
              decided_at: new Date().toISOString(),
              note: "owner completed without dismissing",
            }),
          ),
        );
      } catch (e) {
        // A lost positive label is not worth failing the tick over; the row
        // still closes. Loud, so a systematic failure cannot hide.
        console.error(`[ticktick] confirmed-label append FAILED: ${errString(e)}`);
      }
    }

    // The MAP is saved on its own signal. `done` counts card-derived actions,
    // and a ledger row has no action behind it — gating the save on `done`
    // threw away every tombstone the owner earned by finishing ledger tasks.
    // Measured on the real account before this fix: 141 tracked records, 0
    // tombstones, 87 tasks already gone from TickTick. No tombstone is what
    // mints twins, because a re-listed to-do then creates instead of reopens.
    // `unitsClosed` is exactly how many records were tombstoned this pass, so
    // it is the map-changed signal.
    if (unitsClosed > 0) saveSyncMap(opts.statePath, map);

    if (done.size > 0 || executedNow.length > 0 || dismissedSet.size > 0) {
      const byId = new Map(executedNow.map((a) => [a.id, a]));
      await commitUnderLock((fresh) => {
        fresh.actions = fresh.actions.map((a) => {
          const exec = byId.get(a.id);
          if (exec) return exec; // the executed action, receipt and all
          if (a.status !== "suggested" && a.status !== "approved") return a;
          // `rejected`, never `executed`: the owner did NOT do this work, he
          // said it was never work. Recording it as executed is the lie the
          // readback comment above warns about.
          if (dismissedSet.has(a.id)) return { ...a, status: "rejected" as const };
          return done.has(a.id) ? { ...a, status: "executed" as const } : a;
        });
      });
    }
    if (done.size > 0 || executedNow.length > 0 || unitsClosed > 0 || dismissedSet.size > 0) {
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

// TICK-TO-EXECUTE (specs/ticktick-migration.md §1): a ticked EXECUTABLE
// line — the labelled invite/tool lines are the only tracked ones — is the
// owner's approval, and it executes here. executeAction is idempotent by
// receipt, and persistClaim writes the durable "executing" mark BEFORE the
// side effect, so a crash between claim and receipt surfaces as
// NeedsVerification instead of a silent double-send.
async function executeTicked(
  ticked: readonly string[],
  actions: readonly ActionItem[],
  execute: ExecuteDeps,
  commitUnderLock: CommitUnderLock,
  startedAtMs: number,
): Promise<ActionItem[]> {
  const executedNow: ActionItem[] = [];
  for (const id of ticked) {
    const action = actions.find((a) => a.id === id);
    if (!action || action.status === "executed" || action.status === "rejected") continue;
    if (action.action_type !== "calendar" && action.action_type !== "tool") continue;
    try {
      // The tick is the approval — but approveAction still runs the
      // missing-info gate (ASK-not-GUESS): a card with unresolved params
      // refuses here, loudly, instead of sending something half-built.
      const approved = action.status === "suggested" ? approveAction(action) : action;
      const r = await executeAction(approved, {
        ...execute,
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
  return executedNow;
}

/** Append to the activity log; a dry run logs nothing. */
function activityLogger(opts: ScanLoopOptions): (kind: ActivityKind, summary: string, data?: Record<string, unknown>) => void {
  const activityPath = activityPathFor(opts.statePath);
  return (kind, summary, data) => {
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
}

// Write updates to HIS plan tickets (core/plan-progress.ts). Best-effort and
// loud: a failed write changes nothing on his ticket and is retried only by
// the next conversation that carries the same news.
async function writePlans(opts: ScanLoopOptions, updates: readonly PlanUpdate[]): Promise<void> {
  if (opts.dryRun || !opts.ticktickWriter?.patchPlan || updates.length === 0) return;
  const logActivity = activityLogger(opts);
  const titles = new Map(loadOwnerTickets(opts.statePath).map((t) => [t.id, t.title]));
  for (const u of mergePlanUpdates(updates)) {
    try {
      if (!(await opts.ticktickWriter.patchPlan(u.ticketId, u))) continue;
      const what = `「${titles.get(u.ticketId) ?? u.ticketId}」: ${u.check.length} step(s) ticked, ${u.notes.length} note(s), ${u.addSteps.length} step(s) added`;
      console.log(`[plan] ${what}`);
      logActivity("supersede", `plan updated ${what}`, { phase: "plan", ...u });
    } catch (e) {
      console.error(`[plan] update of ${u.ticketId} failed: ${errString(e)}`);
    }
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
async function runPersonPass(
  opts: ScanLoopOptions,
  personaUpdate: PersonaUpdateDeps,
  commitUnderLock: CommitUnderLock,
  startedAtMs: number,
): Promise<void> {
  const logActivity = activityLogger(opts);
  const cursors = loadState(opts.statePath);
  const queue = personsNeedingAssessment(
    cursors.personTraffic ?? {},
    cursors.personAssessed ?? {},
    opts.maxPersonsPerTick ?? 3,
  );
  if (queue.length > 0) {
    try {
      console.log(`[progress] assessing ${queue.length} contact(s) with new traffic…`);
      const pu = await updatePersonaCommitments(queue, personaUpdate);
      await writePlans(opts, pu.planUpdates);
      if (pu.closedDone > 0) {
        console.log(`[closure] ${pu.closedDone} listed commitment(s) already done per the conversation`);
        logActivity("supersede", `closed ${pu.closedDone} listed commitment(s) the conversation showed done`, { phase: "person-pass", closedDone: pu.closedDone });
      }
      // Cursors advance for everyone the pass FINISHED with, including the
      // unreadable — otherwise one contact with no mapped handle sits at the
      // head of the oldest-first queue every tick and starves the rest.
      //
      // A FAILED call is different: its traffic was never read. It holds its
      // cursor and is retried, up to PERSON_ASSESS_RETRIES consecutive
      // failures — then it gives up loudly, because a contact whose call
      // always fails (a corpus too big to answer in time) would otherwise
      // hold one of the few slots per tick forever.
      let gaveUp: string[] = [];
      if (pu.attempted.length > 0 || pu.failed.length > 0) {
        await commitUnderLock((fresh) => {
          const fails = { ...(fresh.personAssessFailures ?? {}) };
          for (const e of pu.attempted) delete fails[e.personaKey];
          const giveUp = pu.failed.filter((e) => (fails[e.personaKey] = (fails[e.personaKey] ?? 0) + 1) >= PERSON_ASSESS_RETRIES);
          for (const e of giveUp) delete fails[e.personaKey];
          gaveUp = giveUp.map((e) => e.personaKey);
          fresh.personAssessed = markAssessed(fresh.personAssessed ?? {}, [...pu.attempted, ...giveUp]);
          fresh.personAssessFailures = fails;
        });
      }
      if (pu.unavailable.length > 0) {
        console.error(
          `[persona] LLM unavailable — ${pu.unavailable.map((e) => e.personaKey).join(", ")} held, not counted as failures`,
        );
      }
      if (pu.failed.length > 0) {
        console.error(
          `[persona] assessment FAILED for ${pu.failed.map((e) => e.personaKey).join(", ")} — retrying next tick`,
        );
      }
      if (gaveUp.length > 0) {
        console.error(
          `[persona] GAVE UP after ${PERSON_ASSESS_RETRIES} failed assessments: ${gaveUp.join(", ")} — their latest traffic is unread until they speak again`,
        );
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

export async function runScanTick(opts: ScanLoopOptions): Promise<ScanLoopResult> {
  const startedAtMs = Date.now();
  const mode = opts.mode ?? "all";
  const perSource: SourceSummary[] = [];
  // `platform:handle` → when the OWNER last spoke in that conversation. Each
  // source pass fills its own platform, only for conversations that have a
  // reply-only card waiting (params.answered_closes); empty otherwise. Keyed
  // exactly as core/action-item.ts conversationKey builds it.
  const ownerSpokeAt = new Map<string, number>();
  const waitingCards = (platform: string) =>
    state.actions.filter(
      (a) =>
        a.status === "suggested" &&
        a.params?.answered_closes === true &&
        (a.target?.platform ?? a.source_message_id.split(":")[0]) === platform,
    );
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
  const logActivity = activityLogger(opts);
  // PHASE 0 (UNLOCKED snapshot): take a consistent read of state WITHOUT the
  // lock. saveState writes atomically (tmp + rename) and carries a revision
  // guard, so an unlocked read sees old-or-new bytes, never a torn file —
  // Each lane OWNS its fields (fetch: cursors, marks, sources' errors; analyse:
  // actions, person cursors), so reading them here lock-free is race-free; the
  // brief commit reloads fresh state under a (retrying) lock and transplants
  // only this lane's fields.
  // Holding NO lock through the slow scan + draft + consolidate + refresh means a
  // tick can never fail with "another tick is running" just because the other
  // lane (or a prior commit) briefly held the lock — that was the source of the
  // intermittent contention noise.
  let pendingWechatDirect: PendingBook<DirectBook> | undefined;
  let pendingWechatGroups: PendingBook<GroupBook> | undefined;
  // Who took part in what the WeChat pass read (sources/wechat-direct.ts Participation).
  const wechatSpoke: Participation[] = [];

  let state: LoopState;
  try {
    state = loadState(opts.statePath);
    // The analyser polls nothing: its input is the inbox.
    const sources = mode === "analyze" ? [] : (opts.sources ?? ["slack", "gmail"]);

    const poll: PollContext = {
      opts, state, stateDir, startedAtMs, waitingCards, ownerSpokeAt,
      sourceMessages, filteredOut, sourceErrors, perSource,
    };

    if (sources.includes("slack")) await pollSlack(poll);
    if (sources.includes("gmail")) promoFiltered += await pollGmail(poll);
    if (sources.includes("wechat")) {
      const w = await pollWechat(poll);
      pendingWechatDirect = w.pendingDirect;
      pendingWechatGroups = w.pendingGroups;
      wechatSpoke.push(...w.spoke);
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
        // WeChat participation — wider than the triggered messages: Leo's own
        // lines, and every speaker in a group, bound by EXACT handle or not at
        // all (resolvePersonaKey never guesses). See sources/wechat-direct.ts.
        const inGroups: Array<{ personaKey: string; group: string; timestampMs: number }> = [];
        for (const p of wechatSpoke) {
          const key = opts.resolvePersonaKey(p.handle);
          if (!key) continue;
          spoke.push({ personaKey: key, timestampMs: p.tsMs });
          if (p.group) inGroups.push({ personaKey: key, group: p.group, timestampMs: p.tsMs });
        }
        state.personTraffic = recordTraffic(state.personTraffic ?? {}, spoke);
        if (inGroups.length > 0) state.personGroups = recordGroupPresence(state.personGroups ?? {}, inGroups);
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
    // Split lanes: fetch drafts nothing; analyze drafts from the inbox, and
    // what the cap leaves out stays queued rather than being counted and lost.
    if (mode === "fetch") {
      draftInput = [];
      draftSkipped = 0;
    } else if (mode === "analyze") {
      draftInput = takeForDraft(state.inbox ?? [], opts.maxDraftCandidates);
      draftSkipped = 0;
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
  // (drafted actions, the shadow record). Reloading fresh preserves whatever the
  // other lane committed meanwhile.
  // Returns false if the lock couldn't be re-acquired within the retry window.
  const commitUnderLock = async (mutate: (fresh: LoopState) => void): Promise<boolean> => {
    if (!(await acquireLockWithRetry(stateDir))) return false;
    try {
      const fresh = loadState(opts.statePath);
      // Transplant only what THIS lane owns. With two lanes running at once, a
      // wholesale copy from a snapshot taken minutes ago would roll the other
      // lane's progress back — the analyser rewinding cursors the fetch lane
      // had just advanced, which re-fetches and re-drafts the same messages.
      // The analyser owns none of these; the fresh copy is authoritative.
      if (mode !== "analyze") {
        fresh.marks = state.marks;
        fresh.sourceErrors =
          mode === "all"
            ? state.sourceErrors
            : // fetch: per-source keys are this lane's, `llm:*` the analyser's
              Object.fromEntries([
                ...Object.entries(fresh.sourceErrors).filter(([k]) => k.startsWith("llm:")),
                ...Object.entries(state.sourceErrors).filter(([k]) => !k.startsWith("llm:")),
              ]);
        // personTraffic is owned by the scan, so it is carried over.
        // personAssessed is owned only by the phase-7 mutate, so it is NOT:
        // loadState fills a missing field with {}, and `{}` is truthy — copying it
        // from the tick's start-of-run snapshot silently wiped the cursor a phase
        // later, and the pass then re-assessed the same person every single tick.
        fresh.personTraffic = state.personTraffic ?? fresh.personTraffic;
        // Same ownership as personTraffic: written by the scan.
        fresh.personGroups = state.personGroups ?? fresh.personGroups;
      }
      mutate(fresh);
      saveState(opts.statePath, fresh);
      return true;
    } finally {
      releaseLock(stateDir);
    }
  };

  // ── FETCH LANE COMMIT. The whole point of the lane: everything it read is
  // made DURABLE in the inbox before any cursor moves, in one locked write, and
  // then it returns — no LLM, no TickTick, nothing that can take minutes.
  const commitFetch = async (): Promise<ScanLoopResult> => {
    const roundAt = new Date(startedAtMs).toISOString();
    let enqueued = 0;
    let overflow: InboxEntry[] = [];
    let answered = 0;
    const ok = opts.dryRun
      ? true
      : await commitUnderLock((fresh) => {
          const before = new Set((fresh.inbox ?? []).map((e) => e.msg.id));
          const r = enqueue(fresh.inbox ?? [], sourceMessages, roundAt);
          fresh.inbox = r.inbox;
          overflow = r.overflow;
          enqueued = sourceMessages.filter((m) => !before.has(m.id)).length;
          // Cards Leo already answered. The signal — when he last spoke in the
          // conversation — only exists here, at fetch, so this lane applies it.
          const done = cardsAnsweredSince(fresh.actions, ownerSpokeAt);
          answered = dropSuperseded(opts.statePath, fresh, done);
          // What the trigger filter dropped is recorded HERE, where it was seen;
          // the analyser records what it drafted.
          if (filteredOut.length > 0) {
            appendShadowRecord(
              join(stateDir, "shadow-log.jsonl"),
              buildShadowRecord(roundAt, [], { runtime: "phase3-t-proc", source_messages: [], filtered: filteredOut }),
            );
          }
        });
    if (ok && !opts.dryRun) {
      // AFTER the inbox write: the messages are durable, so the cursors may move.
      // No rollback is needed any more — a draft failure leaves the message in
      // the inbox, not behind a cursor.
      if (pendingWechatDirect && opts.wechatDirect) opts.wechatDirect.save(pendingWechatDirect.next);
      if (pendingWechatGroups && opts.wechatGroups) opts.wechatGroups.save(pendingWechatGroups.next);
    } else if (!ok) {
      logActivity("error", "fetch commit failed (lock busy) — nothing queued, no cursor moved; the next fetch re-reads", {
        phase: "fetch-commit",
      });
    }
    if (overflow.length > 0) {
      console.error(`[inbox] FULL — dropped the ${overflow.length} oldest waiting message(s)`);
      logActivity(
        "error",
        `inbox full — dropped the ${overflow.length} oldest waiting message(s): ${[...new Set(overflow.map((e) => e.msg.senderHandle))].join(", ")}`,
        { phase: "fetch-commit", dropped: overflow.map((e) => e.msg.id) },
      );
    }
    if (answered > 0) {
      logActivity("supersede", `closed ${answered} card(s) Leo had already answered`, { phase: "fetch-commit", answered });
    }
    const totalInbound = perSource.reduce((n, x) => n + x.inboundCount, 0);
    const totalTriggered = perSource.reduce((n, x) => n + x.triggered, 0);
    const erroredSources = perSource.filter((x) => x.error).map((x) => x.source);
    if (totalInbound > 0 || erroredSources.length > 0) {
      const sig = JSON.stringify(perSource.map((x) => [x.source, x.inboundCount, x.triggered, x.error ?? null]));
      const scope = `fetch:${[...erroredSources].sort().join(",")}`;
      if (!(totalInbound === 0 && lastErrorTickSigByScope.get(scope) === sig)) {
        const parts = perSource.map((x) => `${x.source} ${x.inboundCount} in/${x.triggered} trig${x.error ? " ERR" : ""}`);
        logActivity("tick", `${parts.join("; ")} → queued ${enqueued}`, {
          durationMs: Date.now() - startedAtMs,
          enqueued,
          ...(erroredSources.length > 0
            ? {
                erroredSources,
                errors: Object.fromEntries(perSource.filter((x) => x.error).map((x) => [x.source, x.error!.slice(0, 200)])),
              }
            : {}),
        });
        if (totalInbound === 0) lastErrorTickSigByScope.set(scope, sig);
      }
    }
    return {
      startedAtMs,
      durationMs: Date.now() - startedAtMs,
      perSource,
      totalInbound,
      totalTriggered,
      shadowWritten: ok && filteredOut.length > 0,
      drafted: 0,
      draftSkipped: 0,
      promoFiltered,
      enqueued,
    };
  };

  // ── PHASE 1.5 (re-locked, brief): commit cursors/marks NOW, BEFORE the slow
  // draft. The draft is exactly when the other lane is most likely to commit,
  // so committing cursors first means a later phase-3 miss can only
  // drop drafts (re-drafted next tick) — never cursor progress (losing that
  // would re-surface + re-scan already-handled messages, breaking dedup).
  if (mode === "fetch") return await commitFetch();
  // The analyser owns no cursor, so it has nothing to commit before drafting.
  if (!opts.dryRun && mode === "all") await commitUnderLock(() => {});

  // ── PHASE 2 (UNLOCKED): the slow LLM drafting (+ vision decode). No lock is
  // held, so the other lane keeps committing even through a long or hung draft.
  let draftedActions: ActionItem[] = [];
  /** Senders whose draft call errored. Their cursors are NOT advanced. */
  let draftFailedSenders: string[] = [];
  let draftUnavailableSenders: string[] = [];
  let doneCards: Array<{ id: string; evidence: string }> = [];
  const planUpdates: PlanUpdate[] = [];
  let closedByConversation: string[] = [];
  let llmDraftError: string | undefined;
  // Every sender failed — a systemic outage, not a per-sender fault.
  let llmDraftOutage = false;
  // Senders whose draft call succeeded but produced ZERO cards — the silent
  // skip (cursor already advanced). Surfaced as llm:draft-empty in phase 3.
  let draftEmpty: string[] = [];
  // INVITES SETTLE MEETING CARDS (core/calendar-invite.ts) — in the analyse
  // lane, which owns actions. A message whose invite matches an open card by
  // the organizer's exact email is not drafted (the card already says it, and
  // drafting is how a second card appears); an invite-only message — mail he
  // had already read — is never drafted. The card itself is updated in the
  // same locked commit that settles the inbox, re-matched against disk.
  const inviteMsgs = draftInput.filter((m) => m.invite);
  const toDraft = draftInput.filter((m) => !m.invite || (!m.inviteOnly && !cardForInvite(state.actions, m.invite)));
  if (opts.draft && toDraft.length > 0) {
    try {
      console.log(`[progress] drafting ${toDraft.length} candidate(s)…`);
      const r = await draftActions(toDraft, opts.draft);
      draftedActions = r.actions;
      draftEmpty = r.empty;
      draftFailedSenders = r.errors.map((e) => e.sender);
      // Open cards this batch shows DONE (proc/card-closure.ts). Never fatal.
      if (opts.personaUpdate) {
        try {
          doneCards = await closeDoneCards(state.actions, toDraft, new Set(draftFailedSenders), opts.personaUpdate.json);
        } catch (e) {
          console.error(`[closure] card check failed: ${errString(e)}`);
        }
      }
      // His plans: steps the drafter placed in them, and — for senders with no
      // persona, whom the person pass never reads — what their new messages
      // change (core/plan-progress.ts). A persona's plan news comes from the
      // person pass, so it is not asked twice.
      planUpdates.push(...r.planSteps);
      if (opts.personaUpdate && opts.ticktickWriter?.patchPlan) {
        const tickets = loadOwnerTickets(opts.statePath);
        const failed = new Set(draftFailedSenders);
        const strangers = new Map<string, InboundMessage[]>();
        for (const m of toDraft) {
          if (failed.has(m.senderHandle) || opts.draft.resolvePersona(m.senderHandle)) continue;
          strangers.set(m.senderHandle, [...(strangers.get(m.senderHandle) ?? []), m]);
        }
        for (const [sender, msgs] of strangers) {
          const name = msgs[0]!.senderName ?? sender;
          const spoken = msgs.flatMap((m) =>
            m.text.split("\n").map((t) => t.trim()).filter(Boolean).map((text) => ({ speaker: "them" as const, who: name, text })),
          );
          try {
            planUpdates.push(...(await findPlanProgress(name, tickets, spoken, opts.personaUpdate.json, localDate(Date.now(), machineTimeZone()))));
          } catch (e) {
            console.error(`[plan] ${name}: ${errString(e)}`);
          }
        }
      }
      draftUnavailableSenders = r.errors.filter((e) => isLlmUnavailable(e.error)).map((e) => e.sender);
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

  // COMMIT THE CURSORS — every chat except the ones whose draft failed. A
  // failed sender keeps its OLD cursor so the next tick reads those messages
  // again; everything else advances as normal, or one slow contact would make
  // the whole account re-read itself every tick.
  //
  // The book is keyed by chat name and `sender` IS that name, so the rollback
  // is exact. A whole-call failure (the catch above) names no sender, so
  // nothing advances — the safe direction when we cannot tell who was hurt.
  {
    const failed = new Set(draftFailedSenders);
    const wholeCallFailed = llmDraftError !== undefined && failed.size === 0;
    const commit = <T extends Record<string, unknown>>(p: PendingBook<T>): T => {
      if (wholeCallFailed) return p.prev;
      if (failed.size === 0) return p.next;
      const out: Record<string, unknown> = { ...p.next };
      for (const name of failed) {
        if (name in p.prev) out[name] = p.prev[name];
        else delete out[name];
      }
      return out as T;
    };
    if (pendingWechatDirect && opts.wechatDirect) {
      opts.wechatDirect.save(commit(pendingWechatDirect));
    }
    if (pendingWechatGroups && opts.wechatGroups) {
      opts.wechatGroups.save(commit(pendingWechatGroups));
    }
    if (failed.size > 0 || wholeCallFailed) {
      console.log(
        `[wechat] cursor held for ${wholeCallFailed ? "ALL chats (whole draft call failed)" : [...failed].join(", ")} — will re-read next tick`,
      );
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
    // The analyser's messages come from the inbox; the fetch lane already
    // recorded what it filtered.
    source_messages: mode === "analyze" ? draftInput : sourceMessages,
    filtered: mode === "analyze" ? [] : filteredOut,
  };
  const willWrite = shouldWriteShadowRecord(draftedActions, shadowInput);
  let shadowWritten = false;
  let draftedCount = 0;
  // Supersede bookkeeping for the activity log, filled inside the phase-3
  // commit (which may not run) and logged after it resolves.
  let supersededCount = 0;
  let supersedeExemptCount = 0;
  let staleRetiredCount = 0;
  let answeredCount = 0;
  let autoCalendarCount = 0;
  let inboxGaveUp: InboxEntry[] = [];
  const settlesInbox = mode === "analyze" && draftInput.length > 0;
  if (
    !opts.dryRun &&
    (settlesInbox || inviteMsgs.length > 0 || draftedActions.length > 0 || doneCards.length > 0 || llmDraftError !== undefined || draftEmpty.length > 0 || willWrite)
  ) {
    const committed = await commitUnderLock((fresh) => {
      // Cards the conversation showed done: closed as executed, the proof kept
      // on the card. No label — this is the engine's reading, not his verdict.
      closedByConversation = [];
      for (const d of doneCards) {
        const card = fresh.actions.find((a) => a.id === d.id && (a.status === "suggested" || a.status === "approved"));
        if (!card) continue;
        fresh.actions = fresh.actions.map((a) =>
          a.id === d.id
            ? { ...a, status: "executed" as const, params: { ...a.params, closed_by: "conversation", closed_evidence: d.evidence } }
            : a,
        );
        closedByConversation.push(card.headline ?? String(card.params.title ?? card.id));
      }
      for (const m of inviteMsgs) {
        const card = cardForInvite(fresh.actions, m.invite!);
        if (!card) continue;
        const next = applyInvite(card, m.invite!);
        if (JSON.stringify(next.params) === JSON.stringify(card.params)) continue;
        fresh.actions = fresh.actions.map((a) => (a.id === card.id ? next : a));
        console.log(`[invite] settled "${next.headline}" → ${String(next.params.start)} (from ${m.invite!.organizer})`);
      }
      // Settled in the SAME write as the cards: a message leaves the inbox
      // exactly when its cards land, so a lost lock means it is drafted again
      // — which is what the message below this block has always promised.
      if (settlesInbox) {
        const failed = new Set(draftFailedSenders);
        // A sender whose call failed because the LLM is UNAVAILABLE was never
        // tried: left out of `attempted`, its messages stay queued, uncounted.
        const unavailable = new Set(draftUnavailableSenders);
        const tried = unavailable.size > 0 ? draftInput.filter((m) => !unavailable.has(m.senderHandle)) : draftInput;
        const wholeFailed = llmDraftError !== undefined && failed.size === 0;
        const r = wholeFailed && isLlmUnavailable(llmDraftError)
          ? { inbox: fresh.inbox ?? [], gaveUp: [] }
          : settle(fresh.inbox ?? [], tried, failed, wholeFailed);
        fresh.inbox = r.inbox;
        inboxGaveUp = r.gaveUp;
      }
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
        const supersedeOk = superseded.length === 0 || dropSuperseded(opts.statePath, fresh, superseded) > 0;
        if (supersedeOk) {
          supersededCount = superseded.length;
          supersedeExemptCount = exemptKept;
        }
        // P1 durable identity: a replacement card INHERITS the superseded
        // card's task_id (copy, never mint) so its TickTick row stays attached
        // to the task across the supersede. Computed from the
        // superseded list regardless of whether the drop committed — the
        // cards are doomed next tick anyway, and a copied id is idempotent.
        fresh.actions.push(...inheritSupersededTaskIds(toCommit, superseded));
      }
      // The OTHER exit (core/action-item.ts): a suggested card the owner has not
      // touched in SILENT_RETIRE_DAYS ages out. Supersede above only ever fires
      // when a fresh draft for that sender produced cards, so a card on a thread
      // that simply went quiet had no way out at all. Runs unconditionally —
      // gating it on this tick's draft activity was the bug: the cards that need
      // ageing out are precisely the ones whose sender stopped talking. Labelled
      // before dropping, exactly like supersede: a dropped card never reaches a
      // terminal status, so the label is the only record it ever existed.
      {
        // Never age out a card this very tick just minted: the drafter has just
        // judged it relevant, so retiring it in the same breath is incoherent
        // whatever timestamp it carries. Caught by scan-loop's own tests, which
        // inject a fixed clock into drafting — the fresh card was born looking
        // three months old and swept before it was ever rendered.
        const justDrafted = new Set(draftedActions.map((a) => a.id));
        // Two ways out, both silent, both labelled: aged out, or ANSWERED. The
        // second is the owner's own request — a card whose whole job was
        // writing back should vanish when he writes back, not wait for him to
        // tick it. The map is keyed the same way conversationKey builds it.
        const answered = cardsAnsweredSince(fresh.actions, ownerSpokeAt);
        answeredCount = answered.length;
        const retired = [...staleSuggestedCards(fresh.actions, Date.now()), ...answered].filter(
          (a) => !justDrafted.has(a.id),
        );
        staleRetiredCount = dropSuperseded(opts.statePath, fresh, retired);
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
      // notices. Surface the handles in sourceErrors; the raw
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
      await writePlans(opts, planUpdates);
      draftedCount = draftedActions.length;
      if (closedByConversation.length > 0) {
        console.log(`[closure] ${closedByConversation.length} card(s) already done per the conversation: ${closedByConversation.join("; ")}`);
        logActivity("supersede", `closed ${closedByConversation.length} card(s) the conversation showed done: ${closedByConversation.join("; ")}`, {
          phase: "draft-commit",
          closedDone: closedByConversation,
        });
      }
      shadowWritten = willWrite;
      if (answeredCount > 0) {
        logActivity(
          "supersede",
          `closed ${answeredCount} card(s) Leo had already answered`,
          { phase: "draft-commit", answered: answeredCount },
        );
      }
      if (staleRetiredCount > 0) {
        logActivity(
          "supersede",
          `retired ${staleRetiredCount} card(s) untouched for ${SILENT_RETIRE_DAYS}+ days`,
          { phase: "draft-commit", staleRetired: staleRetiredCount },
        );
      }
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

  if (inboxGaveUp.length > 0) {
    // Loud by design: these messages failed every draft attempt and are no
    // longer queued. Never let that happen quietly.
    const who = [...new Set(inboxGaveUp.map((e) => e.msg.senderHandle))].join(", ");
    console.error(`[inbox] GAVE UP on ${inboxGaveUp.length} message(s) after repeated draft failures: ${who}`);
    logActivity("error", `inbox gave up on ${inboxGaveUp.length} message(s) after repeated draft failures: ${who}`, {
      phase: "draft-commit",
      gaveUp: inboxGaveUp.map((e) => e.msg.id),
    });
  }

  // Silent-empty drafts (LLM answered, zero cards — usually a parse-failure,
  // see llm-draft-raw.jsonl) are the invisible permanent skip. sourceErrors
  // shows them, but the next commit WIPES that entry — the durable record
  // lives here.
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

  // ── AUTO-CREATE CALENDAR (no LLM, no tick) ────────────────────────────
  //
  // The owner's decision, 2026-09-14: 「限制取消，日历允许自动创建」. A meeting
  // agreed in writing used to sit as a row waiting for him to tick it, which is
  // the one job he most expected the secretary to just do.
  //
  // The gate is core/executors.canAutoExecute → missingInfo: title, start, end,
  // and time_confirmed. An hour the thread never stated fails there and never
  // becomes an event — the same fail-closed rule that has always governed the
  // ticked route, not a weaker one. The conflict check inside executeAction
  // still runs, and an event that collides comes back unexecuted for him.
  //
  // notifyAttendees:false — this fills in HIS calendar. Mailing an invite to
  // other people stays a human act.
  if (!opts.dryRun && opts.execute) {
    const snapshot = loadState(opts.statePath);
    const auto = snapshot.actions.filter((a) => a.action_type === "calendar" && canAutoExecute(a));
    for (const action of auto) {
      try {
        const r = await executeAction(approveAction(action), {
          ...opts.execute,
          notifyAttendees: false,
          persistClaim: async (claimed) => {
            await commitUnderLock((fresh) => {
              fresh.actions = fresh.actions.map((a) => (a.id === claimed.id ? claimed : a));
            });
          },
        });
        await commitUnderLock((fresh) => {
          fresh.actions = fresh.actions.map((a) => (a.id === r.action.id ? r.action : a));
        });
        if (r.conflicts?.length) {
          console.log(`[calendar] auto-create held — conflicts: ${String(action.params.title ?? action.id)}`);
        } else {
          autoCalendarCount++;
          console.log(`[calendar] auto-created: "${String(action.params.title ?? action.id)}" (${r.receipt?.ref ?? "no ref"})`);
        }
      } catch (e) {
        // A SYSTEMIC fault stops the pass: an expired credential fails every
        // card identically and no amount of retrying changes that. Left
        // unchecked it produced 641 identical log lines in under an hour on
        // 2026-09-19, which is both noise and wasted tick time. A per-card
        // fault stays per-card — one bad event must not block the others.
        if (isSystemicExecuteFailure(e)) {
          console.log(
            `[calendar] auto-create ABORTED for this tick (setup fault, ${auto.length - autoCalendarCount} card(s) left) — ${(e as Error).message.split("\n")[0]}`,
          );
          break;
        }
        console.log(`[calendar] auto-create failed — ${(e as Error).message.split("\n")[0]}`);
      }
    }
    if (autoCalendarCount > 0) {
      logActivity("tick", `auto-created ${autoCalendarCount} calendar event(s)`, { autoCalendar: autoCalendarCount });
    }
  }

  // ── PHASE 6a (UNLOCKED, no LLM): read back what he did in TickTick (applyTickTickReadback).
  if (!opts.dryRun && opts.ticktickReader) {
    await applyTickTickReadback(opts, opts.ticktickReader, commitUnderLock, startedAtMs);
  }

  // ── PHASE 6b (UNLOCKED, no LLM): push the list — ledger rows + card rows —
  // into TickTick. No LLM call, so it is cheap enough to run every tick; the
  // hash gate in core/ticktick-sync.ts means a tick where nothing changed makes
  // ZERO API calls. Non-fatal — TickTick being down must never stop the scan
  // (records llm:ticktick in sourceErrors).
  if (!opts.dryRun && opts.ticktickWriter) {
    try {
      const snapshot = loadState(opts.statePath);
      const zone = opts.ownerTimeZone ?? machineTimeZone();
      const nowMs = Date.now();
      // THE LIST IS THE LEDGER (spec §7 phase 4): rows derive from open who=me
      // commitments the assess pass judged needs_leo. Cards contribute only what
      // the ledger cannot: executable invite/tool lines, and persona-less work.
      const ledger = opts.ledgerPersonas
        ? heldClosedByOwner(
            deriveLedgerTasks(
              opts.ledgerPersonas(),
              zone,
              nowMs,
              opts.activeMatters?.() ?? new Set(),
              opts.closedMatters?.() ?? new Set(),
              snapshot.personTraffic ?? {},
            ),
            // What HE closed stays closed until that person speaks again (G12).
            loadSyncMap(opts.statePath),
            snapshot.personTraffic ?? {},
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
      //
      // Live remote list for orphan reconciliation — non-fatal: without it the
      // sync still works, it just cannot see its own strays this tick. Same set
      // of lists as the readback. A partial read is harmless HERE (orphan
      // reconciliation only acts on tasks it saw), unlike in the readback.
      const remoteActive = opts.ticktickReader
        ? await readAllActive(opts.ticktickReader, loadSyncMap(opts.statePath)).then(
            (r) => r.tasks,
            () => undefined,
          )
        : undefined;
      // NEVER WRITE BLIND. An update replaces a task's whole checklist; what
      // keeps his note on the 🚫 line alive is reading the task first
      // (syncToTickTick). With TickTick unreadable this tick — the read failing
      // while a write might still land, as on 2026-10-03 when every call was
      // `fetch failed` for an hour — the push waits. Recorded as an error.
      if (opts.ticktickReader && remoteActive === undefined)
        throw new Error("TickTick unreadable this tick — not writing blind over the owner's notes");
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

  // ── PHASE 7: the PERSON pass (runPersonPass).
  if (!opts.dryRun && opts.personaUpdate) {
    await runPersonPass(opts, opts.personaUpdate, commitUnderLock, startedAtMs);
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
