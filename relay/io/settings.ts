// Secretary settings — the non-secret, per-install preferences that the
// cockpit Settings screen edits and the daemon reads at startup
// (config/secretary-settings.json):
//
//   { "llm": { "mode": "cli" | "anthropic" | "deepseek", "draftModel": "opus" } }
//
// This file is NOT a secret — API keys and OAuth tokens never live here, they
// live in the macOS Keychain (relay/io/keychain.ts). It is still personal
// config (how THIS owner's instance runs), so it is gitignored like the rest
// of config/*.json — never commit it.
//
// Load is TOTAL: a missing file, corrupt JSON, or individually invalid fields
// all fall back to defaults — it never throws. Both readers (the daemon at
// startup, the cockpit on every Settings render) must survive a half-written
// or hand-mangled file; the next save simply rewrites it cleanly. Fallback is
// PER FIELD: one bad value doesn't discard the other valid ones.

import { isValidTimeZone } from "../core/when.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type LlmMode = "cli" | "anthropic" | "deepseek";

export interface SecretarySettings {
  llm: {
    mode: LlmMode;
    draftModel: string;
  };
  /**
   * The OWNER's IANA timezone. Anchors the clock the model reasons against,
   * and is the fallback zone for a meeting stated without one.
   *
   * Defaults to the machine's zone, which is right until the owner travels or
   * runs this on a server — at which point every relative date ("tomorrow
   * 9am") silently resolves against the wrong day, so it has to be settable.
   */
  timezone: string;
  /**
   * Apply updates without being asked. ON by default, the way every desktop
   * app the owner already runs behaves. An install that quietly falls years
   * behind is the worse failure: it keeps shipping bugs that were fixed, to
   * someone with no terminal and no reason to suspect anything is wrong.
   * The checkbox is right there for anyone who disagrees.
   */
  autoUpdate: boolean;
}

export const LLM_MODES: readonly LlmMode[] = ["cli", "anthropic", "deepseek"];

// Resolved at call time, not module load: a long-running daemon should pick up
// a machine that changed zone on its next read.
export function machineTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export const DEFAULT_SETTINGS: SecretarySettings = {
  llm: { mode: "cli", draftModel: "claude-sonnet-5" },
  timezone: "",
  autoUpdate: true,
};

// settingsPathFor follows the same convention as CockpitApi.projectsDir():
// state/, config/ and projects/ are siblings under the repo root, so the
// config dir is two levels up from the state file.
export function settingsPathFor(statePath: string): string {
  return join(dirname(dirname(statePath)), "config", "secretary-settings.json");
}

// Read the settings file, tolerating every failure mode. Unknown extra fields
// are ignored (forward-compatible); invalid known fields fall back one by one.
export function loadSettings(statePath: string): SecretarySettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPathFor(statePath), "utf8")) as {
      llm?: { mode?: unknown; draftModel?: unknown };
      timezone?: unknown;
      autoUpdate?: unknown;
    };
    const mode = raw?.llm?.mode;
    const draftModel = raw?.llm?.draftModel;
    const tz = typeof raw?.timezone === "string" ? raw.timezone.trim() : "";
    return {
      llm: {
        mode: LLM_MODES.includes(mode as LlmMode) ? (mode as LlmMode) : DEFAULT_SETTINGS.llm.mode,
        draftModel:
          typeof draftModel === "string" && draftModel.trim()
            ? draftModel.trim()
            : DEFAULT_SETTINGS.llm.draftModel,
      },
      // An unset or invalid zone falls back to the machine rather than to a
      // guess like UTC: booking someone's meetings in the wrong zone is the
      // failure this whole area exists to prevent.
      timezone: tz && isValidTimeZone(tz) ? tz : machineTimeZone(),
      // Only a literal false turns it off. A missing key means an install
      // that predates the setting, and those are exactly the ones that most
      // need to catch up — defaulting them to off would freeze them there.
      autoUpdate: raw?.autoUpdate !== false,
    };
  } catch {
    return { ...structuredClone(DEFAULT_SETTINGS), timezone: machineTimeZone() };
  }
}

// Persist settings (mkdir -p first — a fresh clone has no config/ dir beyond
// the committed .example files, and the file may not exist yet).
export function saveSettings(statePath: string, settings: SecretarySettings): void {
  const path = settingsPathFor(statePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", "utf8");
}
