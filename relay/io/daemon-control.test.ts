import { describe, expect, it } from "vitest";
import { DAEMON_LABEL, restartDaemon } from "./daemon-control.js";

describe("restartDaemon", () => {
  it("kickstarts the agent rather than unload/load", async () => {
    const calls: Array<[string, string[]]> = [];
    const r = await restartDaemon(async (f, a) => {
      calls.push([f, a]);
    });
    expect(r.restarted).toBe(true);
    expect(calls[0]![0]).toBe("launchctl");
    // -k restarts in place. unload/load could end with the agent unregistered
    // if the second half failed.
    expect(calls[0]![1].slice(0, 2)).toEqual(["kickstart", "-k"]);
    expect(calls[0]![1][2]).toMatch(new RegExp(`^gui/\\d+/${DAEMON_LABEL}$`));
  });

  // The config IS written by the time this runs, so a launchd failure must not
  // read as "your settings were not saved".
  it("reports failure without throwing, and says the config still applies later", async () => {
    const r = await restartDaemon(async () => {
      throw new Error("Could not find service\nextra noise");
    });
    expect(r.restarted).toBe(false);
    expect(r.detail).toMatch(/Saved/);
    expect(r.detail).toMatch(/when it next starts/);
    // Only the first line of a multi-line launchctl error reaches the user.
    expect(r.detail).not.toMatch(/extra noise/);
  });
});
