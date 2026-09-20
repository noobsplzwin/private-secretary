// CLI bridge: exposes the tested relay/core to the Claude skill so deterministic
// decisions use the SAME code the unit tests cover — not re-implemented in a
// prompt. JSON in (stdin), JSON out (stdout). Exit 0 = ok, 2 = bad usage/input.
//
//   npx tsx relay/cli.ts personas
//   echo '<InboundMessage>'              | ... filter
//   echo '{senderHandle,candidates:[]}'  | ... resolve
//   ... gate <state.json>
//   echo '[{source,id,timestampMs}]'     | ... cursor-check <state.json>
//   echo '{actions,processed,sourceErrors,shadow}' | ... round-commit <state.json>
//   ... queue <state.json>
//   ... transition <state.json> <actionId> <approve|skip|executed>
//   echo '<DraftOutcome>'                | ... outcome <state.json>
//   ... shadow-summary <state.json>       (Phase 3 B: shadow-log inspection)
//   echo '<ActionItem|ActionItem[]>'     | ... validate
//
// Persona v3 (specs/persona-v3.md) — every write goes through the
// persona-store chokepoint (R1: manual fields never overwritten by llm):
//   echo '{set,evidence}|{full}'         | ... persona-write <file> <llm|human>
//   ... persona-promote <key|--all-staged>
//   ... persona-merge <primaryKey> <secondaryKey>
//   echo '{scene,wrong,correct}'         | ... persona-correct <key>  (§7B human-only)
//   ... persona-migrate <key>            (v2 live -> v3 scaffold in _staged/)
//   echo '{contacts,now_month,top?}'     | ... bootstrap-rank
//   echo '{params,entries,force_keys?}'  | ... bootstrap-progress <file> init
//   ... bootstrap-progress <file> <list|next>
//   ... bootstrap-progress <file> mark <key> <staged|promoted|failed> [error]
//
// WeChat read bridge — driven by the wechat-decrypt MCP server (see
// specs/wechat-decrypt-migration.md). Output is formatted Chinese text the
// caller passes to the LLM verbatim. Requires WeChat.app running + the
// keys/decrypt setup from specs/wechat-local-decrypt.md.
//   ... wechat-contacts [query]
//   ... wechat-sessions [--limit N]
//   ... wechat-history <chat> [--wxid <id>] [--years N] [--start-time D] [--end-time D] [--limit N] [--offset N] [--oldest-first] [--msg-types t1,t2]
//   ... wechat-search <keyword> [--chat name] [--start-time D] [--end-time D] [--limit N]
//   ... wechat-new-messages
//   ... wechat-unread
//   ... wechat-decode-image <chat> <local_id>
//   ... wechat-decode-file <chat> <local_id> [<create_time>]

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildReverseIndex,
  resolveRecipient,
  resolveSender,
} from "./core/recipient-resolver.js";
import { evaluateTrigger } from "./core/trigger-filter.js";
import { computeGate, type DraftOutcome } from "./core/metrics.js";
import { advance, isNew } from "./core/dedup.js";
import {
  approveAction,
  markExecuted,
  markExecuting,
  missingInfo,
  rejectAction,
  restoreAction,
  requiresManualExecution,
  validateActionItem,
  withReceipt,
  type ActionItem,
  type ExecutionReceipt,
} from "./core/action-item.js";
import {
  applyTaskRewrites,
  dedupTaskMints,
  groupByTask,
  type TaskRegistry,
} from "./core/tasks.js";
import type { InboundMessage } from "./core/types.js";
import { getSource, SOURCES, type SourceContext } from "./sources/index.js";
import { loadDirectBook, saveDirectBook } from "./io/wechat-direct-store.js";
import { loadPersonas } from "./io/personas.js";
import { acquireLock, loadState, releaseLock, saveState } from "./io/state.js";
import { migrateMechanical, mergeContacts, isV3 } from "./core/persona-v3.js";
import {
  initProgress,
  markContact,
  nextPending,
  progressSummary,
  rankContacts,
  DEFAULT_TOP_N,
  type ContactActivity,
  type ContactStatus,
  type ProgressEntry,
} from "./core/bootstrap.js";
import {
  listStaged,
  personaPath,
  promoteStaged,
  readPersonaV3File,
  stagedPath,
  retireMergedSecondary,
  writePersonaFile,
  type PersonaWriteRequest,
  type WriteActor,
} from "./io/persona-store.js";
import { loadProgress, saveProgress } from "./io/bootstrap-progress.js";
import {
  appendShadowRecord,
  summarizeShadowLog,
} from "./io/shadow-log.js";
import {
  buildShadowRecord,
  shouldWriteShadowRecord,
  type ShadowRecordInput,
} from "./core/shadow.js";
import {
  wechatContacts,
  wechatDecodeFile,
  wechatDecodeImage,
  wechatHistory,
  wechatNewMessages,
  wechatRaw,
  wechatSearch,
  wechatSessions,
  wechatUnread,
  type WechatHistoryOptions,
  type WechatSearchOptions,
} from "./io/wechat-cli.js";
import { parseOfficialAccountNames, scanWechatInbox } from "./sources/wechat-direct.js";
import { existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";

const PERSONA_DIR = join(process.cwd(), "personas");

function readStdin(): string {
  try {
    // strip a UTF-8 BOM — Windows tools love to prepend one to piped JSON
    const s = readFileSync(0, "utf8");
    return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
  } catch {
    return "";
  }
}

function out(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function fail(message: string): never {
  process.stderr.write(`relay-cli error: ${message}\n`);
  process.exit(2);
}

// Emit pass-through text from a wechat command, then EXIT. The wechat-decrypt
// MCP server is a spawned child whose stdio keeps the node event loop alive, so
// these commands never exit on their own — they hang idle until killed (looked
// like a "timeout" to callers even though the data already returned). Exit in
// the write-flush callback so the child is torn down (process "exit" handler in
// wechat-cli closes it) and the data is fully flushed first.
function emit(s: string): void {
  process.stdout.write(s.endsWith("\n") ? s : s + "\n", () => process.exit(0));
}

interface ProcessedRef {
  source: string;
  id: string;
  timestampMs: number;
}

// Validates raw LLM-produced items; fills id/created_at. All-or-nothing: one bad
// item rejects the whole batch so junk never partially enters the queue.
function validateBatch(raw: unknown): { items: ActionItem[]; errors: string[] } {
  const list = Array.isArray(raw) ? raw : [raw];
  const items: ActionItem[] = [];
  const errors: string[] = [];
  const now = new Date().toISOString();
  list.forEach((entry, i) => {
    const result = validateActionItem(entry);
    if (result.ok) {
      items.push({
        ...result.item,
        id: result.item.id || randomUUID(),
        created_at: result.item.created_at || now,
      });
    } else {
      errors.push(`item[${i}]: ${result.errors.join("; ")}`);
    }
  });
  return { items, errors };
}

function withLockedState(
  statePath: string,
  fn: (state: ReturnType<typeof loadState>) => void,
): void {
  const stateDir = dirname(statePath);
  if (!acquireLock(stateDir))
    fail(`lock held at ${join(stateDir, ".lock")} — another pass is running`);
  try {
    const state = loadState(statePath);
    fn(state);
    saveState(statePath, state);
  } finally {
    releaseLock(stateDir);
  }
}

const [cmd, arg1, arg2, arg3, arg4, arg5] = process.argv.slice(2);

try {
  if (cmd === "personas") {
    const personas = loadPersonas(PERSONA_DIR);
    out({ count: personas.length, personas });
  } else if (cmd === "normalize") {
    // stdin: {ctx, raw}. Turns a platform's raw payload into InboundMessage[] via the
    // tested source normalizer, ready to feed cursor-check -> filter -> round-commit.
    if (!arg1) fail("usage: normalize <sourceKey>  (stdin: {ctx, raw})");
    const source = getSource(arg1);
    if (!source)
      fail(`unknown source: ${arg1}. Known: ${Object.keys(SOURCES).join(", ")}`);
    const { ctx, raw } = JSON.parse(readStdin()) as { ctx?: SourceContext; raw: unknown };
    out({ messages: source.normalize(raw, ctx ?? {}) });
  } else if (cmd === "wechat-scan") {
    // WeChat's normalize equivalent: fetch + parse are coupled (the source owns
    // its reads), so it can't ride the generic `normalize <key>` path. Mirrors
    // the daemon's detection exactly: get_recent_sessions + a per-chat CURSOR
    // (arg1 = state path, so the book is shared with the daemon) +
    // get_chat_history (incoming, direction-marked, full context). Emits
    // {messages} ready for cursor-check -> filter -> round-commit. cursor-check
    // against loop-state marks dedups; groups + family are dropped in the source.
    void (async () => {
      const officialNames = parseOfficialAccountNames(
        await wechatRaw("get_contacts", { query: "", limit: 1000 }),
      );
      // Same book the daemon keeps, so a manual scan does not re-surface what
      // the daemon already consumed — and advances it for the same reason.
      const statePath = arg1 ?? "state/loop-state.json";
      const { inbound, book } = await scanWechatInbox({
        fetchSessions: () => wechatSessions({ limit: 30 }),
        fetchHistory: (name, limit) => wechatHistory(name, { limit }),
        officialNames,
        nowMs: Date.now(),
        book: loadDirectBook(statePath),
      });
      saveDirectBook(statePath, book);
      out({ messages: inbound });
    })().catch((err: Error) => fail(err.message));
  } else if (cmd === "filter") {
    const m = JSON.parse(readStdin()) as InboundMessage;
    out(evaluateTrigger(m));
  } else if (cmd === "resolve") {
    const { senderHandle, candidates } = JSON.parse(readStdin()) as {
      senderHandle: string;
      candidates: string[];
    };
    const index = buildReverseIndex(loadPersonas(PERSONA_DIR));
    out({
      sender: resolveSender(senderHandle, index),
      recipient: resolveRecipient(candidates ?? [], index),
    });
  } else if (cmd === "gate") {
    if (!arg1) fail("gate requires a state file path");
    out(computeGate(loadState(arg1).outcomes));
  } else if (cmd === "cursor-check") {
    if (!arg1) fail("cursor-check requires a state file path");
    const refs = JSON.parse(readStdin()) as ProcessedRef[];
    const { marks } = loadState(arg1);
    const fresh: ProcessedRef[] = [];
    const seen: ProcessedRef[] = [];
    for (const r of refs)
      (isNew(r.source, r.id, r.timestampMs, marks) ? fresh : seen).push(r);
    out({ new: fresh, seen });
  } else if (cmd === "round-commit") {
    if (!arg1) fail("round-commit requires a state file path");
    const payload = JSON.parse(readStdin()) as {
      actions?: unknown[];
      processed?: ProcessedRef[];
      sourceErrors?: Record<string, string>;
      tasks?: TaskRegistry; // T1: new/updated {task_id: {title, created_at}} entries
      shadow?: ShadowRecordInput; // B: shadow-mode validation record for this round
    };
    const { items, errors } = validateBatch(payload.actions ?? []);
    if (errors.length) fail(`invalid actions, nothing committed:\n${errors.join("\n")}`);
    const processed = payload.processed ?? [];
    const now = new Date().toISOString();
    withLockedState(arg1, (state) => {
      // A2: stable task_id dedup. If the skill minted a NEW task_id for a task
      // that already exists (same normalized title), drop the duplicate and
      // retarget any action that referenced it. Same task → same id, across
      // rounds and across people.
      const { additions, rewrites } = dedupTaskMints(
        state.tasks,
        payload.tasks ?? {},
      );
      const committed = applyTaskRewrites(items, rewrites);

      state.actions.push(...committed);
      // T1: merge task registry entries. Existing entries are preserved (a task's
      // title/created_at are stable); only genuinely new task_ids are added.
      for (const [tid, meta] of Object.entries(additions))
        if (!state.tasks[tid]) state.tasks[tid] = meta;
      let marks = state.marks;
      const okSources = new Set<string>();
      for (const r of processed) {
        marks = advance(r.source, r.id, r.timestampMs, marks);
        okSources.add(r.source);
      }
      state.marks = marks;
      for (const source of okSources) delete state.sourceErrors[source];
      for (const [source, message] of Object.entries(payload.sourceErrors ?? {}))
        state.sourceErrors[source] = { message, at: now };
      // B: write a shadow-mode record alongside the state file. The current
      // runtime's records become the replay corpus the new runtime (T-conn)
      // validates against. shouldWriteShadowRecord skips no-op rounds so the
      // log stays signal-only.
      let shadowWritten = false;
      const shadowInput = payload.shadow ?? {};
      if (shouldWriteShadowRecord(committed, shadowInput)) {
        const rec = buildShadowRecord(now, committed, shadowInput);
        appendShadowRecord(join(dirname(arg1), "shadow-log.jsonl"), rec);
        shadowWritten = true;
      }

      out({
        queued: committed.map((i) => ({
          id: i.id,
          action_type: i.action_type,
          task_id: i.task_id ?? null,
          missing_info: missingInfo(i),
        })),
        tasksAdded: Object.keys(additions).length,
        tasksDeduped: rewrites,
        cursorAdvanced: processed.length,
        sourceErrors: payload.sourceErrors ?? {},
        shadowWritten,
      });
    });
  } else if (cmd === "queue") {
    if (!arg1) fail("queue requires a state file path");
    const { actions, tasks } = loadState(arg1);
    const suggested = actions.filter((a) => a.status === "suggested");
    // T3 flush queue: approved items that auto-send (Slack/calendar/task/ignore)
    // sit at "approved" in the triage-only-cockpit model until a /relay pass
    // flushes them. The old queue command hid these — the cockpit and the flush
    // pass both need to see what is queued to send.
    const pendingExecution = actions.filter(
      (a) => a.status === "approved" && !requiresManualExecution(a),
    );
    const awaitingManual = actions.filter(
      (a) => a.status === "approved" && requiresManualExecution(a),
    );
    out({
      suggested: suggested.map((a) => ({ ...a, missing_info: missingInfo(a) })),
      pendingExecution, // queued to send on the next /relay flush
      awaitingManual, // approved WeChat/Gmail sends waiting for manual paste/send
      // Grouped view the cockpit Queue renders directly (suggested + both
      // approved buckets), ordered per design 5A.
      clusters: groupByTask([...suggested, ...pendingExecution, ...awaitingManual], tasks),
    });
  } else if (cmd === "transition") {
    if (!arg1 || !arg2 || !arg3)
      fail(
        "usage: transition <state.json> <actionId> <approve|skip|executing|executed|restore> [receiptJson]",
      );
    // Inside the locked callback we THROW instead of fail(): process.exit skips
    // finally blocks and would leak the lockfile. The outer catch reports it.
    const receiptArg = process.argv[6];
    withLockedState(arg1, (state) => {
      const idx = state.actions.findIndex((a) => a.id === arg2);
      if (idx === -1) throw new Error(`action not found: ${arg2}`);
      let current = state.actions[idx]!;
      // Attach the execution receipt (if provided) before the terminal move, so
      // a crash after the API call but before this leaves a replay-safe record.
      if (receiptArg && arg3 === "executed") {
        current = withReceipt(current, JSON.parse(receiptArg) as ExecutionReceipt);
      }
      let next: ActionItem;
      if (arg3 === "approve") next = approveAction(current);
      else if (arg3 === "skip") next = rejectAction(current);
      else if (arg3 === "executing") next = markExecuting(current, new Date().toISOString()); // T4: claim before MCP
      else if (arg3 === "executed") next = markExecuted(current);
      else if (arg3 === "restore") next = restoreAction(current); // T6 undo
      else throw new Error(`unknown transition: ${arg3}`);
      state.actions[idx] = next;
      out(next);
    });
  } else if (cmd === "outcome") {
    if (!arg1) fail("outcome requires a state file path");
    const outcome = JSON.parse(readStdin()) as DraftOutcome;
    withLockedState(arg1, (state) => {
      state.outcomes.push(outcome);
      out({ recorded: outcome.relayId, total: state.outcomes.length });
    });
  } else if (cmd === "shadow-summary") {
    // B: inspect the shadow-mode dataset alongside a state file. Used by humans
    // (sanity check what's been captured) and later by T-gate (compute gate
    // metrics on shadow data). Default path mirrors round-commit's writer.
    if (!arg1) fail("shadow-summary requires a state file path");
    out(summarizeShadowLog(join(dirname(arg1), "shadow-log.jsonl")));
  } else if (cmd === "validate") {
    const { items, errors } = validateBatch(JSON.parse(readStdin()));
    if (errors.length) fail(errors.join("\n"));
    out({
      ok: true,
      items: items.map((i) => ({ ...i, missing_info: missingInfo(i) })),
    });
  } else if (cmd === "persona-write") {
    // The ONLY sanctioned write path for persona YAMLs. actor=llm goes through
    // the R1 guard (manual fields blocked, evidence required per field).
    if (!arg1 || (arg2 !== "llm" && arg2 !== "human"))
      fail("usage: persona-write <file> <llm|human>  (stdin: {set,evidence} or {full})");
    const request = JSON.parse(readStdin()) as PersonaWriteRequest;
    out(writePersonaFile(arg1, request, arg2 as WriteActor));
  } else if (cmd === "persona-promote") {
    if (!arg1) fail("usage: persona-promote <key|--all-staged>");
    const keys = arg1 === "--all-staged" ? listStaged(PERSONA_DIR) : [arg1];
    if (keys.length === 0) fail("nothing staged");
    out({ promoted: keys.map((k) => promoteStaged(PERSONA_DIR, k)) });
  } else if (cmd === "persona-merge") {
    // R3: runs only AFTER the user approves the merge-suggestion card.
    if (!arg1 || !arg2) fail("usage: persona-merge <primaryKey> <secondaryKey>");
    const primary = readPersonaV3File(personaPath(PERSONA_DIR, arg1));
    const secondary = readPersonaV3File(personaPath(PERSONA_DIR, arg2));
    const { merged, adopted, conflicts } = mergeContacts(primary, secondary);
    writePersonaFile(personaPath(PERSONA_DIR, arg1), { full: merged }, "human");
    const backup = retireMergedSecondary(PERSONA_DIR, arg2);
    out({ merged: arg1, retired: arg2, backup, adopted, conflicts });
  } else if (cmd === "persona-correct") {
    // v3.1 §7B: record a human-stated behavioral correction. Human write path
    // (R1-manual); the LLM can never touch corrections. Appends to the ledger.
    if (!arg1) fail("usage: persona-correct <key>  (stdin: {scene, wrong, correct})");
    const file = personaPath(PERSONA_DIR, arg1);
    if (!existsSync(file)) fail(`no persona file for key: ${arg1}`);
    const entry = JSON.parse(readStdin()) as {
      scene?: string;
      wrong?: string;
      correct?: string;
    };
    if (!entry.scene || !entry.wrong || !entry.correct)
      fail("stdin must be {scene, wrong, correct}");
    const persona = readPersonaV3File(file);
    const corrections = [
      ...(persona.corrections ?? []),
      { scene: entry.scene, wrong: entry.wrong, correct: entry.correct, at: new Date().toISOString() },
    ];
    out(
      writePersonaFile(
        file,
        { set: { corrections }, provenance: { corrections: "manual" } },
        "human",
      ),
    );
  } else if (cmd === "persona-migrate") {
    // Mechanical v2 -> v3 scaffold into _staged/ (spec §3). Judgment-derived
    // fields are layered on the staged file afterwards; promote replaces live.
    if (!arg1) fail("usage: persona-migrate <key>");
    const live = personaPath(PERSONA_DIR, arg1);
    if (!existsSync(live)) fail(`no persona file for key: ${arg1}`);
    const raw = parseYaml(readFileSync(live, "utf8")) as Record<string, unknown>;
    if (isV3(raw)) fail(`${arg1} is already v3 — nothing to migrate`);
    const scaffold = migrateMechanical(raw);
    const staged = stagedPath(PERSONA_DIR, arg1);
    writePersonaFile(staged, { full: scaffold }, "human");
    out({ staged, scaffold });
  } else if (cmd === "bootstrap-rank") {
    const { contacts, now_month, top } = JSON.parse(readStdin()) as {
      contacts: ContactActivity[];
      now_month: string;
      top?: number;
    };
    if (!Array.isArray(contacts) || !now_month)
      fail("stdin must be {contacts: ContactActivity[], now_month: 'YYYY-MM', top?}");
    const ranked = rankContacts(contacts, now_month);
    out({ ranked, top: ranked.slice(0, top ?? DEFAULT_TOP_N) });
  } else if (cmd === "bootstrap-progress") {
    if (!arg1 || !arg2)
      fail("usage: bootstrap-progress <file> <init|list|next|mark> ...");
    const now = new Date().toISOString();
    if (arg2 === "init") {
      const { params, entries, force_keys } = JSON.parse(readStdin()) as {
        params: { contacts: string; history_years: number };
        entries: ProgressEntry[];
        force_keys?: string[];
      };
      const progress = initProgress(loadProgress(arg1), params, entries, now, force_keys);
      saveProgress(arg1, progress);
      out({ summary: progressSummary(progress), contacts: progress.contacts });
    } else if (arg2 === "list") {
      const progress = loadProgress(arg1);
      if (!progress) fail(`no progress file at ${arg1}`);
      out({ summary: progressSummary(progress), ...progress });
    } else if (arg2 === "next") {
      const progress = loadProgress(arg1);
      if (!progress) fail(`no progress file at ${arg1}`);
      out({ next: nextPending(progress) });
    } else if (arg2 === "mark") {
      if (!arg3 || !arg4) fail("usage: bootstrap-progress <file> mark <key> <status> [error]");
      if (!["pending", "staged", "promoted", "failed"].includes(arg4))
        fail(`status must be pending|staged|promoted|failed, got "${arg4}"`);
      const progress = loadProgress(arg1);
      if (!progress) fail(`no progress file at ${arg1}`);
      const updated = markContact(progress, arg3, arg4 as ContactStatus, now, arg5);
      saveProgress(arg1, updated);
      out({ key: arg3, status: arg4, summary: progressSummary(updated) });
    } else {
      fail(`unknown bootstrap-progress subcommand: ${arg2}`);
    }
  } else if (cmd === "wechat-contacts") {
    // Pass-through text from the wechat-cli binary. Caller (persona-bootstrap
    // skill) reads the raw output — see cli.ts header for the rationale.
    wechatContacts(arg1).then(
      (s) => emit(s),
      (err: Error) => fail(err.message),
    );
  } else if (cmd === "wechat-history") {
    if (!arg1)
      fail(
        "usage: wechat-history <chat> [--wxid <id>] [--years N] [--start-time D] [--end-time D] [--limit N] [--offset N] [--oldest-first] [--msg-types t1,t2]",
      );
    const opts: WechatHistoryOptions = {};
    const flags = process.argv.slice(4);
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i]!;
      const v = flags[i + 1];
      if (f === "--wxid" && v != null) {
        opts.wxid = v;
        i++;
      } else if (f === "--years" && v != null) {
        const yrs = Number(v);
        if (!Number.isFinite(yrs)) fail(`--years: not a number: ${v}`);
        const d = new Date();
        d.setUTCFullYear(d.getUTCFullYear() - yrs);
        opts.start = d.toISOString().slice(0, 10);
        i++;
      } else if (f === "--start-time" && v != null) {
        opts.start = v;
        i++;
      } else if (f === "--end-time" && v != null) {
        opts.end = v;
        i++;
      } else if (f === "--limit" && v != null) {
        const n = Number(v);
        if (!Number.isFinite(n)) fail(`--limit: not a number: ${v}`);
        opts.limit = n;
        i++;
      } else if (f === "--offset" && v != null) {
        const n = Number(v);
        if (!Number.isFinite(n)) fail(`--offset: not a number: ${v}`);
        opts.offset = n;
        i++;
      } else if (f === "--oldest-first") {
        opts.oldestFirst = true;
      } else if (f === "--msg-types" && v != null) {
        opts.msgTypes = v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
        i++;
      } else {
        fail(`unknown flag: ${f}`);
      }
    }
    wechatHistory(arg1, opts).then(
      (s) => emit(s),
      (err: Error) => fail(err.message),
    );
  } else if (cmd === "wechat-sessions") {
    const limit = arg1 === "--limit" && arg2 != null ? Number(arg2) : undefined;
    wechatSessions(limit != null ? { limit } : {}).then(
      (s) => emit(s),
      (err: Error) => fail(err.message),
    );
  } else if (cmd === "wechat-search") {
    if (!arg1) fail("usage: wechat-search <keyword> [--chat name] [--start-time D] [--end-time D] [--limit N]");
    const opts: WechatSearchOptions = {};
    const flags = process.argv.slice(4);
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i]!;
      const v = flags[i + 1];
      if (f === "--chat" && v != null) {
        opts.chatName = v;
        i++;
      } else if (f === "--start-time" && v != null) {
        opts.start = v;
        i++;
      } else if (f === "--end-time" && v != null) {
        opts.end = v;
        i++;
      } else if (f === "--limit" && v != null) {
        const n = Number(v);
        if (!Number.isFinite(n)) fail(`--limit: not a number: ${v}`);
        opts.limit = n;
        i++;
      } else {
        fail(`unknown flag: ${f}`);
      }
    }
    wechatSearch(arg1, opts).then(
      (s) => emit(s),
      (err: Error) => fail(err.message),
    );
  } else if (cmd === "wechat-new-messages") {
    wechatNewMessages().then(
      (s) => emit(s),
      (err: Error) => fail(err.message),
    );
  } else if (cmd === "wechat-unread") {
    wechatUnread().then(
      (s) => emit(s),
      (err: Error) => fail(err.message),
    );
  } else if (cmd === "wechat-decode-image") {
    if (!arg1 || !arg2)
      fail("usage: wechat-decode-image <chat> <local_id>");
    const lid = Number(arg2);
    if (!Number.isFinite(lid)) fail(`local_id: not a number: ${arg2}`);
    wechatDecodeImage(arg1, lid).then(
      (s) => emit(s),
      (err: Error) => fail(err.message),
    );
  } else if (cmd === "wechat-decode-file") {
    if (!arg1 || !arg2)
      fail("usage: wechat-decode-file <chat> <local_id> [<create_time>]");
    const lid = Number(arg2);
    if (!Number.isFinite(lid)) fail(`local_id: not a number: ${arg2}`);
    const ct = arg3 != null ? Number(arg3) : 0;
    if (!Number.isFinite(ct)) fail(`create_time: not a number: ${arg3}`);
    wechatDecodeFile(arg1, lid, ct).then(
      (s) => emit(s),
      (err: Error) => fail(err.message),
    );
  } else {
    fail(`unknown command: ${cmd ?? "(none)"} — see relay/cli.ts header`);
  }
} catch (err) {
  fail((err as Error).message);
}
