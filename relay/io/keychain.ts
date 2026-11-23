// macOS Keychain wrapper. Secrets — Slack tokens, Google OAuth client JSON,
// refresh tokens — never live on disk in plaintext or in env vars; they live
// here, accessed via `security(1)`. The runner is injectable so tests can
// pass a fake and not touch the user's real Keychain.
//
// Conventions used by the Taiv Secretary:
//   taiv-secretary-slack         account=<email>   — Slack user OAuth token (xoxp-...)
//   taiv-secretary-gcp-{A|B|C}   account=<email>   — Google OAuth client JSON (the
//                                                    "installed" credential blob)
//   taiv-secretary-token-google  account=<email>   — per-mailbox OAuth refresh
//                                                    bundle (refresh_token,
//                                                    access_token, expiry, scope)
//   taiv-secretary-notion        account=<email>   — Notion integration token (deferred)
//   taiv-secretary-jira          account=<email>   — Atlassian API token (deferred)
//   taiv-secretary-deepseek      account=<email>   — DeepSeek API key (--llm deepseek)

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Result shape of a `security` invocation. Tests substitute a fake runner; the
// default runner shells out to /usr/bin/security via execFile (arg array, not
// shell-interpolated — no injection on service/account/value).
export interface SecurityResult {
  stdout: string;
  stderr: string;
}

export type SecurityRunner = (args: string[]) => Promise<SecurityResult>;

export const defaultSecurityRunner: SecurityRunner = async (args) => {
  const { stdout, stderr } = await execFileAsync("security", args, { encoding: "utf8" });
  return { stdout, stderr };
};

// Module-scope runner override for tests of modules built ON TOP of keychain
// (google-oauth, slack-api token loaders, etc) — those modules call get/set
// directly without threading an opts.runner through every layer. Production
// path is unaffected; only tests touch __setRunner.
let _activeRunner: SecurityRunner = defaultSecurityRunner;

export function __setRunner(runner: SecurityRunner | null): void {
  _activeRunner = runner ?? defaultSecurityRunner;
}

export interface KeychainOptions {
  runner?: SecurityRunner;
}

// Raised when a Keychain entry doesn't exist (security exits 44). Distinct
// from generic errors so callers can branch on first-time setup vs. real
// failures.
export class KeychainEntryMissing extends Error {
  constructor(public service: string, public account: string) {
    super(`Keychain entry not found: service=${service} account=${account}`);
    this.name = "KeychainEntryMissing";
  }
}

function isNotFoundError(e: unknown): boolean {
  // execFile rejects with an Error that has .code (exit code) and .stderr.
  // `security` exits 44 with "The specified item could not be found in the
  // keychain." Match on the message too — different macOS versions may differ
  // in exit code semantics.
  const err = e as { code?: number; stderr?: string };
  if (err?.code === 44) return true;
  return typeof err?.stderr === "string" && /could not be found/i.test(err.stderr);
}

// Read the password value from a generic-password Keychain entry. Returns the
// raw string with the trailing newline that `security -w` always appends
// trimmed — the stored content itself (which may legitimately contain newlines
// internally) is preserved.
export async function getSecret(
  service: string,
  account: string,
  opts: KeychainOptions = {},
): Promise<string> {
  const runner = opts.runner ?? _activeRunner;
  try {
    const { stdout } = await runner([
      "find-generic-password",
      "-s",
      service,
      "-a",
      account,
      "-w",
    ]);
    return stdout.replace(/\n$/, "");
  } catch (e) {
    if (isNotFoundError(e)) throw new KeychainEntryMissing(service, account);
    throw e;
  }
}

// Store / overwrite a generic-password entry. `-U` upserts so re-running is
// idempotent. Value is passed as an arg, briefly visible in `ps` — acceptable
// for v1; revisit only if the threat model includes other local processes.
export async function setSecret(
  service: string,
  account: string,
  value: string,
  opts: KeychainOptions = {},
): Promise<void> {
  const runner = opts.runner ?? _activeRunner;
  try {
    await runner([
      "add-generic-password",
      "-U",
      "-s",
      service,
      "-a",
      account,
      "-w",
      value,
    ]);
  } catch (e) {
    // execFile's error message is "Command failed: <the whole argv>" — the
    // secret included. It reached secretary.err.log 185 times as a Google
    // refresh token (2026-11). Rethrow with the value cut out, keeping what
    // `security` itself said about why.
    const err = e as { stderr?: unknown; code?: unknown };
    const said = typeof err.stderr === "string" ? err.stderr.trim() : "";
    throw new Error(
      `security add-generic-password -s ${service} -a ${account} failed` +
        (err.code !== undefined ? ` (exit ${String(err.code)})` : "") +
        (said ? `: ${said.split(value).join("<secret>")}` : ""),
    );
  }
}

export async function deleteSecret(
  service: string,
  account: string,
  opts: KeychainOptions = {},
): Promise<void> {
  const runner = opts.runner ?? _activeRunner;
  try {
    await runner(["delete-generic-password", "-s", service, "-a", account]);
  } catch (e) {
    if (isNotFoundError(e)) throw new KeychainEntryMissing(service, account);
    throw e;
  }
}

// Convenience: JSON-typed wrappers. The secrets we store (OAuth client JSON,
// token bundles) are JSON blobs; parse/serialize at the boundary so callers
// see typed objects.
export async function getJSON<T = unknown>(
  service: string,
  account: string,
  opts: KeychainOptions = {},
): Promise<T> {
  const raw = await getSecret(service, account, opts);
  return JSON.parse(raw) as T;
}

export async function setJSON(
  service: string,
  account: string,
  value: unknown,
  opts: KeychainOptions = {},
): Promise<void> {
  await setSecret(service, account, JSON.stringify(value), opts);
}

// True if the entry exists. Cheap probe for first-time-setup branching.
export async function hasSecret(
  service: string,
  account: string,
  opts: KeychainOptions = {},
): Promise<boolean> {
  try {
    await getSecret(service, account, opts);
    return true;
  } catch (e) {
    if (e instanceof KeychainEntryMissing) return false;
    throw e;
  }
}
