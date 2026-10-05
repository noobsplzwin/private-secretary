// Phase A bootstrap (specs/persona-v3.md R7) — the deterministic parts:
// contact ranking (volume x recency) and resumable progress bookkeeping.
// Pure logic; fs lives in relay/io/bootstrap-progress.ts, MCP reads and
// persona generation live in the persona-bootstrap skill (Claude is the LLM).

export const DEFAULT_TOP_N = 20;

// ---------- ranking ----------

export interface ContactActivity {
  key?: string; // persona key if one exists
  handle: string; // platform handle used to gather counts
  display_name?: string;
  monthly_counts: Record<string, number>; // "YYYY-MM" -> messages in that month
}

export interface RankedContact {
  rank: number;
  handle: string;
  key?: string;
  display_name?: string;
  total: number;
  score: number;
}

export function monthIndex(month: string): number {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`bad month "${month}", expected YYYY-MM`);
  return Number(m[1]) * 12 + (Number(m[2]) - 1);
}

// Full weight for the last 12 months, linear decay to a 0.2 floor at 60
// months. Messages outside the history window never reach this function —
// the gatherer drops them entirely (not summarized, not counted).
export function recencyWeight(ageMonths: number): number {
  if (ageMonths <= 12) return 1;
  if (ageMonths >= 60) return 0.2;
  return 1 - (0.8 * (ageMonths - 12)) / 48;
}

export function scoreActivity(a: ContactActivity, nowMonth: string): number {
  const now = monthIndex(nowMonth);
  let score = 0;
  for (const [month, count] of Object.entries(a.monthly_counts)) {
    const age = Math.max(0, now - monthIndex(month));
    score += count * recencyWeight(age);
  }
  return score;
}

export function rankContacts(
  contacts: ContactActivity[],
  nowMonth: string,
): RankedContact[] {
  const scored = contacts.map((c) => ({
    handle: c.handle,
    ...(c.key ? { key: c.key } : {}),
    ...(c.display_name ? { display_name: c.display_name } : {}),
    total: Object.values(c.monthly_counts).reduce((s, n) => s + n, 0),
    score: Math.round(scoreActivity(c, nowMonth) * 100) / 100,
  }));
  scored.sort(
    (a, b) => b.score - a.score || b.total - a.total || a.handle.localeCompare(b.handle),
  );
  return scored.map((c, i) => ({ rank: i + 1, ...c }));
}

// ---------- progress (resumable, done = promoted) ----------

export type ContactStatus = "pending" | "staged" | "promoted" | "failed";

export interface ContactProgress {
  display_name?: string;
  status: ContactStatus;
  updated_at: string;
  error?: string;
}

export interface BootstrapProgress {
  version: 1;
  started_at: string;
  params: { contacts: string; history_years: number };
  contacts: Record<string, ContactProgress>;
}

export interface ProgressEntry {
  key: string;
  display_name?: string;
}

// (Re)initialize a run. Resumability rules (spec R7 + §6):
// - promoted = done, skipped on every later run (so top:20 then all = zero
//   duplicate processing) — UNLESS the key is in forceKeys (explicit list).
// - staged-but-not-promoted = incomplete -> back to pending (redone).
// - failed/pending -> pending.
export function initProgress(
  existing: BootstrapProgress | null,
  params: { contacts: string; history_years: number },
  entries: ProgressEntry[],
  now: string,
  forceKeys: string[] = [],
): BootstrapProgress {
  const force = new Set(forceKeys);
  const contacts: Record<string, ContactProgress> = { ...(existing?.contacts ?? {}) };
  for (const e of entries) {
    const cur = contacts[e.key];
    if (cur?.status === "promoted" && !force.has(e.key)) continue; // done stays done
    contacts[e.key] = {
      ...(e.display_name ? { display_name: e.display_name } : {}),
      status: "pending",
      updated_at: now,
    };
  }
  return {
    version: 1,
    started_at: existing?.started_at ?? now,
    params,
    contacts,
  };
}

export function nextPending(p: BootstrapProgress): string | null {
  for (const [key, c] of Object.entries(p.contacts))
    if (c.status === "pending") return key;
  return null;
}

export function markContact(
  p: BootstrapProgress,
  key: string,
  status: ContactStatus,
  now: string,
  error?: string,
): BootstrapProgress {
  const cur = p.contacts[key];
  if (!cur) throw new Error(`unknown contact in progress: ${key}`);
  const next: ContactProgress = { ...cur, status, updated_at: now };
  if (error) next.error = error;
  else delete next.error;
  return { ...p, contacts: { ...p.contacts, [key]: next } };
}

export function progressSummary(p: BootstrapProgress): Record<ContactStatus, number> {
  const sum: Record<ContactStatus, number> = {
    pending: 0,
    staged: 0,
    promoted: 0,
    failed: 0,
  };
  for (const c of Object.values(p.contacts)) sum[c.status]++;
  return sum;
}
