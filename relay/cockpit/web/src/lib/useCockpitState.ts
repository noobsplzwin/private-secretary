// useCockpitState — the shared /api/state feed every cockpit screen reads.
//
// Contract:
// - Fetches immediately on mount (once `enabled`), then re-polls every 15s
//   (the legacy SPA's cadence) until the component unmounts; the interval is
//   cleared and late responses are dropped on unmount, so nothing setStates a
//   dead component.
// - Returns { state, error, refresh }: `state` is the LAST SUCCESSFUL payload
//   (null until the first success), `error` the Error from the most recent
//   poll attempt (null whenever the last poll succeeded). A failed poll never
//   wipes good data — screens keep rendering the stale snapshot while
//   `error` says the feed is sick; the next success clears it.
// - `refresh()` forces an immediate refetch and resolves with the fresh
//   payload (null on failure). Callers that just mutated state via a POST
//   await it — mirroring legacy queue.js's `await refresh()` after every
//   action — and use the RETURNED payload for follow-up decisions, because
//   the `state` binding in their closure is still the pre-action snapshot.
//
// Poll guards (S5) — the two guards from legacy main.js's pollRefresh:
// 1. `pollGuard.editing`: set by the Queue screen while a draft edit is in
//    progress (legacy App.editing). A poll mid-edit would re-render and could
//    clobber the textarea.
// 2. A focused TEXTAREA/INPUT anywhere pauses the poll for the same reason.
// Both pause only the background poll; a manual refresh() always runs (legacy
// refresh() had no guards either). `pollGuard` is module-level because the
// feed lives in the App shell while the editing flag lives in the Queue
// screen — the same global split legacy had.
//
// Deliberate simplification vs legacy: public/js/main.js computed a
// stateSig() over the payload to skip re-rendering when nothing visible
// changed. React re-renders are cheap and this payload is small, so every
// successful poll simply sets state — no signature diffing.
import { createContext, useCallback, useEffect, useState } from "react";
import { apiGet } from "./api";

export interface TranscriptMessage {
  speaker: string;
  self: boolean;
  /** ms epoch; 0 when the reader had no timestamp. */
  at: number;
  text: string;
  threadReply?: boolean;
}

export interface SourceError {
  message: string;
  at: string; // ISO timestamp
}

// ─── /api/state payload (GET /api/state → CockpitState) ─────────────
// Typed to what the migrated screens read; field comments call out the
// non-obvious ones. The server attaches sender_name / recipient_name /
// project_name + unit_key / plan (relay/cockpit/api.ts getState).

export interface QueueAction {
  id: string;
  action_type: string; // reply | calendar | task | ignore | relay | forward
  status: string; // suggested | approved | executed | rejected
  headline?: string;
  reason?: string;
  summary?: string;
  draft?: string | null;
  params?: {
    title?: string;
    // calendar cards: RFC 3339 start/end of the proposed event (the Calendar
    // screen overlays these on the real Google Calendar week).
    start?: string;
    end?: string;
    location?: string;
    // tool cards: which MCP tool processes it + the tool-specific payload.
    tool?: string;
    project?: string;
    summary?: string;
    description?: string;
    assignee?: string;
    _edited?: boolean;
    execution_receipt?: { kind: string; at?: string };
    /**
     * Owner feedback left ON the card without deciding it (core/addComment).
     * Appended, never replaced — and it writes no label, so commenting cannot
     * move the precision numbers the way skipping-to-comment did.
     */
    comments?: Array<{ at: string; text: string }>;
  };
  target?: { platform?: string; personaKey?: string };
  context?: {
    original_message?: string;
    /** Structured form of the same conversation; absent on older cards. */
    original_transcript?: TranscriptMessage[];
    sender_handle?: string;
    sent_at?: string;
  };
  sender_name?: string;
  recipient_name?: string;
  missing_info?: string[];
  next_actions?: string[];
  created_at: string; // ISO
  project_id?: string;
  project_name?: string;
  source_message_id?: string;
}

export interface TaskEntity {
  kind: string; // flight | file | price | confirmation | deadline | person | doc | …
  label: string;
  value?: string;
  source?: string;
}

export interface TaskPlan {
  tier: "A" | "B" | "C" | "D";
  rank: number;
  why: string;
  entities?: TaskEntity[];
  tierManual?: boolean; // a manual drag overrode the computed tier
}

export interface TaskCluster {
  task_id: string | null;
  unit_key?: string; // unique per cluster; THE identity for select/re-tier
  title: string | null;
  actions: QueueAction[]; // ready → needs-info → approved → terminal
  plan?: TaskPlan;
  done: number; // members executed
  total: number; // members excluding rejected
}

export interface CockpitStateData {
  clusters?: TaskCluster[];
  suggested?: QueueAction[];
  awaitingManual?: QueueAction[];
  done?: QueueAction[]; // executed, chronological (frontend reverses for display)
  skipped?: QueueAction[]; // rejected
  sourceErrors?: Record<string, SourceError>;
  gate?: unknown;
  counts?: { pending: number; tasks: number; awaitingManual: number };
  // The effective MCP tool registry (built-ins + user config) — the Queue's
  // "via" picker lists these.
  tools?: Record<string, { label: string }>;
}

// See the header comment: the Queue screen's draft-edit flag, readable by the
// poll loop living up in the App shell.
export const pollGuard = { editing: false };

export interface CockpitFeed {
  state: CockpitStateData | null;
  error: Error | null;
  refresh: () => Promise<CockpitStateData | null>;
}

// The App shell mounts ONE feed and hands it down; a screen rendered outside
// the shell (tests) falls back to its own hook instance.
export const CockpitFeedContext = createContext<CockpitFeed | null>(null);

const POLL_MS = 15_000;

export function useCockpitState(opts?: { enabled?: boolean }): CockpitFeed {
  const enabled = opts?.enabled ?? true;
  const [state, setState] = useState<CockpitStateData | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async (): Promise<CockpitStateData | null> => {
    try {
      const data = await apiGet<CockpitStateData>("/api/state");
      setState(data);
      setError(null);
      return data;
    } catch (e) {
      // Keep `state` untouched: one failed tick must not blank the screen.
      setError(e instanceof Error ? e : new Error(String(e)));
      return null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // Initial fetch is unguarded (legacy boot always fetched); the interval
    // ticks carry legacy pollRefresh's two guards — never clobber an
    // in-progress edit or a focused input (that wiped what you were typing).
    async function guardedTick() {
      if (pollGuard.editing) return;
      const ae = document.activeElement;
      if (ae && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT")) return;
      await tick();
    }
    async function tick() {
      try {
        const data = await apiGet<CockpitStateData>("/api/state");
        if (cancelled) return;
        setState(data);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      }
    }
    void tick();
    const timer = setInterval(() => void guardedTick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);

  return { state, error, refresh };
}
