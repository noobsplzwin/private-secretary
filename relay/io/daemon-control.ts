// Restart the background daemon from the cockpit.
//
// Needed because identity is memoised per process: saving config/identity.json
// from the first-run form would otherwise leave the running daemon polling
// nothing until the user restarted it by hand — the terminal step the form
// exists to remove.
//
// Best-effort by design. The daemon may legitimately not be under launchd (a
// developer running `npx tsx scripts/run-notify.ts`, or a machine where the
// agent was unloaded), and a failure here must never fail the save: the config
// IS written, and launchd will pick it up whenever the daemon next starts.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const DAEMON_LABEL = "tv.taiv.secretary";

export interface DaemonRestart {
  restarted: boolean;
  detail: string;
}

export type Runner = (file: string, args: string[]) => Promise<unknown>;

export async function restartDaemon(
  runner: Runner = (file, args) => run(file, args),
  label: string = DAEMON_LABEL,
): Promise<DaemonRestart> {
  try {
    // kickstart -k kills the running instance and starts it again; unlike
    // unload/load it leaves the agent registered, so a failure cannot end with
    // the daemon disabled.
    await runner("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 0}/${label}`]);
    return { restarted: true, detail: "Background daemon restarted." };
  } catch (e) {
    return {
      restarted: false,
      detail: `Saved. The background daemon could not be restarted (${
        e instanceof Error ? e.message.split("\n")[0] : String(e)
      }) — it will use the new settings when it next starts.`,
    };
  }
}
