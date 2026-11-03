// Read his Feishu agenda through lark-cli (user identity). Needs the scope
// calendar:calendar.event:read, granted 2026-11-03. No token handling here —
// lark-cli owns the login; a failure throws and the mirror writes nothing.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseAgenda, type FeishuEvent } from "../core/feishu-mirror.js";

const run = promisify(execFile);

/**
 * lark-cli is a `#!/usr/bin/env node` script installed beside node. Under
 * launchd PATH holds neither (2026-11-03: 「spawn lark-cli ENOENT」), so it runs
 * through THIS process's node by absolute path; outside that layout, by name.
 */
function larkCommand(): [string, string[]] {
  const sibling = join(dirname(process.execPath), "lark-cli");
  return existsSync(sibling) ? [process.execPath, [realpathSync(sibling)]] : ["lark-cli", []];
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
