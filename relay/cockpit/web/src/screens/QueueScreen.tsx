// Queue screen (S5) — React port of legacy public/js/queue.js, the Today
// screen (specs/daily-todo.md): the tiered master list of task clusters
// (A→D + Unranked), the task detail with its resolution plan, the typed-skip
// reason picker, drag-to-re-tier, and task-level keyboard control (j/k move,
// a/e/s act — registered here, gated on this screen being mounted, which is
// the React equivalent of legacy main.js's `App.screen !== "queue"` check).
//
// Selection model mirrors legacy's App fields one-to-one:
// - selectedTaskId: task-level selection; the detail pane follows it.
// - selectedId: card-level target for actions, kept consistent with what the
//   detail pane shows (the selected task's footer target) so no code path can
//   act on a card the user has navigated away from.
// - editCardId / editing: the single-card drill-in + draft-edit mode.
// - skipFor: the card the skip-reason panel is open for.
//
// Render helpers are plain functions called as `{fn(x)}`, NOT components:
// their output merges into this component's element tree, so uncontrolled
// inputs (the draft textarea, the <details> expanders) keep their DOM state
// across re-renders — an inline component type would remount and wipe them.
//
// Legacy rendered escaped HTML strings; React escapes by itself, so
// escapeHtml has no counterpart. font-chinese treatment via isChinese() is
// kept for CJK content. Legacy's Chinese UI copy (skip reasons, drawer
// labels, "查看原始消息") is translated to English per the migration's
// copy rule; the skip reason/field KEYS are API values and unchanged.
import { useContext, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  Calendar,
  Check,
  CheckCheck,
  Circle,
  CircleCheck,
  CircleHelp,
  ExternalLink,
  FilePen,
  Folder,
  Forward,
  Hash,
  Inbox,
  Info,
  ListChecks,
  Loader2,
  Mail,
  MailOpen,
  MessageSquare,
  RefreshCw,
  Repeat,
  Reply,
  Send,
  Shapes,
  Ticket,
  TriangleAlert,
  User,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { apiGet, apiPost } from "../lib/api";
import { Avatar } from "../lib/avatar";
import type { TranscriptMessage } from "../lib/useCockpitState";
import { cn } from "../lib/cn";
import { isChinese } from "../lib/text";
import { timeAgo } from "../lib/time";
import { toast } from "../lib/toast";
import {
  CockpitFeedContext,
  pollGuard,
  useCockpitState,
  type CockpitStateData,
  type QueueAction,
  type TaskCluster,
  type TaskEntity,
  type TaskPlan,
} from "../lib/useCockpitState";

// ─── pure helpers (verbatim ports of queue.js's) ────────────────────

// A cluster's recency = its newest member's created_at (ISO strings sort
// lexically).
function clusterRecency(c: TaskCluster): string {
  let max = "";
  for (const a of c.actions) if (a.created_at > max) max = a.created_at;
  return max;
}
// Clusters newest-first — used ONLY for the flat action list behind
// selectableIds (skip's "select the next card" logic), never for display.
function sortedClusters(clusters: TaskCluster[]): TaskCluster[] {
  return [...clusters].sort((a, b) => clusterRecency(b).localeCompare(clusterRecency(a)));
}
function allLiveActions(clusters: TaskCluster[]): Array<{ action: QueueAction; cluster: TaskCluster }> {
  const out: Array<{ action: QueueAction; cluster: TaskCluster }> = [];
  for (const c of sortedClusters(clusters)) for (const a of c.actions) out.push({ action: a, cluster: c });
  return out;
}
function selectableIds(clusters: TaskCluster[]): string[] {
  return allLiveActions(clusters)
    .filter(({ action }) => action.status === "suggested")
    .map(({ action }) => action.id);
}
// A task cluster's unit key — computed by the backend (getState attaches
// `unit_key`). The id-based derivation stays only as a fallback.
function taskKey(c: TaskCluster): string {
  return c.unit_key || c.task_id || (c.actions[0] ? `__ungrouped_${c.actions[0].id}` : "");
}
// Live task clusters (those with a suggested/approved member).
function liveClusters(clusters: TaskCluster[]): TaskCluster[] {
  return clusters.filter((c) => c.actions.some((a) => a.status === "suggested" || a.status === "approved"));
}

// A calendar card's proposed time + place, e.g. "8/5 15:00–16:00 · Acme HQ".
// Blank when params carry no parseable start — never guess a time.
function calendarTimeLine(a: QueueAction): string {
  const p = a.params;
  const loc = p?.location ?? "";
  if (typeof p?.start !== "string") return loc ? `· ${loc}` : "";
  const s = new Date(p.start);
  if (isNaN(s.getTime())) return loc ? `· ${loc}` : "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const startStr = `${pad(s.getHours())}:${pad(s.getMinutes())}`;
  let range = `${s.getMonth() + 1}/${s.getDate()} ${startStr}`;
  if (typeof p?.end === "string") {
    const e = new Date(p.end);
    if (!isNaN(e.getTime())) {
      const endStr = `${pad(e.getHours())}:${pad(e.getMinutes())}`;
      range += e.toDateString() === s.toDateString() ? `–${endStr}` : `–${e.getMonth() + 1}/${e.getDate()} ${endStr}`;
    }
  }
  return loc ? `${range} · ${loc}` : range;
}

// A tool card's line: tool key · project · assignee (assignee only when the
// message named the owner — never guess).
function toolLine(a: QueueAction): string {
  const p = a.params;
  const tool = typeof p?.tool === "string" ? p.tool : "";
  const project = typeof p?.project === "string" ? p.project : "";
  const assignee = typeof p?.assignee === "string" ? p.assignee : "";
  if (!tool && !project && !assignee) return "";
  return [tool, project, assignee && `→ ${assignee}`].filter(Boolean).join(" · ");
}

// The MCP tools the cockpit lets the user route a tool card to. Mirrors
// core/tool-registry.ts — keep in sync when a tool is added/removed.
const TOOL_OPTIONS = [{ key: "jira", label: "Jira" }];

// Conflict pre-check result for one calendar card (GET
// /api/actions/:id/calendar-conflicts → {conflicts: Conflict[]}). The API
// returns full Conflicts (event + window); the badge only reads event.summary.
interface CalendarConflict {
  event: { summary?: string; start?: { dateTime?: string; date?: string } };
}
type ConflictState = { status: "loading" | "ok" | "error"; conflicts?: CalendarConflict[] };

// The mark-done check that draws itself: circle, then the checkmark (stroke-
// draw via motion.path). Mounts when a task flips to executed, so the draw
// plays exactly on the done click's refresh.
function CheckPop({ size = 20 }: { size?: number }) {
  return (
    <motion.svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      initial={{ scale: 0.4, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: "spring", stiffness: 520, damping: 24 }}
      className="shrink-0"
      aria-hidden="true"
    >
      <motion.circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
      />
      <motion.path
        d="m8.5 12.5 2.4 2.4 4.6-5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.3, ease: "easeOut", delay: 0.22 }}
      />
    </motion.svg>
  );
}

// The calendar row's conflict badge. Loading is explicit so the user knows
// the check is in flight; error shows NOTHING (misconfigured/offline calendar
// must not read as "clear").
function conflictBadge(c: ConflictState | undefined) {
  if (!c) return null;
  if (c.status === "loading") return <span className="text-on-surface-variant">Checking…</span>;
  if (c.status === "error") return null;
  if (!c.conflicts || c.conflicts.length === 0) {
    return (
      <span className="text-emerald-600 inline-flex items-center gap-1">
        <Check size={12} strokeWidth={2} /> No conflict
      </span>
    );
  }
  const names = c.conflicts.map((x) => x.event?.summary || "another event").join(", ");
  return (
    <span className="text-amber-600 inline-flex items-center gap-1" title={`Overlaps existing: ${names}`}>
      <TriangleAlert size={12} strokeWidth={2} /> Conflicts: {names}
    </span>
  );
}

const TIERS = [
  { tier: "A", label: "A · Do first", dot: "bg-red-500" },
  { tier: "B", label: "B · Today", dot: "bg-amber-500" },
  { tier: "C", label: "C · This week", dot: "bg-primary" },
  { tier: "D", label: "D · Later", dot: "bg-slate-400" },
] as const;

// AI-executable action types + the one-click button label (per platform).
function execLabel(a: QueueAction): { assignee: "ai" | "me"; label: string | null; icon: LucideIcon } {
  if (a.action_type === "calendar") return { assignee: "ai", label: "Create event", icon: Calendar };
  if (a.action_type === "tool") {
    return a.params?.tool === "jira"
      ? { assignee: "ai", label: "Create ticket", icon: Ticket }
      : { assignee: "ai", label: `Run ${a.params?.tool ?? "tool"}`, icon: Wrench };
  }
  if (a.action_type === "reply" || a.action_type === "relay" || a.action_type === "forward") {
    return a.target?.platform === "gmail"
      ? { assignee: "ai", label: "Prepare draft", icon: FilePen }
      : { assignee: "ai", label: "Approve & Send", icon: Send };
  }
  return { assignee: "me", label: null, icon: User }; // task / ignore → Me reminder
}

// The row glyph for a suggested NON-task card (calendar/reply/relay/forward):
// a muted action-type icon in place of the mark-done circle, which those types
// don't use (they act via their control button, not the circle).
function actionTypeIcon(a: QueueAction): LucideIcon {
  switch (a.action_type) {
    case "calendar":
      return Calendar;
    case "reply":
      return Reply;
    case "relay":
      return Repeat;
    case "forward":
      return Forward;
    case "tool":
      return Wrench;
    default:
      return Circle;
  }
}

// The detail footer's own targeting: approve/edit → readyCard (footer
// primary), skip → skipTarget (footer Skip). Skip must work on ANY
// still-suggested card, not only AI-sendable ones — gating it on readyCard
// left `Me · reminder` and `Needs info` cards with no way to skip at all.
// approvingId keeps a card that's currently mid-approve (this client's own
// in-flight request) counted as the readyCard too — otherwise a background
// state poll landing on the mid-execution "approved" claim (markExecuting in
// execute.ts, persisted before the tool call resolves) would flip readyCard
// to undefined and flash "Nothing ready to send" while the approve is still
// running.
function footerTargets(
  c: TaskCluster,
  approvingId: string | null,
): { readyCard?: QueueAction; skipTarget?: QueueAction } {
  const readyCard = c.actions.find(
    (a) =>
      (a.status === "suggested" || a.id === approvingId) &&
      !(a.missing_info && a.missing_info.length) &&
      execLabel(a).assignee === "ai",
  );
  const skipTarget = readyCard || c.actions.find((a) => a.status === "suggested");
  return { readyCard, skipTarget };
}

// Provenance line parts: "<platform> · <sender> · <MM-DD HH:mm>". Time
// prefers context.sent_at; legacy cards fall back to the Slack ts embedded in
// source_message_id ("slack:<chan>:<ts.ts>"). Blank when neither exists —
// never guess.
function provenanceLine(a: QueueAction): string {
  const platform = a.target?.platform || (a.source_message_id || "").split(":")[0] || "";
  const who = a.sender_name || a.context?.sender_handle || "";
  let d: Date | null = null;
  const iso = a.context?.sent_at;
  if (iso) {
    const parsed = new Date(iso);
    if (!isNaN(parsed.getTime())) d = parsed;
  }
  if (!d && typeof a.source_message_id === "string") {
    const m = a.source_message_id.match(/^slack:[^:]+:(\d+(?:\.\d+)?)$/);
    if (m) d = new Date(parseFloat(m[1]!) * 1000);
  }
  let when = "";
  if (d) when = fmtWhen(d);
  return [platform, who, when].filter(Boolean).join(" · ");
}

function fmtWhen(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ─── skip reasons (P0 typed skip) ───────────────────────────────────
// ONE click on a reason completes the skip — no confirm step, because the
// value of this instrumentation is entirely fill rate. The field checkboxes
// are optional and ORTHOGONAL: "the time was wrong" is a different fact from
// "this wasn't a real thing". Keys are API values (unchanged); labels are
// English translations of legacy's Chinese copy.
const SKIP_REASONS = [
  { key: "not_a_thing", label: "Not a thing", hint: "should never have been a card" },
  { key: "not_mine", label: "Not mine", hint: "real, but not aimed at me" },
  { key: "duplicate", label: "Duplicate", hint: "same card exists already" },
  { key: "already_handled", label: "Already handled", hint: "dealt with long ago" },
  { key: "deferred", label: "Not now", hint: "card is right, just postponed" },
  { key: "other", label: "Other", hint: "" },
];
const SKIP_FIELDS = [
  { key: "time", label: "Wrong time" },
  { key: "person", label: "Wrong person" },
  { key: "place", label: "Wrong place" },
];

const ENTITY_ICON: Record<string, string> = {
  flight: "✈️",
  file: "📄",
  price: "💰",
  confirmation: "🏨",
  deadline: "📅",
  person: "👤",
  doc: "📝",
};

interface ApproveResult {
  ok?: boolean;
  conflicts?: unknown[];
  awaitingManual?: boolean;
}

// ─── screen ──────────────────────────────────────────────────────────

export default function QueueScreen() {
  // The App shell provides the single shared feed; rendered standalone
  // (tests) the screen falls back to its own instance.
  const shared = useContext(CockpitFeedContext);
  const own = useCockpitState({ enabled: !shared });
  const { state, refresh } = shared ?? own;

  const navigate = useNavigate();
  const location = useLocation();

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editCardId, setEditCardId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [skipFor, setSkipFor] = useState<string | null>(null);
  // Annotating a card is SEPARATE from deciding it. Before this existed the
  // only free-text field lived in the skip panel, so leaving feedback meant
  // rejecting the card — and revising a note meant restore → re-skip.
  const [commentFor, setCommentFor] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const [skipFields, setSkipFields] = useState<string[]>([]);
  // Free-text skip reason. The six buttons cover the shapes we can aggregate;
  // this is for the case they don't fit, which is exactly where the diagnosis
  // usually lives. Optional and it rides along with whichever button is
  // clicked — the one-click flow is the whole value of this panel, so typing
  // must never become a required step.
  const [skipNote, setSkipNote] = useState("");
  // Approve in flight: the clicked action id, so its button can show a spinner
  // instead of appearing frozen while the approve round-trips.
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropTier, setDropTier] = useState<string | null>(null);
  // Calendar conflict pre-check results, keyed by action id (see the effect).
  const [conflictState, setConflictState] = useState<Record<string, ConflictState>>({});
  // Actions the user just marked done: render the check-draw animation locally
  // and delay the refresh so the card disappears AFTER the animation, not before.
  const [doneAnim, setDoneAnim] = useState<Set<string>>(new Set());
  // Calendar re-time editor: which card's editor is open + its instruction text.
  const [reTimeFor, setReTimeFor] = useState<string | null>(null);
  const [reTimeText, setReTimeText] = useState("");
  const [reTimeBusy, setReTimeBusy] = useState(false);
  // Bumped after a re-time so the conflict pre-check re-fetches for the new time.
  const [conflictRefreshToken, setConflictRefreshToken] = useState(0);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());

  const allClusters = state?.clusters ?? [];
  const clusters = liveClusters(allClusters);
  // The "via" picker lists the effective MCP registry (getState attaches it),
  // falling back to the built-in list when state hasn't loaded.
  const toolOptions = state?.tools
    ? Object.entries(state.tools).map(([key, s]) => ({ key, label: s.label ?? key }))
    : TOOL_OPTIONS;

  // The selected task's calendar cards → their ids, as a stable key for the
  // conflict pre-check effect (re-fetch only when the selected task changes).
  const selCluster = selectedCluster();
  const calendarActionIds = selCluster
    ? selCluster.actions.filter((a) => a.action_type === "calendar").map((a) => a.id)
    : [];
  const calendarIdsKey = calendarActionIds.join(",");

  // Read-only conflict pre-check for the selected task's calendar cards (GET
  // /api/actions/:id/calendar-conflicts — one Google Calendar read per card,
  // only when the selected task changes, never on the 15s poll).
  useEffect(() => {
    if (!calendarActionIds.length) return;
    let cancelled = false;
    for (const id of calendarActionIds) {
      setConflictState((prev) => ({ ...prev, [id]: { status: "loading" } }));
      apiGet<{ conflicts: CalendarConflict[] }>(
        `/api/actions/${encodeURIComponent(id)}/calendar-conflicts`,
      ).then(
        (res) => {
          if (cancelled) return;
          setConflictState((prev) => ({ ...prev, [id]: { status: "ok", conflicts: res.conflicts } }));
        },
        () => {
          if (cancelled) return;
          setConflictState((prev) => ({ ...prev, [id]: { status: "error" } }));
        },
      );
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendarIdsKey, conflictRefreshToken]);

  // The Queue's edit mode pauses the shell's 15s poll (legacy App.editing →
  // pollRefresh guard); clear it on unmount so other screens never inherit it.
  useEffect(() => {
    pollGuard.editing = editing;
    return () => {
      pollGuard.editing = false;
    };
  }, [editing]);

  // Focus the draft textarea when edit mode opens (legacy focused #draft-edit
  // right after render).
  useEffect(() => {
    if (editing) draftRef.current?.focus();
  }, [editing, editCardId]);

  // Keep the selected card visible after j/k moves (legacy scrollIntoView).
  useEffect(() => {
    if (!selectedTaskId) return;
    const el = cardRefs.current.get(selectedTaskId);
    // jsdom has no scrollIntoView — the optional call keeps tests quiet.
    el?.scrollIntoView?.({ block: "nearest" });
  }, [selectedTaskId]);

  // A jump from the Projects screen carries a card id as location state
  // (legacy set App.selectedId + switched screen). Select that card's TASK so
  // the detail pane shows it, keep the card as the action target, then clear
  // the state so a later poll doesn't re-select what the user moved on from.
  useEffect(() => {
    const id = (location.state as { selectedId?: string } | null)?.selectedId;
    if (!id || !allClusters.length) return;
    const c = liveClusters(allClusters).find((cl) => cl.actions.some((a) => a.id === id));
    if (c) {
      selectTask(taskKey(c));
      setSelectedId(id);
    }
    navigate(".", { replace: true, state: null });
  }, [allClusters, location.state]);

  // Select a task (master-list click or j/k). selectedId is kept consistent
  // with what the detail pane shows — the task's footer-target card.
  function selectTask(key: string) {
    setSelectedTaskId(key);
    setEditCardId(null);
    setEditing(false);
    const c = clusters.find((cl) => taskKey(cl) === key);
    setSelectedId(c ? (footerTargets(c, approvingId).skipTarget?.id ?? c.actions[0]?.id ?? null) : null);
  }

  // The cluster the detail pane is actually showing (the selected task, else
  // the first live one — legacy's own fallback).
  function selectedCluster(): TaskCluster | null {
    return clusters.find((c) => taskKey(c) === selectedTaskId) || clusters[0] || null;
  }

  // Master-list display order = the keyboard order: tier sections A→D (each
  // in backend rank order), then the unranked catch-all.
  const tiered = TIERS.map((t) => clusters.filter((c) => c.plan?.tier === t.tier));
  const unranked = clusters.filter((c) => !c.plan);
  const masterKeys = [...tiered.flat(), ...unranked].map(taskKey);

  function moveSelection(delta: number) {
    if (!masterKeys.length) return;
    const idx = masterKeys.indexOf(selectedTaskId ?? "");
    const next = idx < 0 ? 0 : Math.min(masterKeys.length - 1, Math.max(0, idx + delta));
    const key = masterKeys[next];
    if (key != null) selectTask(key);
  }

  // a/e/s act on the SELECTED task — the same cards the detail footer's
  // buttons target (approve/edit → readyCard, skip → skipTarget).
  function keyboardAction(act: "approve" | "edit" | "skip") {
    const c = selectedCluster();
    if (!c) return;
    const { readyCard, skipTarget } = footerTargets(c, approvingId);
    if (act === "skip") {
      if (!skipTarget) return;
      setSelectedId(skipTarget.id);
      void doAction("skip", undefined, skipTarget.id);
      return;
    }
    if (!readyCard) return;
    setSelectedId(readyCard.id);
    if (act === "edit") {
      // Mirror the Edit-button click: drill into the single-card editor.
      if (readyCard.draft == null) return;
      setEditCardId(readyCard.id);
      setEditing(true);
    } else {
      void doAction("approve", undefined, readyCard.id);
    }
  }

  // Task-level keyboard control. Registered without a dep array so the
  // handler always closes over the CURRENT selection/state — the React
  // equivalent of legacy re-wiring onclick handlers after every render.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // No shortcuts while typing — legacy checked e.target the same way.
      const t = e.target as HTMLElement;
      if (t.tagName === "TEXTAREA" || t.tagName === "INPUT") return;
      const k = e.key;
      // Escape exits draft-edit mode (the help sheet close lives in App).
      if (k === "Escape") {
        setEditing(false);
        return;
      }
      if (k === "j") {
        e.preventDefault();
        moveSelection(1);
      } else if (k === "k") {
        e.preventDefault();
        moveSelection(-1);
      } else if (k === "a") keyboardAction("approve");
      else if (k === "e") keyboardAction("edit");
      else if (k === "s") keyboardAction("skip");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // Every clickable action goes through here, exactly like legacy doAction:
  // the button's data-id becomes the selected card, then the action runs.
  function handleAct(act: string, id: string, arg?: string) {
    setSelectedId(id);
    void doAction(act, arg, id);
  }

  // Calendar re-time: send the natural-language instruction to the backend's
  // AI re-time endpoint, then refresh the card + re-fetch its conflicts.
  async function submitReTime(id: string) {
    if (reTimeBusy) return;
    const instruction = reTimeText.trim();
    if (!instruction) return;
    setReTimeBusy(true);
    try {
      await apiPost(`/api/actions/${encodeURIComponent(id)}/re-time`, { instruction });
      setReTimeFor(null);
      setReTimeText("");
      setConflictRefreshToken((t) => t + 1);
      await refresh();
      toast("Time updated");
    } catch (e) {
      toast(errMsg(e), true);
    } finally {
      setReTimeBusy(false);
    }
  }

  // Route a tool card through a different connected MCP (params.tool). The
  // user picks the tool freely; approve dispatches to whichever is selected.
  async function setTool(tool: string, id: string) {
    if (!tool) return;
    try {
      await apiPost(`/api/actions/${encodeURIComponent(id)}/edit`, { params: { tool } });
      await refresh();
      toast(`Processing via ${tool}`);
    } catch (e) {
      toast(errMsg(e), true);
    }
  }

  async function doAction(act: string, arg: string | undefined, id: string) {
    try {
      if (act === "approve") {
        // Busy state so the button shows a spinner instead of feeling frozen
        // during the round-trip (real network calls for tool cards like Jira).
        setApprovingId(id);
        try {
          // If the draft was edited but not yet Saved, persist the textarea
          // first so we send the EDITED text — not the stale server-side draft.
          // This edit-then-approve ORDER is load-bearing (legacy doAction).
          if (editing) {
            const ta = draftRef.current;
            if (ta) {
              await apiPost(`/api/actions/${encodeURIComponent(id)}/edit`, { draft: ta.value });
              setEditing(false);
            }
          }
          const res = await apiPost<ApproveResult>(`/api/actions/${encodeURIComponent(id)}/approve`, {});
          // Clear busy now that the result is known — busy takes priority over
          // `done` in subActionRow, so leaving it set through the delay below
          // masked the check-draw animation entirely (spinner straight to gone).
          setApprovingId(null);
          let succeeded = false;
          if (!res.ok && res.conflicts) {
            toast(`Conflict with ${res.conflicts.length} event(s) — pick another time`, true);
          } else if (res.awaitingManual) {
            toast("Draft created — awaiting your send");
          } else {
            succeeded = true;
            // Let the check-draw animation play before the refresh removes the
            // card — mirrors the "done" action pattern below so approve
            // doesn't feel like it vanished mid-transition.
            setDoneAnim((prev) => new Set(prev).add(id));
            toast("Sent");
            await new Promise((r) => setTimeout(r, 700));
          }
          setSelectedId(null);
          setEditCardId(null); // return to the task view
          await refresh();
          if (succeeded) {
            setDoneAnim((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          }
        } finally {
          setApprovingId(null);
        }
      } else if (act === "edit") {
        setEditing(true);
      } else if (act === "save-edit") {
        const ta = draftRef.current;
        await apiPost(`/api/actions/${encodeURIComponent(id)}/edit`, { draft: ta?.value });
        setEditing(false);
        await refresh();
        setSelectedId(id);
      } else if (act === "skip") {
        // P0: skipping asks WHY — one click on a reason completes the skip.
        setSkipFields([]);
        setSkipNote("");
        setSkipFor(id);
      } else if (act === "skip-reason") {
        const existence = arg;
        const idx = selectableIds(allClusters).indexOf(id);
        await apiPost(`/api/actions/${encodeURIComponent(id)}/skip`, {
          existence,
          field_errors: skipFields,
          // Only when actually typed, so the common one-click path sends the
          // same body it always did.
          ...(skipNote.trim() ? { note: skipNote.trim() } : {}),
        });
        setSkipFor(null);
        // Select the card that took the skipped one's place. `refresh`
        // returns the fresh payload — the `state` binding here is still the
        // pre-skip snapshot.
        const fresh = await refresh();
        const next = fresh ? selectableIds(fresh.clusters ?? []) : [];
        setSelectedId(next.length ? (next[Math.min(idx, next.length - 1)] ?? null) : null);
        setEditCardId(null); // return to the task view
      } else if (act === "comment") {
        setCommentText("");
        setCommentFor(id);
      } else if (act === "comment-submit") {
        if (!commentText.trim()) return;
        await apiPost(`/api/actions/${encodeURIComponent(id)}/comment`, { text: commentText.trim() });
        // Clear the box but KEEP the panel open: adding a second thought is the
        // normal case, and it is what the restore → re-skip loop was for.
        setCommentText("");
        await refresh();
        setSelectedId(id);
      } else if (act === "comment-cancel") {
        setCommentFor(null);
        setCommentText("");
      } else if (act === "skip-cancel") {
        setSkipFor(null);
      } else if (act === "mark-sent") {
        await apiPost(`/api/actions/${encodeURIComponent(id)}/mark-sent`, {});
        setSelectedId(null);
        await refresh();
        toast("Marked sent");
      } else if (act === "done") {
        // A Me · reminder sub-action (task/ignore): executed with a local
        // receipt, no send, no missing-info gate.
        await apiPost(`/api/actions/${encodeURIComponent(id)}/done`, {});
        setSelectedId(null);
        setEditCardId(null);
        // Let the check-draw animation play before the refresh removes the
        // card from the live list — otherwise it vanishes mid-draw.
        await new Promise((r) => setTimeout(r, 800));
        await refresh();
        setDoneAnim((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        toast("Marked done");
      } else if (act === "copy") {
        const a = allLiveActions(allClusters).find(({ action }) => action.id === id)?.action;
        if (a && a.draft) {
          await navigator.clipboard.writeText(a.draft);
          toast("Copied — paste into WeChat");
        }
      }
    } catch (e) {
      toast(errMsg(e), true);
    }
  }

  async function setTaskTier(key: string, tier: string) {
    try {
      await apiPost(`/api/tasks/${encodeURIComponent(key)}/tier`, { tier });
      setSelectedTaskId(key); // keep it selected after it moves
      await refresh();
      toast(`Moved to ${tier}`);
    } catch (e) {
      toast(errMsg(e), true);
    }
  }

  async function restore(id: string) {
    try {
      await apiPost(`/api/actions/${encodeURIComponent(id)}/restore`, {});
      await refresh();
      toast("Restored to queue");
    } catch (e) {
      toast(errMsg(e), true);
    }
  }

  // ─── render pieces (function-call style, per the header comment) ──

  // One task card in the Today list.
  // A conversation, rendered as one. The old view printed the raw
// "U07VD53V7M3: text" lines the reader produced — no name, no time, no sense of
// who is speaking. Cards written before the reader carried structure fall back
// to that string, so both paths stay supported.
function Transcript({ messages }: { messages: TranscriptMessage[] }) {
  return (
    <div className="mt-2 flex flex-col gap-0.5">
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        // Slack's grouping rule: consecutive messages from the same speaker
        // within a few minutes lose the repeated header. Without this a burst
        // of one-line messages reads as ten separate people.
        const grouped =
          !!prev &&
          prev.self === m.self &&
          prev.speaker === m.speaker &&
          !!m.at &&
          !!prev.at &&
          m.at - prev.at < 5 * 60 * 1000;
        return (
          <div key={i} className={cn("flex gap-2", grouped ? "mt-0" : "mt-2.5")}>
            <div className="w-6 flex-shrink-0">
              {!grouped && <Avatar label={m.speaker} hueKey={m.speaker} size={24} />}
            </div>
            <div className="min-w-0 flex-1">
              {!grouped && (
                <div className="flex items-baseline gap-2">
                  <span className="text-label-sm text-on-surface font-medium">{m.speaker}</span>
                  {m.at > 0 && (
                    <time
                      className="text-label-xs text-on-surface-variant"
                      dateTime={new Date(m.at).toISOString()}
                    >
                      {new Date(m.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    </time>
                  )}
                  {m.threadReply && (
                    <span className="text-label-xs text-on-surface-variant opacity-70">in thread</span>
                  )}
                </div>
              )}
              <div
                className={cn(
                  // Regular weight, like Slack's message body. text-body-medium
                  // is 500 and made a whole transcript read as emphasis.
                  "text-body-base text-on-surface whitespace-pre-wrap break-words",
                  isChinese(m.text) && "font-chinese",
                )}
              >
                {m.text}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function renderTaskCard(c: TaskCluster, tierMeta: (typeof TIERS)[number] | null) {
    const key = taskKey(c);
    const selected = key === selectedTaskId && !editCardId;
    const title = c.title || (c.actions[0] && (c.actions[0].headline || c.actions[0].reason)) || "Task";
    const why = c.plan?.why || "";
    const calAction = c.actions.find((a) => a.action_type === "calendar");
    const calLine = calAction ? calendarTimeLine(calAction) : "";
    const proj = c.actions.find((a) => a.project_id && a.project_id !== "MISC")?.project_id;
    // Status tag from the members: needs-info > awaiting > ready > brief.
    const anyNeeds = c.actions.some((a) => a.status === "suggested" && a.missing_info && a.missing_info.length);
    const anyAwait = c.actions.some((a) => a.status === "approved");
    const anyReady = c.actions.some(
      (a) => a.status === "suggested" && !(a.missing_info && a.missing_info.length),
    );
    const tag = anyNeeds
      ? { t: "Needs info", cls: "text-amber-600 bg-amber-50 dark:bg-amber-950" }
      : anyAwait
        ? { t: "Awaiting", cls: "text-emerald-600 bg-emerald-50 dark:bg-emerald-950" }
        : anyReady
          ? { t: "Ready", cls: "text-primary bg-primary/10" }
          : { t: "Brief", cls: "text-on-surface-variant bg-surface-variant" };
    const leftBorder = tierMeta
      ? { A: "border-l-red-500", B: "border-l-amber-500", C: "border-l-primary", D: "border-l-slate-400" }[
          tierMeta.tier
        ]
      : "border-l-slate-300";
    return (
      <motion.div
        key={key}
        layout
        initial={{ opacity: 0, x: 14 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: 14 }}
        transition={{ duration: 0.2 }}
        ref={(el) => {
          if (el) cardRefs.current.set(key, el);
          else cardRefs.current.delete(key);
        }}
        data-task={key}
        draggable
        onClick={() => selectTask(key)}
        onDragStart={(e) => {
          // This is a motion.div, so framer types onDragStart as ITS gesture
          // handler (PointerEvent) — but `draggable` means the browser fires a
          // real HTML5 dragstart, which does carry dataTransfer. The cast says
          // which of the two this actually is.
          const dt = (e as unknown as React.DragEvent).dataTransfer;
          dt.setData("text/plain", key);
          dt.effectAllowed = "move";
          setDragKey(key);
        }}
        onDragEnd={() => setDragKey(null)}
        className={cn(
          "task-card relative border border-l-[3px] rounded-xl p-4 cursor-pointer",
          leftBorder,
          // Legacy's selected card + drop highlight used hard-coded blue-50;
          // the semantic equivalent is primary/10 (tracks the theme).
          selected ? "bg-primary/10 border-primary/40" : "bg-surface border-outline hover:bg-surface-variant",
          dragKey === key && "opacity-40",
        )}
      >
        <div className="flex items-start justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-2 min-w-0">
            {proj && (
              <span className="text-[11px] font-mono text-on-surface-variant bg-surface-variant px-2 py-0.5 rounded flex-shrink-0">
                {proj}
              </span>
            )}
            <h3
              className={cn(
                "text-body-medium text-on-surface font-medium truncate",
                isChinese(title) && "font-chinese",
              )}
            >
              {title}
            </h3>
          </div>
          <span className={cn("text-[10px] uppercase tracking-wide px-1.5 py-px rounded-full flex-shrink-0", tag.cls)}>
            {tag.t}
          </span>
        </div>
        {why && (
          <p
            className={cn(
              "text-on-surface-variant text-label-sm line-clamp-2 mb-2",
              isChinese(why) && "font-chinese",
            )}
          >
            {why}
          </p>
        )}
        {calLine && (
          <div className="flex items-center gap-1 text-on-surface-variant text-label-xs mb-2">
            <Calendar size={14} strokeWidth={1.75} />
            <span>{calLine}</span>
          </div>
        )}
        <div className="flex items-center justify-between text-on-surface-variant text-label-xs">
          <div className="flex items-center gap-1">
            <ListChecks size={14} strokeWidth={1.75} />
            <span>
              {c.done}/{c.total} steps
            </span>
          </div>
          <div className="flex items-center gap-1" title="AI last updated this card">
            <RefreshCw size={14} strokeWidth={1.75} />
            <span>Updated {timeAgo(clusterRecency(c))}</span>
          </div>
        </div>
      </motion.div>
    );
  }

  // Provenance div (empty string → nothing, like legacy).
  function renderProvenance(a: QueueAction) {
    const line = provenanceLine(a);
    if (!line) return null;
    return <div className="text-label-sm text-on-surface-variant mb-4">{line}</div>;
  }

  // One resolution-plan row (a task's member card as a sub-action).
  function subActionRow(a: QueueAction) {
    const needs = !!(a.missing_info && a.missing_info.length > 0);
    // `done` includes the optimistic post-click state so the check-draw plays
    // while the card is still on screen (refresh is delayed in doAction).
    const completed = a.status === "executed";
    const done = completed || doneAnim.has(a.id);
    const busy = approvingId === a.id;
    // While THIS client's own approve() for this id is still in flight, the
    // background state poll can race in the mid-execution "approved" claim
    // persisted by markExecuting (execute.ts) before the tool call resolves —
    // without this guard the row would flash "Mark sent" for a card that's
    // actually mid-execution, not awaiting a manual send.
    const approved = !busy && a.status === "approved";
    const text = a.headline || (a.params && a.params.title) || a.reason || a.action_type;
    const ex = execLabel(a);
    const checked = done || approved;
    let control: React.ReactNode;
    if (busy) {
      // Keep the SAME button (size/color/position) as the default branch below
      // — just disabled with a spinner swapped in for the icon. Swapping to an
      // unrelated small gray span here made the button appear to vanish on
      // click with no visible feedback until "done" popped in afterward.
      control = (
        <button
          type="button"
          disabled
          className="approve-sub text-label-xs text-white bg-primary px-2.5 py-1 rounded flex items-center gap-1 disabled:opacity-60 disabled:cursor-wait"
        >
          <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />
          AI · {ex.label}
        </button>
      );
    } else if (done) {
      control = (
        <span className="text-label-xs text-on-surface-variant flex items-center gap-1">
          <CheckCheck size={14} strokeWidth={1.75} />
          {ex.assignee === "ai" ? "AI" : "Me"}
        </span>
      );
    } else if (approved) {
      // awaitingManual: a Gmail draft or a WeChat clipboard paste. The row
      // links to Gmail drafts when applicable and ALWAYS offers Mark sent —
      // otherwise the user could never finish the card from the task view.
      const gmail = a.target?.platform === "gmail";
      control = (
        <div className="flex items-center gap-2">
          {gmail ? (
            <a
              href="https://mail.google.com/mail/u/0/#drafts"
              target="_blank"
              rel="noreferrer"
              title="Open Gmail drafts"
              className="text-label-xs text-emerald-600 flex items-center gap-1 hover:underline"
            >
              <MailOpen size={14} strokeWidth={1.75} />
              Awaiting your send
            </a>
          ) : (
            <span className="text-label-xs text-emerald-600 flex items-center gap-1">
              <MailOpen size={14} strokeWidth={1.75} />
              Awaiting your send
            </span>
          )}
          <button
            type="button"
            className="text-label-xs bg-primary text-white px-2 py-0.5 rounded hover:bg-blue-700"
            onClick={(e) => {
              e.stopPropagation();
              handleAct("mark-sent", a.id);
            }}
          >
            Mark sent
          </button>
        </div>
      );
    } else if (ex.assignee === "me") {
      control = (
        <span className="text-label-xs text-on-surface-variant flex items-center gap-1 bg-surface-variant px-2 py-1 rounded">
          <User size={14} strokeWidth={1.75} />
          Me · reminder
        </span>
      );
    } else if (needs) {
      control = (
        <span className="text-label-xs text-amber-600 flex items-center gap-1 bg-amber-50 dark:bg-amber-950 px-2 py-1 rounded">
          <CircleHelp size={14} strokeWidth={1.75} />
          Needs info
        </span>
      );
    } else {
      control = (
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="approve-sub text-label-xs text-white bg-primary hover:bg-blue-700 px-2.5 py-1 rounded flex items-center gap-1"
            onClick={(e) => {
              e.stopPropagation();
              handleAct("approve", a.id);
            }}
          >
            {(() => {
              const Icon = ex.icon;
              return <Icon size={14} strokeWidth={1.75} />;
            })()}
            AI · {ex.label}
          </button>
          {a.draft != null && (
            <button
              type="button"
              className="text-label-xs text-primary hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                handleEdit(a.id);
              }}
            >
              Edit
            </button>
          )}
        </div>
      );
    }
    // A "Me · reminder" (task/ignore) row completes with NO side effect, so
    // its circle is a real button: click → mark done. Send-type rows use
    // their button instead; done/approved rows show a static state.
    const checkable = !done && !approved && ex.assignee === "me";
    const circle = checkable ? (
      <motion.button
        type="button"
        whileTap={{ scale: 0.8 }}
        className="mt-0.5 p-1 -m-1 text-on-surface-variant hover:text-primary cursor-pointer transition-colors"
        title="Mark done"
        onClick={(e) => {
          e.stopPropagation();
          if (doneAnim.has(a.id)) return;
          // Optimistic: draw the check NOW, refresh comes after the animation
          // (doAction delays it) so the card doesn't vanish mid-draw.
          setDoneAnim((prev) => new Set(prev).add(a.id));
          void doAction("done", undefined, a.id);
        }}
      >
        <Circle size={20} strokeWidth={1.75} />
      </motion.button>
    ) : checked ? (
      <span className="mt-0.5 inline-flex text-primary">
        <CheckPop />
      </span>
    ) : (
      // A suggested non-task card (calendar/reply/relay) isn't "done"-able —
      // show a muted ACTION-TYPE icon instead of a pretend-button circle.
      <span className="mt-0.5 inline-flex text-on-surface-variant opacity-40" aria-hidden="true">
        {(() => {
          const Icon = actionTypeIcon(a);
          return <Icon size={16} strokeWidth={1.75} />;
        })()}
      </span>
    );
    // Per-row skip: a task with several sub-actions must let you drop ONE of
    // them, not just whichever the footer happens to target.
    const rowSkip =
      a.status === "suggested" ? (
        <button
          type="button"
          className="text-label-xs text-on-surface-variant hover:text-on-surface flex-shrink-0"
          title="Skip just this one (asks why)"
          onClick={(e) => {
            e.stopPropagation();
            handleAct("skip", a.id);
          }}
        >
          Skip
        </button>
      ) : null;
    return (
      <div
        key={a.id}
        className={cn(
          "flex items-start gap-3 p-4 bg-surface border border-outline rounded-xl",
          // dim only the truly-executed rows — a just-clicked one stays full
          // opacity so the check-draw animation is clearly visible
          completed && "opacity-60",
        )}
      >
        {circle}
        <div className="flex-1 min-w-0">
          <p
            className={cn(
              "text-body-medium",
              done ? "text-on-surface-variant line-through" : "text-on-surface",
              isChinese(text) && "font-chinese",
            )}
          >
            {text}
          </p>
          {a.action_type === "calendar" && (
            <div className="mt-1 flex items-center gap-2 text-label-xs flex-wrap">
              <span className="text-on-surface-variant inline-flex items-center gap-1">
                <Calendar size={12} strokeWidth={1.75} />
                {calendarTimeLine(a)}
              </span>
              {conflictBadge(conflictState[a.id])}
              {!completed && (
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    setReTimeFor(reTimeFor === a.id ? null : a.id);
                    if (reTimeFor !== a.id) setReTimeText("");
                  }}
                >
                  {reTimeFor === a.id ? "Cancel" : "Re-time"}
                </button>
              )}
            </div>
          )}
          {reTimeFor === a.id && (
            <div className="mt-2 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
              <input
                value={reTimeText}
                onChange={(e) => setReTimeText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitReTime(a.id);
                }}
                placeholder='e.g. "move to 8/7 15:00-16:00" or "extend by 30 min"'
                aria-label="re-time instruction"
                className="flex-1 min-w-0 text-label-sm bg-primary/5 border border-outline rounded px-2 py-1 text-on-surface"
              />
              <button
                type="button"
                disabled={reTimeBusy || !reTimeText.trim()}
                className="text-label-sm bg-primary text-white px-2.5 py-1 rounded hover:bg-blue-700 disabled:opacity-40"
                onClick={() => void submitReTime(a.id)}
              >
                {reTimeBusy ? "Applying…" : "Apply"}
              </button>
            </div>
          )}
          {a.action_type === "tool" && (
            <div className="mt-1 flex items-center gap-2 text-label-xs text-on-surface-variant flex-wrap">
              <span className="inline-flex items-center gap-1">
                <Wrench size={12} strokeWidth={1.75} />
                {toolLine(a)}
              </span>
              <label className="inline-flex items-center gap-1">
                <span className="text-on-surface-variant">via</span>
                <select
                  value={a.params?.tool ?? ""}
                  aria-label="processing tool"
                  onChange={(e) => void setTool(e.target.value, a.id)}
                  className="bg-surface border border-outline rounded px-1 py-0.5 text-label-xs text-on-surface"
                >
                  {toolOptions.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {renderProvenance(a)}
                    {(a.context?.original_transcript?.length || a.context?.original_message) && (
            <details className="mt-2">
              <summary className="text-label-sm text-on-surface-variant cursor-pointer select-none">
                Show original
              </summary>
              {a.context.original_transcript?.length ? (
                <Transcript messages={a.context.original_transcript} />
              ) : (
                <p
                  className={cn(
                    "mt-1.5 text-label-sm text-on-surface-variant whitespace-pre-wrap border-l-2 border-outline pl-3",
                    isChinese(a.context.original_message ?? "") && "font-chinese",
                  )}
                >
                  {a.context.original_message}
                </p>
              )}
            </details>
          )}
          <div className="mt-2">{control}</div>
        </div>
        {rowSkip}
      </div>
    );
  }

  function renderEntityCard(e: TaskEntity, i: number) {
    const icon = ENTITY_ICON[e.kind] || "🔖";
    return (
      <div key={i} className="bg-surface border border-outline rounded-xl p-4">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-lg">{icon}</span>
          <span className={cn("text-body-medium text-on-surface font-medium truncate", isChinese(e.label) && "font-chinese")}>
            {e.label}
          </span>
        </div>
        {e.value && (
          <p className={cn("text-body-base text-on-surface", isChinese(e.value) && "font-chinese")}>{e.value}</p>
        )}
        {e.source && (
          <p className={cn("text-label-xs text-on-surface-variant mt-1 truncate", isChinese(e.source) && "font-chinese")}>
            {e.source}
          </p>
        )}
      </div>
    );
  }

  // The skip-reason panel: one click on a reason completes the skip.
  // Annotate without deciding. Existing comments are listed so a second thought
  // is an APPEND, not a rewrite — which is the whole point: revising a note used
  // to require restoring the card and skipping it again.
  function commentPanel(a: QueueAction) {
    const existing = (a.params?.comments ?? []).filter((c) => typeof c?.text === "string");
    return (
      <div className="bg-surface border border-outline rounded-xl px-6 py-4" data-testid="comment-panel">
        <div className="flex items-center justify-between mb-3">
          <span className="text-label-sm text-on-surface-variant uppercase tracking-wider">
            Comment — feedback only, the card is not decided
          </span>
          <button
            type="button"
            className="text-label-sm text-on-surface-variant hover:text-on-surface"
            onClick={() => handleAct("comment-cancel", a.id)}
          >
            Close
          </button>
        </div>
        {existing.length > 0 && (
          <ul className="mb-3 flex flex-col gap-2">
            {existing.map((c, i) => (
              <li key={i} className="text-body-base text-on-surface bg-surface-variant rounded-lg px-3 py-2">
                <span className="text-label-sm text-on-surface-variant mr-2">
                  {c.at.slice(0, 16).replace("T", " ")}
                </span>
                {c.text}
              </li>
            ))}
          </ul>
        )}
        <textarea
          className="comment-text w-full bg-surface border border-outline rounded-lg px-3 py-2 text-body-base text-on-surface placeholder:text-on-surface-variant focus:border-primary/40 focus:outline-none"
          rows={3}
          maxLength={2000}
          placeholder="What is wrong, or right, about this card? (⌘/Ctrl+Enter to add)"
          value={commentText}
          onChange={(e) => setCommentText(e.target.value)}
          onKeyDown={(e) => {
            // Plain Enter must stay a newline — these are multi-line notes.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void handleAct("comment-submit", a.id);
            }
          }}
        />
        <div className="flex justify-end mt-2">
          <button
            type="button"
            className="bg-surface text-on-surface text-body-medium px-4 py-2 rounded border border-outline hover:bg-surface-variant disabled:opacity-40"
            disabled={!commentText.trim()}
            onClick={() => handleAct("comment-submit", a.id)}
          >
            Add comment
          </button>
        </div>
      </div>
    );
  }

  function skipReasonPanel(id: string) {
    return (
      <div className="bg-surface border border-outline rounded-xl px-6 py-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-label-sm text-on-surface-variant uppercase tracking-wider">
            Why are you skipping? (one click completes it)
          </span>
          <button
            type="button"
            className="text-label-sm text-on-surface-variant hover:text-on-surface"
            onClick={() => handleAct("skip-cancel", id)}
          >
            Cancel
          </button>
        </div>
        <div className="flex flex-wrap gap-2 mb-3">
          {SKIP_REASONS.map((r) => (
            <button
              key={r.key}
              type="button"
              className="text-body-base px-3 py-1.5 rounded-lg border border-outline hover:bg-primary/10 hover:border-primary/40 text-on-surface"
              title={r.hint || undefined}
              onClick={() => handleAct("skip-reason", id, r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="mb-3">
          <input
            type="text"
            className="skip-note w-full bg-surface border border-outline rounded-lg px-3 py-1.5 text-body-base text-on-surface placeholder:text-on-surface-variant focus:border-primary/40 focus:outline-none"
            placeholder="In your own words (optional) — sent with whichever reason you click; Enter files it as Other"
            maxLength={500}
            value={skipNote}
            onChange={(e) => setSkipNote(e.target.value)}
            onKeyDown={(e) => {
              // Enter is the escape hatch for "none of the six fit": it files
              // the skip as `other` carrying the text, so a reason that only
              // makes sense in prose still gets recorded instead of lost.
              if (e.key === "Enter" && skipNote.trim()) {
                e.preventDefault();
                void handleAct("skip-reason", id, "other");
              }
            }}
          />
        </div>
        <div className="flex items-center gap-3 text-label-sm text-on-surface-variant border-t border-outline pt-3">
          <span>Also flag wrong fields (optional):</span>
          {SKIP_FIELDS.map((f) => (
            <label key={f.key} className="flex items-center gap-1 cursor-pointer hover:text-on-surface">
              <input
                type="checkbox"
                className="skip-field"
                value={f.key}
                checked={skipFields.includes(f.key)}
                onChange={() =>
                  setSkipFields((prev) => (prev.includes(f.key) ? prev.filter((k) => k !== f.key) : [...prev, f.key]))
                }
              />
              <span>{f.label}</span>
            </label>
          ))}
        </div>
      </div>
    );
  }

  function renderTaskDetail(c: TaskCluster) {
    const title = c.title || (c.actions[0] && (c.actions[0].headline || c.actions[0].reason)) || "Task";
    const plan: TaskPlan | undefined = c.plan;
    const tierMeta = plan
      ? {
          A: { cls: "text-red-600 bg-red-50 dark:bg-red-950", dot: "bg-red-500", label: "A · Do first" },
          B: { cls: "text-amber-600 bg-amber-50 dark:bg-amber-950", dot: "bg-amber-500", label: "B · Today" },
          C: { cls: "text-primary bg-primary/10", dot: "bg-primary", label: "C · This week" },
          D: { cls: "text-on-surface-variant bg-surface-variant", dot: "bg-slate-400", label: "D · Later" },
        }[plan.tier]
      : null;
    const proj = c.actions.find((a) => a.project_id && a.project_id !== "MISC")?.project_id;
    // Context = the digest only (the raw thread quote is noise).
    const primary = c.actions.find((a) => a.summary) || c.actions[0];
    const entities = plan?.entities || [];
    const { readyCard, skipTarget } = footerTargets(c, approvingId);
    // The reason panel belongs to whichever card was clicked — the footer's
    // Skip OR any row's — so a multi-card task can skip a specific sub-action.
    const pendingSkip = skipFor ? c.actions.find((a) => a.id === skipFor) : null;
    const pendingComment = commentFor ? c.actions.find((a) => a.id === commentFor) : null;

    return (
      <div className="w-full max-w-[800px]" data-testid="task-detail">
        <header className="mb-6">
          <div className="flex items-center gap-3 mb-3 flex-wrap">
            {tierMeta && (
              <span className={cn("flex items-center gap-1.5 text-label-sm px-2.5 py-1 rounded-full uppercase", tierMeta.cls)}>
                <span className={cn("w-1.5 h-1.5 rounded-full", tierMeta.dot)} />
                {tierMeta.label}
              </span>
            )}
            {proj && (
              <span className="text-[11px] font-mono text-on-surface-variant bg-surface-variant px-2.5 py-1 rounded">
                {proj}
              </span>
            )}
            <span
              className="flex items-center gap-1 text-label-xs text-on-surface-variant ml-auto"
              title="AI last updated this card"
            >
              <RefreshCw size={14} strokeWidth={1.75} />
              Updated {timeAgo(clusterRecency(c))}
            </span>
          </div>
          <h1 data-testid="detail-title" className={cn("text-display text-on-surface mb-2", isChinese(title) && "font-chinese")}>
            {title}
          </h1>
          {primary && renderProvenance(primary)}
          {plan?.why && (
            <p
              className={cn(
                "text-body-lg font-medium",
                plan.tier === "A" ? "text-red-600" : "text-on-surface-variant",
                isChinese(plan.why) && "font-chinese",
              )}
            >
              {plan.why}
            </p>
          )}
        </header>

        {primary?.summary && (
          <section className="bg-surface border border-outline rounded-xl p-5 mb-6">
            <h2 className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-3 flex items-center gap-2">
              <Info size={16} strokeWidth={1.75} />
              Context
            </h2>
            <p className={cn("text-body-base text-on-surface leading-relaxed", isChinese(primary.summary) && "font-chinese")}>
              {primary.summary}
            </p>
            {(primary.context?.original_transcript?.length || primary.context?.original_message) && (
              <details className="mt-3">
                <summary className="text-label-sm text-on-surface-variant cursor-pointer select-none">
                  Show original
                </summary>
                {primary.context.original_transcript?.length ? (
                  <Transcript messages={primary.context.original_transcript} />
                ) : (
                  <p
                    className={cn(
                      "mt-2 text-body-medium text-on-surface-variant whitespace-pre-wrap border-l-2 border-outline pl-3",
                      isChinese(primary.context.original_message ?? "") && "font-chinese",
                    )}
                  >
                    {primary.context.original_message}
                  </p>
                )}
              </details>
            )}
          </section>
        )}

        <section className="mb-6">
          <h2 className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-3 flex items-center gap-2 px-1">
            <CircleCheck size={16} strokeWidth={1.75} />
            Resolution Plan
          </h2>
          <div className="flex flex-col gap-3">{c.actions.map(subActionRow)}</div>
        </section>

        {entities.length > 0 && (
          <section className="mb-6">
            <h2 className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-3 flex items-center gap-2 px-1">
              <Shapes size={16} strokeWidth={1.75} />
              Related Entities
            </h2>
            <div className="grid grid-cols-2 gap-3">{entities.map(renderEntityCard)}</div>
          </section>
        )}

        {pendingComment ? (
          commentPanel(pendingComment)
        ) : pendingSkip ? (
          skipReasonPanel(pendingSkip.id)
        ) : (
          <div className="flex items-center justify-between gap-4 bg-surface border border-outline rounded-xl px-6 py-4">
            <div className="flex gap-4">
              {readyCard ? (
                <>
                  <button
                    type="button"
                    disabled={approvingId === readyCard.id}
                    className="bg-primary text-white text-body-medium px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-60 flex items-center gap-2"
                    onClick={() => handleAct("approve", readyCard.id)}
                  >
                    {approvingId === readyCard.id ? (
                      <Loader2 size={18} strokeWidth={1.75} className="animate-spin" />
                    ) : (
                      (() => {
                        const Icon = execLabel(readyCard).icon;
                        return <Icon size={18} strokeWidth={1.75} />;
                      })()
                    )}
                    {execLabel(readyCard).label}
                  </button>
                  {readyCard.draft != null && (
                    <button
                      type="button"
                      className="bg-surface text-on-surface text-body-medium px-4 py-2 rounded border border-outline hover:bg-surface-variant"
                      onClick={() => handleEdit(readyCard.id)}
                    >
                      Edit
                    </button>
                  )}
                </>
              ) : (
                <span className="text-on-surface-variant text-body-base">
                  Nothing ready to send — review the steps.
                </span>
              )}
            </div>
            <div className="flex items-center gap-4">
              {skipTarget && (
                <button
                  type="button"
                  className="text-on-surface-variant text-body-medium hover:text-on-surface"
                  onClick={() => handleAct("comment", skipTarget.id)}
                >
                  Comment
                </button>
              )}
              {skipTarget && (
                <button
                  type="button"
                  className="text-on-surface-variant text-body-medium hover:text-on-surface"
                  onClick={() => handleAct("skip", skipTarget.id)}
                >
                  Skip
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  function handleEdit(id: string) {
    setEditCardId(id);
    setSelectedId(id);
    setEditing(true);
  }

  // The message block: the LLM summary as the digest (sender named), with the
  // raw original tucked behind a "Show original" expander. Legacy rows have
  // no summary → show the original directly.
  function msgBlock(a: QueueAction, sender: string) {
    const orig = a.context?.original_message;
    const card = (inner: React.ReactNode) => (
      <div className="bg-background rounded p-4 border border-outline border-l-4 border-l-slate-300 mb-6">
        <div className="text-label-sm font-bold text-on-surface mb-1">{sender}</div>
        {inner}
      </div>
    );
    if (a.summary) {
      return card(
        <>
          <p className={cn("text-body-base text-on-surface whitespace-pre-wrap", isChinese(a.summary) && "font-chinese")}>
            {a.summary}
          </p>
          {orig && (
            <details className="mt-2">
              <summary className="text-label-sm text-on-surface-variant cursor-pointer select-none">
                Show original
              </summary>
              <p className={cn("mt-1 text-body-medium text-on-surface-variant whitespace-pre-wrap", isChinese(orig) && "font-chinese")}>
                {orig}
              </p>
            </details>
          )}
        </>,
      );
    }
    if (orig) {
      return card(
        <p className={cn("text-body-base text-on-surface whitespace-pre-wrap", isChinese(orig) && "font-chinese")}>
          {orig}
        </p>,
      );
    }
    return null;
  }

  // The project this card advances; a MISC/unset card shows a muted chip.
  function projectBadge(a: QueueAction) {
    const pid = a.project_id;
    if (pid && pid !== "MISC") {
      const label = a.project_name || pid;
      return (
        <div className="mb-2">
          <span className={cn("inline-flex items-center gap-1 text-label-sm text-primary bg-primary/10 border border-primary/20 px-2.5 py-1 rounded-lg", isChinese(label) && "font-chinese")}>
            <Folder size={15} strokeWidth={1.75} />
            {label}
          </span>
        </div>
      );
    }
    return (
      <div className="mb-2">
        <span className="inline-flex items-center gap-1 text-label-sm text-on-surface-variant bg-surface-variant px-2.5 py-1 rounded-lg">
          <Inbox size={15} strokeWidth={1.75} />
          Misc
        </span>
      </div>
    );
  }

  // The single-card drill-in (edit mode lives here).
  function renderDetail(a: QueueAction) {
    const needsInfo = !!(a.missing_info && a.missing_info.length > 0);
    const sender = a.sender_name || a.context?.sender_handle || "?";
    const recipient = a.recipient_name || a.target?.personaKey || a.target?.platform || "—";
    // See subActionRow's `approved` guard: exclude a card this client is
    // itself mid-approving, or a background poll landing on the transient
    // "approved" claim (markExecuting, execute.ts) shows the awaiting-manual
    // UI for a card that's actually still executing.
    const isManual = a.status === "approved" && approvingId !== a.id;
    const platIcon: LucideIcon =
      { gmail: Mail, slack: Hash, wechat: MessageSquare, calendar: Calendar }[a.target?.platform ?? ""] || Zap;
    const title = a.headline || (a.params && a.params.title) || a.reason || a.action_type;

    const draftBlock =
      a.draft != null ? (
        editing ? (
          <textarea
            id="draft-edit"
            ref={draftRef}
            defaultValue={a.draft}
            className={cn(
              "w-full min-h-[140px] bg-primary/5 rounded-lg p-4 border border-primary/20 text-body-base text-on-surface",
              isChinese(a.draft) && "font-chinese",
            )}
          />
        ) : (
          <div className="relative bg-primary/5 rounded-lg p-4 border border-primary/20">
            <div className="absolute top-2 right-2 bg-surface border border-outline rounded-sm px-2 py-0.5 flex items-center gap-1 text-[10px]">
              <span className="font-bold text-primary">{isChinese(a.draft) ? "中文" : "EN"}</span>
              {a.params?._edited && <span className="text-on-surface-variant">· edited</span>}
            </div>
            <p className={cn("text-body-base text-on-surface pr-16 whitespace-pre-wrap", isChinese(a.draft) && "font-chinese")}>
              {a.draft}
            </p>
          </div>
        )
      ) : null;

    const primaryCls =
      "bg-primary text-white text-body-medium px-4 py-2 rounded hover:bg-blue-700 transition-colors flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed";
    const secondaryCls =
      "bg-surface text-on-surface text-body-medium px-4 py-2 rounded border border-outline hover:bg-surface-variant transition-colors";
    let actions: React.ReactNode;
    if (isManual) {
      const isGmail = a.target?.platform === "gmail";
      actions = (
        <div className="px-6 py-4 bg-surface-variant border-y border-outline flex items-center gap-4">
          {isGmail ? (
            <a
              href="https://mail.google.com/mail/u/0/#drafts"
              target="_blank"
              rel="noreferrer"
              className="text-body-medium text-primary hover:underline flex-1 inline-flex items-center gap-1.5"
            >
              Draft created — open Gmail to send
              <ExternalLink size={14} strokeWidth={1.75} />
            </a>
          ) : (
            <button type="button" className={cn(secondaryCls, "flex-1")} onClick={() => handleAct("copy", a.id)}>
              Copy
            </button>
          )}
          <button type="button" className={primaryCls} onClick={() => handleAct("mark-sent", a.id)}>
            <Check size={18} strokeWidth={1.75} /> Mark sent
          </button>
        </div>
      );
    } else {
      const approveBusy = approvingId === a.id;
      const approveLabel = approveBusy ? (
        <>
          <Loader2 size={18} strokeWidth={1.75} className="animate-spin" /> Approve
        </>
      ) : a.action_type === "reply" || a.action_type === "relay" || a.action_type === "forward" ? (
        <>
          <Send size={18} strokeWidth={1.75} /> Approve &amp; Send
        </>
      ) : (
        "Approve"
      );
      actions = (
        <div className="px-6 py-4 bg-surface-variant border-y border-outline flex items-center justify-between">
          <div className="flex gap-4">
            <button
              type="button"
              className={primaryCls}
              disabled={needsInfo || approveBusy}
              onClick={() => handleAct("approve", a.id)}
            >
              {approveLabel}
            </button>
            {editing ? (
              <button type="button" className={secondaryCls} onClick={() => handleAct("save-edit", a.id)}>
                Save
              </button>
            ) : (
              a.draft != null && (
                <button type="button" className={secondaryCls} onClick={() => handleAct("edit", a.id)}>
                  Edit
                </button>
              )
            )}
          </div>
          <button
            type="button"
            className="text-on-surface-variant text-body-medium hover:text-on-surface transition-colors"
            onClick={() => handleAct("skip", a.id)}
          >
            Skip
          </button>
        </div>
      );
    }

    return (
      <div className="bg-surface border border-outline rounded w-full max-w-[800px] h-fit flex flex-col">
        <div className="p-6">
          {needsInfo && (
            <div className="mb-4 bg-amber-50 dark:bg-amber-950 border border-amber-200 rounded p-4 text-label-sm text-amber-700 dark:text-amber-400">
              Needs info:{" "}
              {a.missing_info!.map((m) => (
                <span key={m} className="bg-surface border border-amber-200 rounded-sm px-2 py-0.5 mr-1">
                  {m}
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 mb-4 text-on-surface-variant">
            <Avatar label={sender} hueKey={sender} />
            <ArrowRight size={16} strokeWidth={1.75} />
            {(() => {
              const Icon = platIcon;
              return <Icon size={16} strokeWidth={1.75} />;
            })()}
            <ArrowRight size={16} strokeWidth={1.75} />
            <Avatar label={String(recipient)} hueKey={String(recipient)} />
            <span className="ml-auto text-label-xs uppercase tracking-wide text-on-surface-variant bg-surface-variant px-2 py-0.5 rounded-xl">
              {a.action_type}
            </span>
          </div>
          {projectBadge(a)}
          <h2 className={cn("text-display mb-4", isChinese(title) && "font-chinese")}>{title}</h2>
          {renderProvenance(a)}
          {msgBlock(a, sender)}
          {a.next_actions && a.next_actions.length > 0 && (
            <div className="mb-6 bg-primary/5 border border-primary/20 rounded-lg p-4">
              <h3 className="text-label-sm text-primary font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Zap size={18} strokeWidth={1.75} /> Action Items
              </h3>
              <ul className="flex flex-col gap-2">
                {a.next_actions.map((t, i) => (
                  <li key={i} className={cn("flex items-start gap-2 text-body-base text-on-surface", isChinese(t) && "font-chinese")}>
                    <ArrowRight size={18} strokeWidth={1.75} className="text-primary flex-shrink-0" />
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {draftBlock && (
            <div>
              <h3 className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-2">Draft</h3>
              {draftBlock}
            </div>
          )}
        </div>
        {actions}
      </div>
    );
  }

  // Completed + skipped history drawer: two sections inside one collapsed
  // <details>. Restore is offered only when undo is safe (local receipts and
  // no-receipt rows, never a real sent/calendar_event side effect).
  function renderDrawer() {
    if (!state) return null;
    const done = state.done ?? [];
    const skipped = state.skipped ?? [];
    if (!done.length && !skipped.length) return null;
    const rowTitle = (a: QueueAction) => a.headline || (a.params && a.params.title) || a.summary || a.reason || a.action_type;
    const row = (a: QueueAction, tail: React.ReactNode) => {
      const t = rowTitle(a);
      return (
        <div key={a.id} className="flex items-center gap-2 py-1.5 text-label-sm">
          <span className="text-on-surface-variant uppercase tracking-wide text-[10px] flex-shrink-0">
            {a.action_type}
          </span>
          <span className={cn("text-on-surface-variant truncate flex-1", isChinese(t) && "font-chinese")} title={t}>
            {t}
          </span>
          {tail}
        </div>
      );
    };
    const restoreBtn = (a: QueueAction) => (
      <button
        type="button"
        className="text-primary hover:underline flex-shrink-0"
        onClick={() => void restore(a.id)}
      >
        Restore
      </button>
    );
    const DONE_CAP = 50;
    const doneShown = done.slice(-DONE_CAP).reverse(); // newest first
    const doneRows = doneShown.map((a) => {
      const receipt = a.params?.execution_receipt;
      const restorable = !receipt || receipt.kind === "local";
      const when = receipt?.at ? new Date(receipt.at) : null;
      return row(
        a,
        <>
          {when && !isNaN(when.getTime()) && (
            <span className="text-on-surface-variant flex-shrink-0">{fmtWhen(when)}</span>
          )}
          {restorable && restoreBtn(a)}
        </>,
      );
    });
    return (
      <details className="mt-6 border-t border-outline pt-2">
        <summary className="text-label-sm text-on-surface-variant cursor-pointer select-none">
          Completed ({done.length}) · Skipped ({skipped.length})
        </summary>
        {done.length > 0 && (
          <div className="mt-2">
            <div className="text-label-sm text-on-surface-variant uppercase tracking-wide mb-1">Completed</div>
            {doneRows}
            {done.length > DONE_CAP && (
              <div className="py-1.5 text-label-sm text-on-surface-variant">…and {done.length - DONE_CAP} more</div>
            )}
          </div>
        )}
        {skipped.length > 0 && (
          <div className="mt-2">
            <div className="text-label-sm text-on-surface-variant uppercase tracking-wide mb-1">Skipped</div>
            {skipped.map((a) => row(a, restoreBtn(a)))}
          </div>
        )}
      </details>
    );
  }

  // ─── screen layout ────────────────────────────────────────────────

  const attention = clusters.filter((c) => ["A", "B"].includes(c.plan?.tier ?? "")).length;
  const header = (
    <header className="p-6 pb-4 border-b border-outline flex-shrink-0">
      <h1 className="text-headline text-on-surface">Today</h1>
      <p className="text-on-surface-variant text-body-base mt-1">
        {attention} item{attention === 1 ? "" : "s"} requiring attention · {clusters.length} task
        {clusters.length === 1 ? "" : "s"}
      </p>
    </header>
  );

  if (state && clusters.length === 0) {
    return (
      <>
        {header}
        <div className="flex-1 flex flex-col items-center justify-center text-on-surface-variant gap-1">
          <div className="text-display text-on-surface">All handled.</div>
          <div className="text-body-base">
            {(state.done ?? []).length} auto-handled · {(state.skipped ?? []).length} skipped
          </div>
          <div className="w-full max-w-[440px] mt-6 px-4">{renderDrawer()}</div>
        </div>
      </>
    );
  }

  // Detail: an Edit drill-in shows the single-card editor; else the task view.
  // detailKey gives AnimatePresence a stable identity per distinct view so
  // switching away from a just-approved single-action task crossfades
  // instead of snapping straight to another task or the empty state.
  let detail: React.ReactNode;
  let detailKey: string;
  if (editCardId) {
    const card = allLiveActions(allClusters).find(({ action }) => action.id === editCardId)?.action;
    detailKey = card ? `edit-${editCardId}` : "edit-gone";
    detail = card ? (
      <div className="w-full max-w-[800px]">
        <button
          type="button"
          className="text-label-sm text-primary mb-2 flex items-center gap-1"
          onClick={() => {
            setEditCardId(null);
            setEditing(false);
          }}
        >
          <ArrowLeft size={16} strokeWidth={1.75} />
          Back to task
        </button>
        {renderDetail(card)}
      </div>
    ) : (
      <div className="text-on-surface-variant">Card gone.</div>
    );
  } else {
    const sel = selectedCluster();
    detailKey = sel ? `task-${taskKey(sel)}` : "empty";
    detail = sel ? (
      renderTaskDetail(sel)
    ) : (
      <div className="flex-1 flex items-center justify-center text-on-surface-variant text-body-base">
        Select a task.
      </div>
    );
  }

  return (
    <>
      {header}
      <div className="flex-1 flex overflow-hidden">
        <div className="w-[400px] flex-shrink-0 border-r border-outline bg-surface overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden p-4">
          {TIERS.map((t, i) => (
            <section key={t.tier} className="mb-6">
              <div className="flex items-center gap-2 mb-3 px-1">
                <div className={cn("w-2 h-2 rounded-full", t.dot)} />
                <h2 className="text-label-sm text-on-surface-variant uppercase tracking-wider">{t.label}</h2>
              </div>
              {/* All four tiers render (even empty) so every one is a drop
                  target — drag a mis-ranked card into another section. */}
              <div
                data-drop-tier={t.tier}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropTier(t.tier);
                }}
                onDragLeave={() => setDropTier(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDropTier(null);
                  const key = e.dataTransfer.getData("text/plain");
                  if (key) void setTaskTier(key, t.tier);
                }}
                className={cn(
                  "flex flex-col gap-2 rounded-lg p-1 -m-1 transition-colors",
                  dropTier === t.tier && "bg-primary/10 ring-1 ring-primary/40",
                )}
              >
                <AnimatePresence>
                  {tiered[i]!.length ? (
                    tiered[i]!.map((c) => renderTaskCard(c, t))
                  ) : (
                    <div className="text-label-xs text-on-surface-variant/50 italic px-1 py-2">drop here</div>
                  )}
                </AnimatePresence>
              </div>
            </section>
          ))}
          {unranked.length > 0 && (
            <section className="mb-6">
              <div className="flex items-center gap-2 mb-3 px-1">
                <div className="w-2 h-2 rounded-full bg-slate-300" />
                <h2 className="text-label-sm text-on-surface-variant uppercase tracking-wider">Unranked</h2>
              </div>
              <div className="flex flex-col gap-2">
                <AnimatePresence>{unranked.map((c) => renderTaskCard(c, null))}</AnimatePresence>
              </div>
            </section>
          )}
          <div className="pt-2">{renderDrawer()}</div>
        </div>
        {/* Padding lives on the SCROLLED child, not the scroll container. A
            flex container with overflow drops its trailing padding, so p-6 here
            meant the last card sat flush against the bottom edge with nothing
            to scroll into — the pane looked cut off and would not go further. */}
        {/* Two fixes for the detail pane jumping left and right on every card
            switch, which had two separate causes:

            1. During a crossfade BOTH panes are mounted, and as two in-flow
               children of a justify-center row they shared the width — so the
               incoming pane rendered off-centre and slid into place as the old
               one left. mode="popLayout" takes the outgoing pane out of flow,
               so the incoming one is centred from its first frame. Not
               mode="wait", which would fix it by making every switch wait out
               a fade first — latency traded for alignment.
            2. A tall card scrolls and a short one does not, and the scrollbar
               it adds narrows the pane. Reserving the gutter always keeps the
               centre line fixed whatever the content height. */}
        <div className="flex-1 bg-background overflow-y-auto [scrollbar-gutter:stable] relative flex justify-center">
          <AnimatePresence mode="popLayout">
            <motion.div
              key={detailKey}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="w-full flex justify-center p-6 pb-16"
            >
              {detail}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </>
  );
}
