// Read his Feishu agenda through lark-cli (user identity). Needs the scope
// calendar:calendar.event:read, granted 2026-11-03. No token handling here —
// lark-cli owns the login; a failure throws and the mirror writes nothing.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseAgenda, type FeishuEvent } from "../core/feishu-mirror.js";

const run = promisify(execFile);

/**
 * lark-cli is a `#!/usr/bin/env node` script. Under launchd PATH holds no
 * lark-cli, and the daemon's own node is Homebrew's while lark-cli lives under
 * nvm (2026-11-03: 「spawn lark-cli ENOENT」, twice). So: find the script —
 * LARK_CLI, beside this node, or any nvm install — and run it through THIS
 * process's node by absolute path. Nothing found → by name, as in a shell.
 */
function larkCommand(): [string, string[]] {
  const nvm = join(homedir(), ".nvm", "versions", "node");
  const candidates = [
    process.env.LARK_CLI,
    join(dirname(process.execPath), "lark-cli"),
    ...(existsSync(nvm) ? readdirSync(nvm).sort().reverse().map((v) => join(nvm, v, "bin", "lark-cli")) : []),
  ].filter((p): p is string => !!p);
  const found = candidates.find((p) => existsSync(p));
  return found ? [process.execPath, [realpathSync(found)]] : ["lark-cli", []];
}

export async function fetchFeishuAgenda(startIso: string, endIso: string): Promise<FeishuEvent[]> {
  const [cmd, pre] = larkCommand();
  const { stdout } = await run(cmd, [...pre, "calendar", "+agenda", "--as", "user", "--start", startIso, "--end", endIso], {
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const raw = JSON.parse(stdout) as { ok?: boolean; error?: { message?: string } };
  if (raw.ok === false) throw new Error(`feishu agenda: ${raw.error?.message ?? "not ok"}`);
  return parseAgenda(raw);
}
