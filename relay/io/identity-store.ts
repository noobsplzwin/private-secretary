// Write side of identity.ts — the file a fresh install has no way to create
// without a terminal.
//
// Until this existed, `curl | bash` produced an instance that could not work:
// config/identity.json is gitignored (correctly — it names a person's
// accounts), so a clone has only the .example. With no identity the daemon
// polls nothing and the cockpit's Connect button is inert, because the Keychain
// account key it would write to is the empty string. Hand-editing JSON was the
// only way out, which is exactly the step the one-click onboarding exists to
// remove.
//
// One field is enough. identity.ts already defaults slackAccounts, mailboxes
// and calendarMailbox to the primary email when they are absent, so the common
// single-account case needs nothing else; multi-account owners edit the file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { _resetIdentity } from "./identity.js";

export interface IdentityInput {
  primaryEmail: string;
  mailboxes?: string[];
  slackAccounts?: Array<{ account: string; label?: string }>;
  calendarMailbox?: string;
}

export class InvalidIdentity extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidIdentity";
  }
}

// Deliberately permissive: this guards against an empty box or an obvious
// typo, not against every RFC-legal oddity. Rejecting a valid address the
// owner actually uses would be the worse failure.
function normalizeEmail(raw: unknown, field: string): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) throw new InvalidIdentity(`${field} is required`);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
    throw new InvalidIdentity(`${field} does not look like an email address: ${s}`);
  }
  return s;
}

export function identityPathFor(cwd: string = process.cwd()): string {
  return join(cwd, "config", "identity.json");
}

// Build the on-disk shape. Pure — separated from the write so the exact JSON is
// assertable without touching a filesystem.
export function buildIdentityFile(input: IdentityInput): Record<string, unknown> {
  const primaryEmail = normalizeEmail(input.primaryEmail, "primaryEmail");
  const mailboxes = (input.mailboxes ?? [primaryEmail])
    .map((m, i) => normalizeEmail(m, `mailboxes[${i}]`));
  const slackAccounts = (input.slackAccounts ?? [{ account: primaryEmail }]).map((a, i) => ({
    account: normalizeEmail(a.account, `slackAccounts[${i}].account`),
    // The first workspace keeps the legacy label: it keys persisted cursors and
    // sourceErrors, so renaming it would orphan existing state.
    label: a.label?.trim() || (i === 0 ? "slack:direct" : `slack:${a.account.split("@")[0]}`),
  }));
  return {
    _comment:
      "Written by the cockpit's first-run setup. Safe to edit by hand — add mailboxes or Slack workspaces here. Gitignored; never commit.",
    primaryEmail,
    slackAccounts,
    mailboxes: mailboxes.length ? mailboxes : [primaryEmail],
    calendarMailbox: input.calendarMailbox?.trim()
      ? normalizeEmail(input.calendarMailbox, "calendarMailbox")
      : primaryEmail,
  };
}

export function writeIdentity(input: IdentityInput, cwd: string = process.cwd()): string {
  const path = identityPathFor(cwd);
  const body = buildIdentityFile(input);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
  // loadIdentity() memoises for the process lifetime, so without this the
  // cockpit would keep serving "unconfigured" until it restarted — the user
  // would save the form and see nothing change.
  _resetIdentity();
  return path;
}

// ─── multi-workspace ─────────────────────────────────────────────────

// The Keychain key for a workspace authorized through the one-click flow. Keyed
// on team_id, not the team name or domain: names get changed and would orphan
// the credential, ids do not.
export function slackAccountKeyFor(teamId: string): string {
  const id = teamId.trim();
  if (!id) throw new InvalidIdentity("Slack returned no team id to key this workspace on");
  return `team:${id}`;
}

// The source label. It keys persisted cursors and sourceErrors, so once a
// workspace has one it must never change — a new label would orphan that
// workspace's scan history and re-surface everything as new.
export function slackLabelFor(teamName: string, taken: ReadonlyArray<string>): string {
  const base =
    "slack:" +
    (teamName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace");
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

export interface AppendResult {
  added: boolean;
  account: string;
  label: string;
  path: string;
}

// Register a newly authorized workspace in identity.json. Existing entries are
// rewritten verbatim: the FIRST one in particular keeps its account key and its
// "slack:direct" label, because that label keys every cursor already on disk.
export function appendSlackAccount(
  opts: { teamId: string; teamName: string },
  cwd: string = process.cwd(),
): AppendResult {
  const path = identityPathFor(cwd);
  const current = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
    : {};
  const primaryEmail = typeof current.primaryEmail === "string" ? current.primaryEmail : "";
  if (!primaryEmail) {
    throw new InvalidIdentity("Set up your identity before adding a Slack workspace");
  }
  const existing = Array.isArray(current.slackAccounts)
    ? (current.slackAccounts as Array<{ account?: string; label?: string }>)
        .filter((a) => typeof a?.account === "string" && a.account.trim())
        .map((a) => ({ account: a.account!.trim(), label: (a.label ?? "").trim() }))
    : [];

  const account = slackAccountKeyFor(opts.teamId);
  const already = existing.find((a) => a.account === account);
  if (already) return { added: false, account, label: already.label, path };

  const label = slackLabelFor(opts.teamName, existing.map((a) => a.label));
  const next = { ...current, primaryEmail, slackAccounts: [...existing, { account, label }] };
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  _resetIdentity();
  return { added: true, account, label, path };
}

