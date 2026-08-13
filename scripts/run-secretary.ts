#!/usr/bin/env -S npx tsx
// The Phase-3 v1 entry point — the long-running secretary daemon.
//
// Boots a single in-process scheduler, attaches the multi-source scan
// loop, writes a heartbeat each tick, fires a macOS notification on
// failures so the user notices when the daemon dies in the background.
//
// Run interactively to test:
//   npx tsx scripts/run-secretary.ts
// Or once-and-exit (smoke):
//   npx tsx scripts/run-secretary.ts --once
//
// LaunchAgent setup ships separately as a plist that wraps this script
// under launchd KeepAlive.

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Scheduler, DEFAULT_SCAN_INTERVAL_MS } from "../relay/proc/scheduler.js";
import { runScanTick } from "../relay/proc/scan-loop.js";
import { notify } from "../relay/proc/notify.js";
import { loadPersonas } from "../relay/io/personas.js";
import { buildPersonaResolver, type DraftDeps } from "../relay/proc/draft.js";
import { effectiveToolSpecs } from "../relay/io/tools.js";
import { createAnthropicLlmCaller } from "../relay/proc/llm-anthropic.js";
import { createClaudeCliLlmCaller } from "../relay/proc/llm-claude-cli.js";
import { createDeepseekLlmCaller } from "../relay/proc/llm-deepseek.js";
import { loadSettings } from "../relay/io/settings.js";
import { describeIdentity } from "../relay/io/identity.js";

interface Args {
  statePath: string;
  personaDir: string;
  intervalMs: number;
  once: boolean;
  noDraft: boolean;
  maxDraftCandidates?: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let statePath = resolve(process.cwd(), "state/loop-state.json");
  let personaDir = resolve(process.cwd(), "personas");
  let intervalMs = Number(process.env.SCAN_INTERVAL_MINUTES ?? 30) * 60_000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) intervalMs = DEFAULT_SCAN_INTERVAL_MS;
  let once = false;
  let noDraft = false;
  let maxDraftCandidates: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--state") {
      statePath = resolve(argv[++i] ?? "");
    } else if (a === "--personas") {
      personaDir = resolve(argv[++i] ?? "");
    } else if (a === "--interval-ms") {
      intervalMs = Number(argv[++i]);
    } else if (a === "--once") {
      once = true;
    } else if (a === "--no-draft") {
      noDraft = true;
    } else if (a === "--max-draft") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) maxDraftCandidates = n;
    }
  }
  return { statePath, personaDir, intervalMs, once, noDraft, maxDraftCandidates };
}

// Build the LLM drafting dep, or undefined if no API key is configured /
// --no-draft is set. When undefined the daemon runs scan-only (shadow-log
// + cursors, no queue rows).
async function buildDraft(args: Args): Promise<DraftDeps | undefined> {
  if (args.noDraft) {
    console.log("[secretary] --no-draft: scan-only (no queue rows)");
    return undefined;
  }
  // Default to the SUBSCRIPTION path (`claude -p`) like the daemon does — this
  // project's normal mode needs no API key at all. Only `--llm api`/`--llm
  // deepseek` reach for one. The old code always tried the API first, so a
  // correctly-set-up machine was told "No Anthropic API key … scan-only",
  // which reads as a broken install.
  const mode = process.argv.includes("--llm") ? process.argv[process.argv.indexOf("--llm") + 1] : "cli";
  // Same model precedence as the daemon: --draft-model flag > Settings file >
  // built-in default. (The deepseek branch used to drop this entirely.)
  const draftModel = process.argv.includes("--draft-model")
    ? process.argv[process.argv.indexOf("--draft-model") + 1]!
    : loadSettings(args.statePath).llm.draftModel;
  try {
    const llm =
      mode === "api"
        ? await createAnthropicLlmCaller()
        : mode === "deepseek"
          // rawLogPath: capture the raw response whenever a draft comes back
          // empty/unparseable — the silent-skip evidence trail.
          ? await createDeepseekLlmCaller({
              rawLogPath: join(dirname(args.statePath), "llm-draft-raw.jsonl"),
              model: draftModel,
            })
          : createClaudeCliLlmCaller({ model: draftModel });
    const personas = loadPersonas(args.personaDir);
    const { resolve: resolvePersona, keys } = buildPersonaResolver(personas);
    console.log(`[secretary] drafting enabled via ${mode} (${keys.length} personas indexed)`);
    return {
      llm,
      resolvePersona,
      knownPersonaKeys: keys,
      // The roster, so an attendee NAME resolves to that person's address
      // (core/attendee-resolver.ts). run-notify already passed it for P10.
      personas,
      // Connected MCP tools the LLM may route tool cards to.
      toolKeys: Object.keys(effectiveToolSpecs(args.statePath)),
    };
  } catch (e) {
    console.log(
      `[secretary] drafting DISABLED — ${(e as Error).message.split("\n")[0]}. Running scan-only.` +
        (mode === "cli"
          ? " (needs the `claude` CLI logged in: run `claude -p \"say OK\"`)"
          : mode === "deepseek"
            ? " (needs DEEPSEEK_API_KEY env, or Keychain: security add-generic-password -U -s taiv-secretary-deepseek -a <email> -w 'sk-...')"
            : ""),
    );
    return undefined;
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  mkdirSync(dirname(args.statePath), { recursive: true });
  console.log(
    `[secretary] state=${args.statePath} interval=${(args.intervalMs / 1000).toFixed(0)}s once=${args.once}`,
  );
  console.log(`[secretary] ${describeIdentity()}`);
  const draft = await buildDraft(args);

  if (args.maxDraftCandidates !== undefined) {
    console.log(`[secretary] max-draft cap=${args.maxDraftCandidates} (newest drafted, rest reported as draftSkipped)`);
  }

  if (args.once) {
    const r = await runScanTick({
      statePath: args.statePath,
      draft,
      maxDraftCandidates: args.maxDraftCandidates,
    });
    console.log(`[secretary] one-shot tick:`, JSON.stringify(r, null, 2));
    process.exit(0);
  }

  let consecutiveErrors = 0;
  const heartbeatPath = `${dirname(args.statePath)}/heartbeat.json`;
  const scheduler = new Scheduler({
    intervalMs: args.intervalMs,
    heartbeatPath,
    onTick: async (info) => {
      const tag = `[tick ${info.ordinal}${info.onWake ? " ★wake" : ""}]`;
      console.log(`${tag} fired at=${new Date(info.atMs).toISOString()}`);
      const r = await runScanTick({
        statePath: args.statePath,
        onWake: info.onWake,
        draft,
        maxDraftCandidates: args.maxDraftCandidates,
      });
      console.log(
        `${tag} done in ${r.durationMs}ms: inbound=${r.totalInbound} triggered=${r.totalTriggered} promoFiltered=${r.promoFiltered} drafted=${r.drafted} shadowWritten=${r.shadowWritten}`,
      );
      consecutiveErrors = 0;
    },
    onError: (err, info) => {
      console.error(`[tick ${info.ordinal}] ERROR: ${err.message}`);
      consecutiveErrors++;
      // Three crashes in a row → user notification.
      if (consecutiveErrors === 3) {
        void notify({
          title: "Secretary scan failing",
          body: `Three consecutive ticks failed. Latest: ${err.message.slice(0, 200)}`,
        });
      }
    },
  });

  scheduler.start();
  const shutdown = (signal: string): void => {
    console.log(`[secretary] received ${signal}, shutting down`);
    scheduler.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  // Keep the process alive forever.
  setInterval(() => {}, 1 << 30).unref();
}

main().catch((e) => {
  console.error("[secretary] crashed:", (e as Error).message);
  void notify({
    title: "Secretary crashed",
    body: (e as Error).message.slice(0, 200),
  });
  process.exit(1);
});
