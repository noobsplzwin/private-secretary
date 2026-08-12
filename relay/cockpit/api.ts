// Cockpit API core — the triage operations behind the HTTP endpoints,
// kept free of socket + Keychain concerns so they unit-test without
// network. The server (relay/cockpit/server.ts) wires these to routes
// and supplies the real executor; tests pass a stub executor.
//
// Every mutation goes through relay/io/state's lock + atomic write —
// NEVER raw JSON. Transitions go through relay/core. This is the
// "cockpit writes through core + the existing lock" rule (phase2 eng
// review decision 3).
//
// The cockpit drives the deterministic executor on approve (Phase 3:
// the model never holds send authority). Approve = approveAction
// (validates missing-info) → executeAction (the real side effect) →
// persist the executed/awaiting result. A calendar conflict un-does
// the approval back to suggested so the user can re-time + re-approve.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  approveAction,
  hasReceipt,
  markDone,
  markExecuted,
  missingInfo,
  rejectAction,
  requiresManualExecution,
  restoreAction,
  withReceipt,
  type ActionItem,
  type ExecutionReceipt,
} from "../core/action-item.js";
import { groupByTask, type TaskCluster } from "../core/tasks.js";
import { resolvePlanKey, unitKey } from "../core/unit-key.js";
import { computeGate, type GateResult } from "../core/metrics.js";
import { canAutoExecute } from "../core/executors.js";
import { provenanceFor, evidenceFor } from "../core/persona-v3.js";
import { loadRawPersonas } from "../io/personas.js";
import { loadProjects } from "../io/projects.js";
import type { Project } from "../core/project.js";
import {
  acquireLock,
  loadState,
  releaseLock,
  saveState,
  type LoopState,
  type SourceError,
} from "../io/state.js";
import {
  appendLabel,
  buildLabel,
  labelsPathFor,
  type EditDiffEntry,
  type ExistenceVerdict,
  type FieldError,
  type LabelDecision,
} from "../io/labels.js";
import {
  appendActivity,
  activityPathFor,
  readActivity,
  ACTIVITY_KINDS,
  type ActivityKind,
  type ActivityRecord,
} from "../io/activity-log.js";
import {
  LLM_MODES,
  loadSettings,
  machineTimeZone,
  saveSettings,
  type LlmMode,
} from "../io/settings.js";
import { isValidTimeZone } from "../core/when.js";
import {
  effectiveToolSpecs,
  loadToolsConfig,
  saveToolsConfig,
  type ToolsConfig,
} from "../io/tools.js";
import { DEFAULT_TOOL_SPECS, type ToolSpec } from "../core/tool-registry.js";
import { authorizeMcpTool, mcpAuthServiceFor } from "../io/mcp-tool.js";
import {
  ANTHROPIC_KEY_ACCOUNT,
  ANTHROPIC_KEY_SERVICE,
  resolveAnthropicKey,
} from "../io/anthropic-api.js";
import {
  DEEPSEEK_KEY_ACCOUNT,
  DEEPSEEK_KEY_SERVICE,
  resolveDeepseekKey,
} from "../io/deepseek-api.js";
import { deleteSecret, hasSecret, KeychainEntryMissing, setSecret } from "../io/keychain.js";
import { loadIdentity } from "../io/identity.js";
import {
  GOOGLE_CLIENT_ACCOUNT,
  GOOGLE_CLIENT_SERVICE,
  TOKEN_KEYCHAIN_SERVICE,
} from "../io/google-oauth.js";
import type { ExecuteResult } from "../proc/execute.js";
import {
  checkCalendarConflicts as coreCheckCalendarConflicts,
  resolveCalendarMailbox,
  toRfc3339,
} from "../proc/execute.js";
import type { Conflict } from "../core/calendar-conflict.js";
import type { JsonLlmCaller } from "../proc/llm-claude-cli.js";
import { createClaudeCliJsonCaller } from "../proc/llm-claude-cli.js";
import { createAnthropicJsonCaller } from "../proc/llm-anthropic.js";
import { createDeepseekJsonCaller } from "../proc/llm-deepseek.js";
import { CalendarClient, type CalendarEvent } from "../io/calendar-api.js";

// The executor the cockpit calls on approve. The server injects the real
// one (Keychain-wired Slack/Gmail/Calendar); tests inject a stub. It is
// handed a `persistClaim` so the durable "executing" marker is written
// BEFORE the side effect (crash-safe).
export type CockpitExecutor = (
  action: ActionItem,
  persistClaim: (claimed: ActionItem) => Promise<void>,
) => Promise<ExecuteResult>;

// The slice of CalendarClient the Calendar screen's read feed needs —
// structural, so the real client satisfies it and tests stub it.
export type CalendarEventsLister = (opts: {
  timeMin: string;
  timeMax: string;
}) => Promise<CalendarEvent[]>;

export interface CockpitApiOptions {
  statePath: string;
  personaDir: string;
  // Project RAG dir (the same projects/_staged the daemon drafts against). Used
  // to resolve a card's project_id → name and to render the Projects screen.
  projectsDir?: string;
  executor: CockpitExecutor;
  now?: () => string;
  // Calendar screen: builds the events lister for a mailbox. Default wires the
  // real Keychain-backed CalendarClient; tests inject a stub so no OAuth or
  // network is touched.
  calendarLister?: (email: string) => CalendarEventsLister;
  // AI re-time: the LLM that rewrites a calendar card's start/end from a
  // natural-language instruction (e.g. "move to 8/7 15:00-16:00", "extend by 30 min").
  // Defaults to the daemon's LLM (settings.llm.mode); tests inject a stub.
  jsonLlm?: JsonLlmCaller;
}

// ─── read model ──────────────────────────────────────────────────────

// One Google Calendar event as the Calendar screen renders it (see
// getCalendarEvents). start/end are RFC 3339 for timed events, YYYY-MM-DD
// for all-day ones (allDay distinguishes).
export interface CockpitCalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  attendees: string[]; // displayName, else email
  htmlLink?: string;
}

export interface CockpitState {
  // Task-grouped clusters of suggested + in-flight items (oldest-first,
  // ready-first within a group) — the Queue master list.
  clusters: TaskCluster[];
  // Flat slices for badge counts + the awaiting-manual / drawer sections.
  suggested: Array<ActionItem & { missing_info: string[] }>;
  awaitingManual: ActionItem[];
  done: ActionItem[]; // executed (auto-handled drawer + history)
  skipped: ActionItem[]; // rejected (drawer "Skipped")
  sourceErrors: Record<string, SourceError>;
  gate: GateResult;
  counts: {
    pending: number; // suggested
    tasks: number; // distinct task clusters with a pending member
    awaitingManual: number;
  };
  // The effective MCP tool registry (built-ins + user config) — the Queue's
  // "via" picker lists these.
  tools: Record<string, { label: string }>;
}

export class CockpitApi {
  private readonly now: () => string;
  constructor(private readonly opts: CockpitApiOptions) {
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  // Snapshot for the UI. Read-only — no lock needed (atomic writes mean a
  // concurrent reader sees old-or-new bytes, never a torn file).
  // Build a handle/key → display-name resolver from the personas so the
  // cockpit never shows a raw Slack ID / wxid. Indexes every handle, the
  // persona key, and the display name itself (WeChat sender_handle IS the
  // display name). Returns undefined for unknown handles (caller falls back).
  private buildNameResolver(): (x: string | null | undefined) => string | undefined {
    const raw = loadRawPersonas(this.opts.personaDir);
    const byName = new Map<string, string>();
    for (const p of raw) {
      const display = (typeof p.display_name === "string" && p.display_name) || String(p.key ?? "");
      if (!display) continue;
      if (p.key) byName.set(String(p.key).toLowerCase(), display);
      const handles = (p.handles as Record<string, string> | undefined) ?? {};
      for (const h of Object.values(handles)) if (h) byName.set(String(h).toLowerCase(), display);
      byName.set(display.toLowerCase(), display);
    }
    return (x) => (x ? byName.get(String(x).toLowerCase()) : undefined);
  }

  private projectsDir(): string {
    // state/ and projects/ are siblings; fall back to ../projects/_staged when
    // the option isn't set (tests get an empty dir → loadProjects returns []).
    return this.opts.projectsDir ?? join(dirname(dirname(this.opts.statePath)), "projects", "_staged");
  }

  // project_id → display name (name, else id). undefined for MISC / unknown.
  private buildProjectResolver(): (id: string | null | undefined) => string | undefined {
    const byId = new Map<string, string>();
    for (const p of loadProjects(this.projectsDir())) {
      byId.set(p.id, p.name || p.id);
    }
    return (id) => (id && id !== "MISC" ? byId.get(id) : undefined);
  }

  getState(): CockpitState {
    const state = loadState(this.opts.statePath);
    const tools = effectiveToolSpecs(this.opts.statePath);
    const resolveName = this.buildNameResolver();
    const resolveProject = this.buildProjectResolver();
    // Attach resolved display names (sender + recipient) + project name so the UI
    // shows people + the project a card advances, not raw ids.
    const named = <T extends ActionItem>(a: T): T & { sender_name?: string; recipient_name?: string; project_name?: string } => ({
      ...a,
      sender_name: resolveName(a.context?.sender_handle) ?? a.context?.sender_name ?? a.context?.sender_handle,
      recipient_name:
        resolveName(a.target?.personaKey) ?? a.target?.personaKey ?? a.target?.platform ?? undefined,
      project_name: resolveProject(a.project_id),
    });
    const suggested = state.actions
      .filter((a) => a.status === "suggested")
      .map((a) => named({ ...a, missing_info: missingInfo(a, tools) }));
    const awaitingManual = state.actions.filter(
      (a) => a.status === "approved" && requiresManualExecution(a),
    );
    // Executed actions accumulate forever; the drawer's completed view only
    // needs the recent tail, so cap the payload (it ships on every 15s poll).
    // Kept chronological (oldest→newest); the frontend reverses for display.
    const DONE_LIMIT = 200;
    const done = state.actions.filter((a) => a.status === "executed").slice(-DONE_LIMIT);
    const skipped = state.actions.filter((a) => a.status === "rejected");

    // Clusters cover the live queue (suggested + approved-not-yet-done).
    // Carry missing_info onto each live action so the UI can disable approve
    // + show the needs-info banner from the cluster rows + detail pane (the
    // flat `suggested` array isn't what the Queue master list renders from).
    const live = state.actions
      .filter((a) => a.status === "suggested" || a.status === "approved")
      .map((a) => named({ ...a, missing_info: missingInfo(a, tools) }));
    const clustersRaw = groupByTask(live, state.tasks);
    // Attach the daily-plan (tier / rank / why / entities) to each cluster and
    // order the Today list A→D then by rank. Unplanned clusters sink to the end.
    const plans = state.plans ?? {};
    const overrides = state.planOverrides ?? {};
    const TIER_ORDER: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };
    const clusters = clustersRaw
      .map((c) => {
        // Two distinct identities. The `unit_key` handed to the frontend is
        // the select/re-tier target and must be UNIQUE per cluster: task_id,
        // else `__ungrouped_<actionId>`. A conversation-derived shared key
        // would make several same-sender ungrouped cards select (highlight)
        // together. Plans and tier overrides attach to the STABLE
        // conversation key instead (`unitKey` — core/unit-key.ts) so a
        // supersede keeps them.
        const identityKey = c.task_id ?? (c.actions[0] ? `__ungrouped_${c.actions[0].id}` : undefined);
        const planKey = c.task_id ?? (c.actions[0] ? unitKey(c.actions[0]) : undefined);
        const plan = planKey ? plans[planKey] : undefined;
        const ov = planKey ? overrides[planKey] : undefined;
        // A manual drag wins over the computed tier; keep the AI rank/why/entities.
        const effPlan = ov
          ? { ...(plan ?? { rank: 999, why: "" }), tier: ov, tierManual: true }
          : plan;
        return { ...c, unit_key: identityKey, plan: effPlan };
      })
      .sort((a, b) => {
        const ta = a.plan ? TIER_ORDER[a.plan.tier] ?? 8 : 9;
        const tb = b.plan ? TIER_ORDER[b.plan.tier] ?? 8 : 9;
        if (ta !== tb) return ta - tb;
        return (a.plan?.rank ?? 999) - (b.plan?.rank ?? 999);
      });
    const pendingTaskIds = new Set(
      suggested.map((a) => unitKey(a)),
    );

    return {
      clusters,
      suggested,
      awaitingManual,
      done,
      skipped,
      sourceErrors: state.sourceErrors,
      gate: computeGate(state.outcomes),
      counts: {
        pending: suggested.length,
        tasks: pendingTaskIds.size,
        awaitingManual: awaitingManual.length,
      },
      tools,
    };
  }

  // Projects screen (Microsoft To-Do style): every tracked project + the live
  // cards mapped to it (project_id), plus a MISC bucket for cards tied to no
  // project. Each card is a compact row (the detail still comes from /api/state).
  getProjects(): { projects: Array<Record<string, unknown>>; misc: Array<Record<string, unknown>> } {
    const projects = loadProjects(this.projectsDir());
    const resolveName = this.buildNameResolver();
    const tools = effectiveToolSpecs(this.opts.statePath);
    const live = loadState(this.opts.statePath).actions
      .filter((a) => a.status === "suggested" || a.status === "approved")
      .map((a) => ({ ...a, missing_info: missingInfo(a, tools) }));
    const cardLite = (a: ActionItem & { missing_info: string[] }): Record<string, unknown> => ({
      id: a.id,
      action_type: a.action_type,
      status: a.status,
      headline: a.headline || (typeof a.params?.title === "string" ? a.params.title : "") || a.reason || "",
      summary: a.summary ?? "",
      next_actions: a.next_actions ?? [],
      sender_name: resolveName(a.context?.sender_handle) ?? a.context?.sender_name ?? a.context?.sender_handle ?? "",
      missing_info: a.missing_info,
    });
    const byProject = new Map<string, Array<Record<string, unknown>>>();
    const misc: Array<Record<string, unknown>> = [];
    for (const a of live) {
      const pid = a.project_id;
      if (pid && pid !== "MISC") {
        const arr = byProject.get(pid) ?? [];
        arr.push(cardLite(a));
        byProject.set(pid, arr);
      } else {
        misc.push(cardLite(a));
      }
    }
    const out = projects.map((p: Project) => ({
      id: p.id,
      company: p.company ?? "",
      name: p.name || p.id,
      goal: p.goal ?? "",
      status: p.status ?? "",
      current_state: p.current_state ?? "",
      needs: (p.needs ?? []).filter((n) => n.status === "gap" || n.status === "partial"),
      blockers: p.blockers ?? [],
      cards: byProject.get(p.id) ?? [],
    }));
    return { projects: out, misc };
  }

  // Rich persona data for the People screen: the raw v3 persona + a
  // pre-computed Core-Knowledge field list (value + provenance + evidence) +
  // that person's live queue items. Separate call so the Queue poll stays lean.
  // Head-photo cache: { personaKey: url }, populated by scripts/resolve-avatars.ts
  // (Slack users.info). Read-only + best-effort — absent file → initials avatars.
  private loadAvatars(): Record<string, string> {
    try {
      const raw = readFileSync(join(dirname(this.opts.statePath), "avatars.json"), "utf8");
      const obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? obj : {};
    } catch {
      return {};
    }
  }

  getPeople(): Array<Record<string, unknown>> {
    const raw = loadRawPersonas(this.opts.personaDir);
    const avatars = this.loadAvatars();
    const live = loadState(this.opts.statePath).actions.filter(
      (a) => a.status === "suggested" || a.status === "approved",
    );
    // Scalar fields shown as Core-Knowledge cards (header/Voice/Threads/
    // Commitments are rendered from their own dedicated v3 sections).
    const FIELD_SPECS: Array<[string, string]> = [
      ["identity.role", "Role"],
      ["identity.org", "Org"],
      ["relationship_meta.decision_authority", "Decision authority"],
      ["communication.response_rhythm", "Response rhythm"],
      ["communication.active_hours", "Active hours"],
      ["communication.urgency_calibration", "Urgency"],
      ["behavior.reliability", "Reliability"],
      ["behavior.bad_news_style", "Bad-news style"],
      ["behavior.pet_peeves", "Pet peeves"],
      ["personal.family", "Family"],
      ["personal.notes", "Notes"],
      ["personal.interests", "Interests"],
    ];
    const get = (o: unknown, path: string): unknown =>
      path.split(".").reduce<unknown>((c, k) => (c && typeof c === "object" ? (c as Record<string, unknown>)[k] : undefined), o);
    return raw.map((p) => {
      const prov = p.provenance as Record<string, "manual" | "inferred"> | undefined;
      const ev = p.evidence as Record<string, string> | undefined;
      const fields = FIELD_SPECS.flatMap(([path, label]) => {
        let value = get(p, path);
        if (value == null || value === "") return [];
        if (Array.isArray(value)) value = value.join(" · ");
        return [{ label, value: String(value), provenance: provenanceFor(path, prov), evidence: evidenceFor(path, ev) ?? null }];
      });
      const handles = (p.handles as Record<string, string> | undefined) ?? {};
      const handleVals = Object.values(handles).filter(Boolean).map((h) => String(h).toLowerCase());
      const tasks = live
        .filter(
          (a) =>
            a.target?.personaKey === p.key ||
            handleVals.includes(String(a.context?.sender_handle ?? "").toLowerCase()),
        )
        .map((a) => ({
          id: a.id,
          action_type: a.action_type,
          status: a.status,
          title: (typeof a.params?.title === "string" && a.params.title) || a.draft || a.reason || "",
        }));
      const avatar = (typeof p.key === "string" && avatars[p.key]) || undefined;
      return { ...p, fields, tasks, avatar };
    });
  }

  // Activity log (F3) for the Activity screen: the JSONL tail beside the
  // state file, chronological (oldest→newest), optionally filtered by kind.
  // Read-only + lock-free (append-only file; readActivity tolerates a torn
  // last line). A missing log = an empty list, not an error — a fresh
  // install simply has no events yet.
  getActivity({ tail = 100, kind }: { tail?: number; kind?: ActivityKind } = {}): { records: ActivityRecord[] } {
    let recs: ActivityRecord[] = [];
    try {
      recs = readActivity(readFileSync(activityPathFor(this.opts.statePath), "utf8"));
    } catch {
      /* no log yet */
    }
    if (kind) recs = recs.filter((r) => r.kind === kind);
    const capped = Math.min(Math.max(Math.trunc(tail) || 100, 1), 500);
    return { records: recs.slice(-capped) };
  }

  // ─── calendar (Calendar screen) ─────────────────────────────────
  // Read-only week feed: the real Google Calendar events of the identity's
  // calendarMailbox, reduced to the display shape the week grid needs. This
  // is a READ path only — the cockpit never writes to Calendar from here
  // (booking stays behind the approve flow).
  //
  // Failures PROPAGATE (server → 500, screen → error strip). Never swallow:
  // a silently-empty calendar reads as "nothing scheduled", the worst lie
  // this screen could tell. Cancelled events are filtered out — they are
  // tombstones, not schedule.

  async getCalendarEvents({
    timeMin,
    timeMax,
  }: {
    timeMin: string;
    timeMax: string;
  }): Promise<{ events: CockpitCalendarEvent[] }> {
    const mailbox = loadIdentity().calendarMailbox;
    if (!mailbox) {
      throw new CockpitBadRequestError("no calendar mailbox configured (identity.calendarMailbox)");
    }
    const list =
      this.opts.calendarLister?.(mailbox) ??
      ((o: { timeMin: string; timeMax: string }) =>
        new CalendarClient({ email: mailbox }).listAllEvents(o));
    const raw = await list({ timeMin, timeMax });
    const events: CockpitCalendarEvent[] = raw
      .filter((e) => e.status !== "cancelled")
      .map((e) => ({
        id: e.id ?? "",
        summary: e.summary ?? "(no title)",
        // Timed events carry RFC 3339 dateTime; all-day carry a YYYY-MM-DD
        // date. The grid branches on allDay, so keep both verbatim.
        start: e.start.dateTime ?? e.start.date ?? "",
        end: e.end.dateTime ?? e.end.date ?? "",
        allDay: !e.start.dateTime,
        ...(e.location ? { location: e.location } : {}),
        attendees: (e.attendees ?? []).map((a) => a.displayName ?? a.email),
        ...(e.htmlLink ? { htmlLink: e.htmlLink } : {}),
      }));
    return { events };
  }

  // Read-only conflict pre-check for ONE calendar card — the Queue's
  // conflict line. Runs the SAME conflict logic the approve path uses
  // (execute.ts checkCalendarConflicts) against the live calendar, but
  // never inserts: the card shows what approve would block on, before the
  // click. Modeled on getCalendarEvents — resolves the mailbox, lists
  // events in the proposed window, finds overlaps. No state lock is held
  // across the network call: state is read once up front.
  async calendarConflicts(id: string): Promise<{ conflicts: Conflict[] }> {
    const state = loadState(this.opts.statePath);
    const action = state.actions.find((a) => a.id === id);
    if (!action) throw new CockpitBadRequestError(`unknown action: ${id}`);
    if (action.action_type !== "calendar") {
      throw new CockpitBadRequestError("conflict pre-check is only for calendar actions");
    }
    const mailbox = resolveCalendarMailbox(action);
    if (!mailbox) {
      throw new CockpitBadRequestError("no calendar mailbox configured for this card");
    }
    const list =
      this.opts.calendarLister?.(mailbox) ??
      ((o: { timeMin: string; timeMax: string }) =>
        new CalendarClient({ email: mailbox }).listAllEvents(o));
    const conflicts = await coreCheckCalendarConflicts(action, list);
    return { conflicts };
  }

  // AI re-time: the user types a natural-language instruction on a calendar
  // card (e.g. "move to 8/7 15:00-16:00", "extend by 30 min") and the LLM
  // rewrites the proposed start/end. The instruction is the user's OWN input
  // (trusted); the
  // LLM OUTPUT is untrusted and deterministically validated — RFC 3339,
  // start<end — before it touches the card. Uses the daemon's LLM mode unless
  // a caller injected `jsonLlm` (tests).
  async reTime(id: string, instruction: string): Promise<ActionItem> {
    const trimmed = instruction.trim();
    if (!trimmed) throw new CockpitBadRequestError("empty instruction");

    const state = loadState(this.opts.statePath);
    const action = state.actions.find((a) => a.id === id);
    if (!action) throw new CockpitBadRequestError(`unknown action: ${id}`);
    if (action.action_type !== "calendar") {
      throw new CockpitBadRequestError("re-time is only for calendar actions");
    }
    const p = action.params;

    const llm = this.opts.jsonLlm ?? (await this.buildJsonLlm());
    const result = await llm({
      system:
        "You re-time a Google Calendar event for a personal assistant. Given the event's " +
        "current times and a user instruction, output ONLY a single JSON object " +
        '{"start":"...","end":"..."}. COPY THE CURRENT START\'S OFFSET EXACTLY — if it ' +
        'ends in "-05:00", yours ends in "-05:00"; never substitute a different one, and ' +
        "never invent an offset the current event does not have. If the current start has " +
        'NO offset, output a bare wall time "YYYY-MM-DDTHH:mm:ss" with no offset and no Z; ' +
        "the caller stamps the owner's timezone. Interpret RELATIVE instructions (e.g. " +
        '"extend by 30 minutes", "move earlier by 1 hour") from the CURRENT start/end. If no ' +
        "current time is set, the instruction must supply it absolutely. Never change the " +
        "event title. No prose.",
      userText:
        `Event title: ${typeof p.title === "string" ? p.title : "(untitled)"}\n` +
        `Current start: ${typeof p.start === "string" ? p.start : "(not set)"}\n` +
        `Current end: ${typeof p.end === "string" ? p.end : "(not set)"}\n` +
        `User instruction: ${trimmed}`,
      toolInputSchema: {
        type: "object",
        properties: {
          start: {
            type: "string",
            description:
              "RFC 3339 start carrying the CURRENT start's own offset, or a bare wall time when it has none",
          },
          end: {
            type: "string",
            description:
              "RFC 3339 end carrying the CURRENT start's own offset, or a bare wall time when it has none",
          },
        },
        required: ["start", "end"],
      },
    });

    const obj = (result ?? null) as { start?: unknown; end?: unknown } | null;
    const start = typeof obj?.start === "string" ? toRfc3339(obj.start) : null;
    const end = typeof obj?.end === "string" ? toRfc3339(obj.end) : null;
    if (!start || !end || isNaN(Date.parse(start)) || isNaN(Date.parse(end))) {
      throw new CockpitBadRequestError(
        'AI couldn\'t parse a valid time — try e.g. "move to 8/7 15:00-16:00"',
      );
    }
    if (new Date(end).getTime() <= new Date(start).getTime()) {
      throw new CockpitBadRequestError("end must be after start");
    }

    return this.withLock((state) => {
      const current = state.actions.find((a) => a.id === id);
      if (!current) throw new CockpitBadRequestError(`unknown action: ${id}`);
      const updated = { ...current, params: { ...current.params, start, end } };
      this.replace(state, updated);
      saveState(this.opts.statePath, state);
      this.activity(
        "re-time",
        `re-timed calendar "${CockpitApi.headlineOf(updated)}" → ${start}–${end}`,
        { id, action_type: updated.action_type },
      );
      return updated;
    });
  }

  private async buildJsonLlm(): Promise<JsonLlmCaller> {
    const mode = loadSettings(this.opts.statePath).llm.mode;
    if (mode === "anthropic") return createAnthropicJsonCaller();
    if (mode === "deepseek") return createDeepseekJsonCaller();
    return createClaudeCliJsonCaller();
  }

  // ─── MCP tools (Settings → Tools) ─────────────────────────────────
  // The user's connected task-processing MCPs live in config/tools.json
  // (relay/io/tools.ts) — built-in defaults are never written, only merged.
  async getToolsConfig(): Promise<{
    tools: ToolsConfig["tools"];
    effective: Record<string, ToolSpec>;
    defaults: string[];
    // For URL-based MCP tools: whether a Keychain OAuth token already exists
    // (so the Settings page can show "Connected" instead of "Connect").
    authorized: Record<string, boolean>;
  }> {
    const effective = effectiveToolSpecs(this.opts.statePath);
    const authorized: Record<string, boolean> = {};
    for (const [key, spec] of Object.entries(effective)) {
      const cfg = spec.config ?? {};
      if (cfg.type === "mcp" && cfg.url) {
        authorized[key] = await hasSecret(mcpAuthServiceFor(key, cfg.authService), cfg.url);
      }
    }
    return {
      tools: loadToolsConfig(this.opts.statePath).tools,
      effective,
      defaults: Object.keys(DEFAULT_TOOL_SPECS),
      authorized,
    };
  }

  // Trigger the OAuth flow for a URL-based MCP tool — the Settings page's
  // "Connect" button. Opens the browser, stores the token, returns when done.
  async authorizeTool(toolKey: string): Promise<{ ok: true; service: string }> {
    const spec = effectiveToolSpecs(this.opts.statePath)[toolKey];
    if (!spec) throw new CockpitBadRequestError(`unknown tool: ${toolKey}`);
    const cfg = spec.config ?? {};
    if (cfg.type !== "mcp" || !cfg.url) {
      throw new CockpitBadRequestError(
        `${toolKey} is not a URL-based MCP tool (needs config.type="mcp" and a url)`,
      );
    }
    const service = mcpAuthServiceFor(toolKey, cfg.authService);
    await authorizeMcpTool(cfg.url, service);
    return { ok: true, service };
  }

  // Forget a URL-based MCP tool's OAuth token. Unlike Slack there is no
  // documented revoke endpoint on these servers, so this is a LOCAL delete —
  // the grant may still exist at the provider and has to be withdrawn there.
  // The caller says so rather than implying a full revoke.
  async deauthorizeTool(toolKey: string): Promise<{ ok: true; revokedRemotely: false }> {
    const spec = effectiveToolSpecs(this.opts.statePath)[toolKey];
    if (!spec) throw new CockpitBadRequestError(`unknown tool: ${toolKey}`);
    const cfg = spec.config ?? {};
    if (cfg.type !== "mcp" || !cfg.url) {
      throw new CockpitBadRequestError(`${toolKey} is not a URL-based MCP tool`);
    }
    // Already-absent is success: the caller wants it gone, and it is.
    await deleteSecret(mcpAuthServiceFor(toolKey, cfg.authService), cfg.url).catch(() => {});
    return { ok: true, revokedRemotely: false };
  }

  setToolsConfig(config: { tools?: Record<string, unknown> }): { tools: ToolsConfig["tools"] } {
    const clean: ToolsConfig = { tools: {} };
    for (const [key, raw] of Object.entries(config.tools ?? {})) {
      const spec = (raw ?? {}) as Partial<ToolSpec>;
      clean.tools[key] = {
        key,
        label: typeof spec.label === "string" && spec.label ? spec.label : key,
        requiredParams: Array.isArray(spec.requiredParams)
          ? spec.requiredParams.filter((p): p is string => typeof p === "string")
          : [],
        ...(spec.config && typeof spec.config === "object"
          ? { config: spec.config as Record<string, string> }
          : {}),
      };
    }
    saveToolsConfig(this.opts.statePath, clean);
    this.activity("edit", "settings: MCP tools updated");
    return { tools: clean.tools };
  }

  // ─── settings (Settings screen, S3) ───────────────────────────────
  // Non-secret LLM config lives in config/secretary-settings.json (relay/io/
  // settings.ts); the API keys themselves live ONLY in the macOS Keychain.
  // Neither touches loop-state, so these don't take the state lock.
  //
  // RED LINE: nothing here ever returns, logs, or activity-records a full key.
  // The UI gets {configured, preview} where preview is at most the last 4
  // chars ("…1234") — enough to tell WHICH key is stored, nothing more.

  async getSettings(): Promise<CockpitSettings> {
    const { llm, timezone, autoUpdate } = loadSettings(this.opts.statePath);
    // "configured" = a key resolves at all. The resolvers also honor the
    // ANTHROPIC_API_KEY / DEEPSEEK_API_KEY env vars — deliberately: an env-
    // supplied key is just as usable by the daemon, so hiding it would lie.
    const probe = async (resolve: () => Promise<string>): Promise<KeyStatus> => {
      try {
        const value = await resolve();
        if (!value) return { configured: false, preview: null };
        return { configured: true, preview: `…${value.slice(-4)}` };
      } catch {
        return { configured: false, preview: null };
      }
    };
    return {
      llm,
      timezone,
      autoUpdate,
      keys: {
        anthropic: await probe(() => resolveAnthropicKey()),
        deepseek: await probe(() => resolveDeepseekKey()),
      },
    };
  }

  // Persist the drafting backend + model. Takes effect on the NEXT daemon
  // start (run-notify.ts reads the file once at startup) — hence
  // restartRequired so the UI can say so.
  setLlm({ mode, draftModel }: { mode: string; draftModel: string }): { ok: true; restartRequired: true } {
    if (!LLM_MODES.includes(mode as LlmMode)) {
      throw new CockpitBadRequestError(`unknown llm mode: ${mode}`);
    }
    const model = draftModel.trim();
    if (!model) throw new CockpitBadRequestError("draftModel must be non-empty");
    // Preserve everything else in the file: this endpoint owns the llm block
    // only, and a blind write would silently reset the timezone.
    const current = loadSettings(this.opts.statePath);
    saveSettings(this.opts.statePath, {
      ...current,
      llm: { mode: mode as LlmMode, draftModel: model },
    });
    this.activity("edit", `settings: llm mode=${mode} model=${model}`);
    return { ok: true, restartRequired: true };
  }

  // The OWNER's timezone: the clock the model reasons against, and the zone a
  // meeting is read in when the conversation does not name one. Empty resets
  // to the machine's zone rather than to a constant — "UTC" would silently
  // shift every relative date for anyone not on it.
  setTimezone({ timezone }: { timezone: string }): { ok: true; timezone: string; restartRequired: true } {
    const tz = timezone.trim();
    if (tz && !isValidTimeZone(tz)) {
      throw new CockpitBadRequestError(`not an IANA timezone: ${tz}`);
    }
    const current = loadSettings(this.opts.statePath);
    saveSettings(this.opts.statePath, { ...current, timezone: tz || machineTimeZone() });
    const applied = loadSettings(this.opts.statePath).timezone;
    this.activity("edit", `settings: timezone=${applied}`);
    return { ok: true, timezone: applied, restartRequired: true };
  }

  // Unattended updates. Unlike the other settings this one takes effect
  // immediately — the cockpit's own timer reads the file each tick — so there
  // is no restartRequired to report.
  setAutoUpdate({ autoUpdate }: { autoUpdate: boolean }): { ok: true; autoUpdate: boolean } {
    const current = loadSettings(this.opts.statePath);
    saveSettings(this.opts.statePath, { ...current, autoUpdate });
    this.activity("edit", `settings: autoUpdate=${autoUpdate}`);
    return { ok: true, autoUpdate };
  }

  // Store or remove an API key in the Keychain. The whitelist is exactly two
  // services — Slack / Google OAuth tokens are NOT settable from the cockpit
  // (they have their own flows). An empty value removes the entry.
  async setApiKey({ service, value }: { service: string; value: string }): Promise<{ ok: true }> {
    const target = KEYCHAIN_TARGETS[service as ApiKeyService];
    if (!target) throw new CockpitBadRequestError(`unknown key service: ${service}`);
    const v = value.trim();
    if (v) {
      await setSecret(target.service, target.account, v);
    } else {
      try {
        await deleteSecret(target.service, target.account);
      } catch (e) {
        // Removing a key that isn't there is a no-op, not an error.
        if (!(e instanceof KeychainEntryMissing)) throw e;
      }
    }
    // The summary names the service, never the value.
    this.activity("edit", `settings: ${service} key ${v ? "updated" : "removed"}`);
    return { ok: true };
  }

  // ─── google setup (Settings Google tab) ───────────────────────────
  // First-time Gmail + Calendar onboarding (SETUP.md §3) driven from the
  // cockpit instead of the terminal. reauth.ts covers "existing bundle went
  // stale"; this covers "no bundle yet". Same red line as the API keys: the
  // client JSON and token bundles NEVER appear in any response, log, or
  // activity record — only configured/authorized booleans cross the wire.

  async getGoogleSetup(): Promise<GoogleSetupStatus> {
    const identity = loadIdentity();
    // Display list = authorize whitelist: primary + every polled mailbox,
    // de-duped (primaryEmail is usually also in mailboxes).
    const emails = [...new Set([identity.primaryEmail, ...identity.mailboxes].filter(Boolean))];
    return {
      clientConfigured: await hasSecret(GOOGLE_CLIENT_SERVICE, GOOGLE_CLIENT_ACCOUNT),
      mailboxes: await Promise.all(
        emails.map(async (email) => ({
          email,
          authorized: await hasSecret(TOKEN_KEYCHAIN_SERVICE, email),
          isCalendar: email === identity.calendarMailbox,
        })),
      ),
    };
  }

  // Store the OAuth client JSON downloaded from Google Cloud. Validated
  // before it touches Keychain: it must parse and look like a Google client
  // blob (`installed` = Desktop app, `web` accepted so a wrong-but-honest
  // download still works with the consent script's client_id lookup).
  async setGoogleClientJson(json: string): Promise<{ ok: true }> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new CockpitBadRequestError("client JSON is not valid JSON");
    }
    const hasClientId = (o: unknown): boolean =>
      !!o && typeof o === "object" && typeof (o as Record<string, unknown>).client_id === "string";
    const root = parsed as Record<string, unknown> | null;
    if (!root || (!hasClientId(root.installed) && !hasClientId(root.web))) {
      throw new CockpitBadRequestError(
        "client JSON must contain installed.client_id or web.client_id — download the OAuth client ID (Desktop app) JSON from Google Cloud",
      );
    }
    await setSecret(GOOGLE_CLIENT_SERVICE, GOOGLE_CLIENT_ACCOUNT, json);
    // Names the event only — the JSON itself is never logged.
    this.activity("edit", "settings: google client JSON stored");
    return { ok: true };
  }

  // Kick off the browser consent flow for one mailbox (first authorization,
  // or a deliberate re-consent). The mailbox must come from the identity
  // config — it lands in the spawned argv, so an arbitrary string here would
  // be argument injection into a local script; the whitelist keeps the
  // cockpit from consenting mailboxes the engine doesn't even poll.
  async authorizeGoogleMailbox(
    mailbox: string,
    spawnConsent: GoogleConsentSpawn = defaultGoogleConsentSpawn,
  ): Promise<{ started: true }> {
    const identity = loadIdentity();
    const allowed = new Set([identity.primaryEmail, ...identity.mailboxes]);
    if (!allowed.has(mailbox)) {
      throw new CockpitBadRequestError(`unknown mailbox: ${mailbox} — not in the identity config`);
    }
    if (!(await hasSecret(GOOGLE_CLIENT_SERVICE, GOOGLE_CLIENT_ACCOUNT))) {
      throw new CockpitBadRequestError("store the OAuth client JSON first (step 4)");
    }
    spawnConsent([
      "tsx",
      GOOGLE_CONSENT_SCRIPT,
      "consent",
      GOOGLE_CLIENT_SERVICE,
      GOOGLE_CLIENT_ACCOUNT,
      mailbox,
    ]);
    this.activity("edit", `settings: google consent started for ${mailbox}`);
    return { started: true };
  }

  // ─── mutations (each under the single-writer lock) ────────────────
  private withLock<T>(fn: (state: LoopState) => T): T {
    const stateDir = dirname(this.opts.statePath);
    if (!acquireLock(stateDir)) {
      throw new CockpitBusyError();
    }
    try {
      const state = loadState(this.opts.statePath);
      return fn(state);
    } finally {
      releaseLock(stateDir);
    }
  }

  private findOrThrow(state: LoopState, id: string): ActionItem {
    const a = state.actions.find((x) => x.id === id);
    if (!a) throw new CockpitNotFoundError(id);
    return a;
  }

  private replace(state: LoopState, updated: ActionItem): void {
    const idx = state.actions.findIndex((x) => x.id === updated.id);
    if (idx >= 0) state.actions[idx] = updated;
  }

  // P0 instrumentation: every cockpit decision lands in the append-only label
  // ledger with a REAL decided_at (the source state never recorded one) plus the
  // human's reason. Any edit diff accumulated on the card while it was suggested
  // rides along, so one label = one decision with its full edit history.
  // Never throws: a ledger hiccup must not block the user's decision (unlike the
  // removal paths, nothing is being destroyed here).
  private label(
    action: ActionItem,
    decision: LabelDecision,
    extra: { existence?: ExistenceVerdict; field_errors?: FieldError[]; note?: string } = {},
  ): void {
    try {
      const raw = (action.params as { _edit_diff?: unknown })._edit_diff;
      const edit_diff = Array.isArray(raw) ? (raw as EditDiffEntry[]) : undefined;
      appendLabel(
        labelsPathFor(this.opts.statePath),
        buildLabel({
          action,
          decision,
          decided_at: this.now(),
          ...(extra.existence ? { existence: extra.existence } : {}),
          ...(extra.field_errors && extra.field_errors.length ? { field_errors: extra.field_errors } : {}),
          ...(extra.note ? { note: extra.note } : {}),
          ...(edit_diff && edit_diff.length ? { edit_diff } : {}),
        }),
      );
    } catch {
      /* ledger unavailable — never block the human's decision */
    }
  }

  // F3 activity log: one JSONL line per cockpit decision, beside the state
  // file (labels.jsonl is the accuracy ledger; this is the operational
  // trail). Never throws — same contract as label() above.
  private activity(kind: ActivityKind, summary: string, data?: Record<string, unknown>): void {
    try {
      appendActivity(activityPathFor(this.opts.statePath), {
        at: this.now(),
        kind,
        summary,
        ...(data ? { data } : {}),
      });
    } catch {
      /* logging must never block the human's decision */
    }
  }

  // One-line identity of a card for activity summaries.
  private static headlineOf(a: ActionItem): string {
    return (
      a.headline ||
      (typeof a.params?.title === "string" ? a.params.title : "") ||
      a.reason ||
      a.id
    );
  }

  // Approve → execute. Returns the post-execution action + flags so the UI
  // can render the slide-out (sent), the awaiting-manual morph (gmail/
  // wechat), or the conflict state (calendar).
  async approve(id: string): Promise<ApproveResult> {
    const stateDir = dirname(this.opts.statePath);
    if (!acquireLock(stateDir)) throw new CockpitBusyError();
    try {
      let state = loadState(this.opts.statePath);
      const action = this.findOrThrow(state, id);
      // approveAction throws on missing-info — surfaced as 400 by the server.
      // Uses the EFFECTIVE tool registry so a user-configured tool's required
      // params gate approval too, not just the built-in ones.
      const approved = approveAction(action, effectiveToolSpecs(this.opts.statePath));
      this.replace(state, approved);
      saveState(this.opts.statePath, state); // persist approval before execute

      // persistClaim writes the executing marker mid-flight (crash-safe).
      const persistClaim = async (claimed: ActionItem): Promise<void> => {
        const s = loadState(this.opts.statePath);
        const idx = s.actions.findIndex((x) => x.id === claimed.id);
        if (idx >= 0) s.actions[idx] = claimed;
        saveState(this.opts.statePath, s);
      };

      let result: ExecuteResult;
      try {
        result = await this.opts.executor(approved, persistClaim);
      } catch (e) {
        // Execution failed AFTER we persisted "approved". Don't strand the
        // card as approved-with-no-side-effect (which shows a false "Draft
        // created" and blocks re-approval). Roll it back to suggested so the
        // user can retry — UNLESS a receipt was already written (the side
        // effect happened), in which case it stays as-is.
        const s = loadState(this.opts.statePath);
        const cur = s.actions.find((x) => x.id === id);
        if (cur && cur.status === "approved" && !hasReceipt(cur)) {
          const { execution_started_at: _started, ...cleanParams } = cur.params;
          const restored = restoreAction({ ...cur, params: cleanParams });
          this.replace(s, restored);
          saveState(this.opts.statePath, s);
        }
        this.activity(
          "error",
          `approve of ${approved.action_type} "${CockpitApi.headlineOf(approved)}" failed: ${(e as Error).message ?? String(e)} — rolled back to suggested`,
          { id, action_type: approved.action_type },
        );
        throw e;
      }

      // Re-load (the claim write may have mutated on disk) and apply final.
      state = loadState(this.opts.statePath);
      if (result.conflicts && result.conflicts.length > 0) {
        // No event created — un-approve so the user can re-time + re-approve.
        const restored = restoreAction(approved);
        this.replace(state, restored);
        saveState(this.opts.statePath, state);
        this.activity(
          "approve",
          `approved calendar "${CockpitApi.headlineOf(approved)}" → conflict, un-approved for re-timing`,
          { id, action_type: approved.action_type, conflicts: result.conflicts },
        );
        return { ok: false, conflicts: result.conflicts, action: restored };
      }
      this.replace(state, result.action);
      saveState(this.opts.statePath, state);
      // Approving IS the confirmation signal. An awaiting-manual item is not
      // terminal yet — markSent/markDone labels it when the human finishes.
      if (result.action.status === "executed") {
        this.label(result.action, "executed", { existence: "confirmed" });
      }
      // Double-booking guard: approving a calendar card SETTLES that meeting.
      // Still-suggested siblings for the same start (supersede-exempt
      // survivors, refresh re-emissions) are now duplicates — auto-reject them
      // so a second click can't book the meeting twice (2026-08-02: six
      // duplicate Q3 预算评审会 events were created exactly this way).
      if (
        result.action.action_type === "calendar" &&
        result.action.status === "executed" &&
        typeof result.action.params?.start === "string" &&
        result.action.params.start !== ""
      ) {
        const start = result.action.params.start;
        const siblings = state.actions.filter(
          (s) =>
            s.id !== result.action.id &&
            s.status === "suggested" &&
            s.action_type === "calendar" &&
            s.params?.start === start,
        );
        for (const sib of siblings) {
          const rejected = rejectAction(sib);
          this.replace(state, rejected);
          this.label(rejected, "rejected", {
            existence: "duplicate",
            note: `auto-skipped: identical start to approved card ${result.action.id}`,
          });
          this.activity(
            "skip",
            `auto-skipped duplicate calendar "${CockpitApi.headlineOf(rejected)}" (same start ${start} as the approved card)`,
            { id: sib.id, action_type: "calendar", start },
          );
        }
        if (siblings.length > 0) saveState(this.opts.statePath, state);
      }
      // A tool execution's result ref (e.g. the stub ticket key) goes on the
      // approve line so the Activity page shows WHAT the tool produced — the
      // user shouldn't have to hunt the terminal for it.
      const toolRef =
        result.receipt?.kind === "tool_result" ? ` → ${result.receipt.ref}` : "";
      this.activity(
        "approve",
        `approved ${approved.action_type} "${CockpitApi.headlineOf(approved)}" → ${result.action.status}${toolRef}${result.awaitingManual ? " (awaiting manual)" : ""}`,
        { id, action_type: approved.action_type, status: result.action.status, ...(toolRef ? { ref: result.receipt?.ref } : {}) },
      );
      return {
        ok: true,
        action: result.action,
        awaitingManual: result.awaitingManual,
        receipt: result.receipt,
      };
    } finally {
      releaseLock(stateDir);
    }
  }

  // Edit a suggested action's draft and/or params, flag it edited (feeds
  // the validation gate's edit-vs-clean signal). Stays suggested.
  edit(id: string, patch: { draft?: string; params?: Record<string, unknown> }): ActionItem {
    return this.withLock((state) => {
      const action = this.findOrThrow(state, id);
      if (action.status !== "suggested")
        throw new CockpitBadStateError(id, action.status, "edit requires suggested");
      // P0: capture WHAT the human changed, not just that they changed something.
      // The old `_edited: true` flag said an edit happened but threw away the
      // content — which is why only 1 of 365 actions had any edit signal. The
      // diff accumulates on the card and is attached to the decision label.
      const prior = (action.params as { _edit_diff?: unknown })._edit_diff;
      const diff: EditDiffEntry[] = Array.isArray(prior) ? [...(prior as EditDiffEntry[])] : [];
      if (patch.draft !== undefined && patch.draft !== action.draft) {
        diff.push({ field: "draft", before: action.draft ?? null, after: patch.draft });
      }
      for (const [k, after] of Object.entries(patch.params ?? {})) {
        const before = (action.params as Record<string, unknown>)[k];
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          diff.push({ field: `params.${k}`, before: before ?? null, after });
        }
      }
      const updated: ActionItem = {
        ...action,
        ...(patch.draft !== undefined ? { draft: patch.draft } : {}),
        params: {
          ...action.params,
          ...(patch.params ?? {}),
          _edited: true,
          ...(diff.length ? { _edit_diff: diff } : {}),
        },
      };
      this.replace(state, updated);
      saveState(this.opts.statePath, state);
      this.activity(
        "edit",
        `edited ${updated.action_type} "${CockpitApi.headlineOf(updated)}" (${diff.map((d) => d.field).join(", ") || "no field change"})`,
        { id, action_type: updated.action_type, fields: diff.map((d) => d.field) },
      );
      return updated;
    });
  }

  // reason/field_errors are the P0 typed-skip signal. `deferred` means "the card
  // is right, just not today" and is excluded from the precision denominator —
  // counting a deferral as a false positive would understate real precision.
  skip(
    id: string,
    reason?: { existence?: ExistenceVerdict; field_errors?: FieldError[]; note?: string },
  ): ActionItem {
    return this.withLock((state) => {
      const action = this.findOrThrow(state, id);
      const updated = rejectAction(action); // throws if not suggested
      this.replace(state, updated);
      saveState(this.opts.statePath, state);
      this.label(updated, "rejected", {
        existence: reason?.existence,
        field_errors: reason?.field_errors,
        note: reason?.note,
      });
      this.activity(
        "skip",
        `skipped ${updated.action_type} "${CockpitApi.headlineOf(updated)}"${reason?.existence ? ` (${reason.existence})` : ""}${reason?.note ? ` — ${reason.note}` : ""}`,
        { id, action_type: updated.action_type, ...(reason?.existence ? { existence: reason.existence } : {}) },
      );
      return updated;
    });
  }

  restore(id: string): ActionItem {
    return this.withLock((state) => {
      const action = this.findOrThrow(state, id);
      const updated = restoreAction(action); // throws if has receipt / wrong status
      this.replace(state, updated);
      saveState(this.opts.statePath, state);
      this.activity(
        "restore",
        `restored ${updated.action_type} "${CockpitApi.headlineOf(updated)}" → suggested`,
        { id, action_type: updated.action_type },
      );
      return updated;
    });
  }

  // Manual tier override from a drag in the Today list. tier null clears it (back
  // to the AI ranking). The frontend sends the cluster identity key (task_id /
  // __ungrouped_<actionId>); the override stores under the STABLE conversation
  // key (core/unit-key.ts resolvePlanKey) so getState's plan lookup finds it —
  // and a drag on one ungrouped card re-tiers its same-conversation siblings
  // together (they are one planning unit).
  setTier(key: string, tier: "A" | "B" | "C" | "D" | null): { key: string; tier: string | null } {
    return this.withLock((state) => {
      const planKey = resolvePlanKey(key, state.actions);
      const ov = state.planOverrides ?? (state.planOverrides = {});
      if (tier) ov[planKey] = tier;
      else delete ov[planKey];
      saveState(this.opts.statePath, state);
      return { key, tier };
    });
  }

  // Today resolution plan: tick off a Me·reminder (task/ignore) as done. No
  // send, no missing-info gate — a local receipt + executed.
  markDone(id: string): ActionItem {
    return this.withLock((state) => {
      const action = this.findOrThrow(state, id);
      const receipt: ExecutionReceipt = { kind: "local", ref: "manual-done", at: this.now() };
      const updated = markDone(withReceipt(action, receipt));
      this.replace(state, updated);
      saveState(this.opts.statePath, state);
      this.label(updated, "executed", { existence: "confirmed" });
      this.activity(
        "mark-done",
        `marked done ${updated.action_type} "${CockpitApi.headlineOf(updated)}"`,
        { id, action_type: updated.action_type },
      );
      return updated;
    });
  }

  // Mark an awaiting-manual item (Gmail draft the user sent, or a WeChat
  // paste) as done — writes the receipt + executed. The receipt ref comes
  // from the UI (a Gmail message link or "manual").
  markSent(id: string, ref: string = "manual"): ActionItem {
    return this.withLock((state) => {
      const action = this.findOrThrow(state, id);
      if (action.status !== "approved")
        throw new CockpitBadStateError(id, action.status, "markSent requires approved");
      const receipt: ExecutionReceipt = { kind: "sent", ref, at: this.now() };
      const updated = markExecuted(withReceipt(action, receipt));
      this.replace(state, updated);
      saveState(this.opts.statePath, state);
      this.label(updated, "executed", { existence: "confirmed" });
      this.activity(
        "mark-done",
        `marked sent ${updated.action_type} "${CockpitApi.headlineOf(updated)}" (ref: ${ref})`,
        { id, action_type: updated.action_type, ref },
      );
      return updated;
    });
  }

  // Auto-execute the high-confidence task/ignore items (confidence ≥ 0.9,
  // no missing info). The cockpit calls this on load so the queue shows
  // only what genuinely needs a human. Returns the count auto-handled.
  async flushAutoExecute(): Promise<number> {
    const stateDir = dirname(this.opts.statePath);
    if (!acquireLock(stateDir)) throw new CockpitBusyError();
    try {
      const state = loadState(this.opts.statePath);
      const candidates = state.actions.filter((a) => canAutoExecute(a));
      let n = 0;
      for (const cand of candidates) {
        const approved = approveAction(cand);
        const result = await this.opts.executor(approved, async () => {});
        this.replace(state, result.action);
        n++;
      }
      if (n > 0) {
        saveState(this.opts.statePath, state);
        this.activity(
          "auto-execute",
          `auto-executed ${n} card(s): ${candidates.map((c) => `${c.action_type} "${CockpitApi.headlineOf(c)}"`).join("; ")}`,
          { count: n, ids: candidates.map((c) => c.id) },
        );
      }
      return n;
    } finally {
      releaseLock(stateDir);
    }
  }
}

export interface ApproveResult {
  ok: boolean;
  action: ActionItem;
  awaitingManual?: boolean;
  receipt?: ExecutionReceipt;
  conflicts?: ExecuteResult["conflicts"];
}

// ─── settings types (S3) ──────────────────────────────────────────────

export interface KeyStatus {
  configured: boolean;
  /** Last-4-chars mask ("…1234"), null when no key resolves. Never the full key. */
  preview: string | null;
}

export type ApiKeyService = "anthropic" | "deepseek";

export interface CockpitSettings {
  llm: { mode: LlmMode; draftModel: string };
  /** The owner's IANA zone — always resolved, never blank (falls back to the machine). */
  timezone: string;
  /** Apply updates unattended. Off unless the owner turned it on. */
  autoUpdate: boolean;
  keys: Record<ApiKeyService, KeyStatus>;
}

// The ONLY Keychain entries the cockpit may write. Deliberately a closed map —
// a path of `/api/settings/keys` with any other service name is a 400.
const KEYCHAIN_TARGETS: Record<ApiKeyService, { service: string; account: string }> = {
  anthropic: { service: ANTHROPIC_KEY_SERVICE, account: ANTHROPIC_KEY_ACCOUNT },
  deepseek: { service: DEEPSEEK_KEY_SERVICE, account: DEEPSEEK_KEY_ACCOUNT },
};

// ─── google setup types + consent spawn ──────────────────────────────

export interface GoogleMailboxStatus {
  email: string;
  /** A token bundle exists in Keychain for this mailbox. */
  authorized: boolean;
  /** This mailbox is the calendar new events are booked on. */
  isCalendar: boolean;
}

export interface GoogleSetupStatus {
  clientConfigured: boolean;
  mailboxes: GoogleMailboxStatus[];
}

// Injectable so tests assert the exact argv instead of spawning a real
// browser flow. Receives the argv handed to `npx` (["tsx", script, ...]).
export type GoogleConsentSpawn = (argv: string[]) => void;

const COCKPIT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(COCKPIT_DIR, "..", "..");
// Same script reauth.ts drives; the difference is the client refs come from
// the default constants (first-time setup) instead of a stale bundle.
const GOOGLE_CONSENT_SCRIPT = join(REPO_ROOT, "scripts", "auth", "google-oauth.ts");

// Spawn the consent flow and return immediately — the browser dance can take
// a minute, so the HTTP request never waits on it (same pattern as reauth.ts:
// output mirrored to stderr for debugging, unref'd so it outlives the request).
const defaultGoogleConsentSpawn: GoogleConsentSpawn = (argv) => {
  const child = spawn("npx", argv, {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  const mailbox = argv.at(-1);
  child.stdout?.on("data", (d) => process.stderr.write(`[google-consent:${mailbox}] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[google-consent:${mailbox}] ${d}`));
  child.unref();
};

// ─── typed errors the server maps to HTTP statuses ─────────────────────

export class CockpitNotFoundError extends Error {
  constructor(public id: string) {
    super(`action not found: ${id}`);
    this.name = "CockpitNotFoundError";
  }
}
export class CockpitBusyError extends Error {
  constructor() {
    super("state is locked by another writer — retry");
    this.name = "CockpitBusyError";
  }
}
export class CockpitBadStateError extends Error {
  constructor(public id: string, public status: string, detail: string) {
    super(`${detail} (action ${id} is "${status}")`);
    this.name = "CockpitBadStateError";
  }
}
// Client-supplied input failed validation (bad enum value, unknown key
// service, empty required field) — the server maps this to HTTP 400.
export class CockpitBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CockpitBadRequestError";
  }
}
