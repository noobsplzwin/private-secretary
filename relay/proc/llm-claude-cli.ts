// Adapts the headless Claude Code CLI (`claude -p`) into the drafting
// LlmCaller — a TEMPORARY stand-in for the Anthropic API path so drafting
// runs on the Claude Code subscription (zero pay-per-token API spend)
// instead of createAnthropicLlmCaller.
//
// Why this works where `/loop /relay` does not: the daemon does detection
// itself (platform tokens), and only spawns `claude -p` for the pure
// text→JSON drafting step. That subprocess needs no repo access and no MCP,
// so we run it with cwd=$HOME — sidestepping the repo-path `uv_cwd EPERM`
// glitch that breaks interactive Claude Code's Bash subprocess.
//
// Contract: identical to llm-anthropic's LlmCaller — req in, DraftedAction[]
// out. draft.ts validates each action against the ActionItem schema and
// drops malformed ones, so a stray field here is non-fatal.

import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import type { DraftedAction } from "./draft-prompt.js";
import type { LlmCaller } from "./draft.js";

// Pinned to the full id, not the "sonnet" alias: an alias silently follows the
// next Sonnet release, and this engine has been bitten enough by silent
// changes. Owner's call, 2026-08-22 — Sonnet 5 is ~0.6x Opus 5 on every token
// class (0.4x while the intro price runs to 2026-08-31).
const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_TIMEOUT_MS = 180_000;
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

// Drafting is pure text→JSON: the subprocess must never read files, run
// bash, or hit the network. Deny the lot so a prompt-injected message body
// can't turn the drafter into an actor.
const DISALLOWED_TOOLS =
  "Bash,Read,Edit,Write,WebFetch,WebSearch,Glob,Grep,Task,NotebookEdit";

export interface ClaudeCliOptions {
  model?: string;
  timeoutMs?: number;
}

// Pull the {actions:[...]} payload out of a `claude -p --output-format json`
// stdout. Defensive on two layers: the CLI envelope, then the model's text
// (which should be bare JSON but may arrive fenced or with stray prose).
// Exported for the unit test — the parsing is the fragile part.
export function parseDraftedActions(stdout: string): DraftedAction[] {
  const obj = parseResultObject(stdout);
  const actions = (obj as { actions?: unknown } | null)?.actions;
  return Array.isArray(actions) ? (actions as DraftedAction[]) : [];
}

// Unwrap the `claude -p --output-format json` envelope → the model's result
// text → the JSON object it contains. Throws on an unparseable envelope or an
// is_error result; returns null when the result text holds no JSON object.
// Shared by the DraftedAction path and the generic JSON caller.
export function parseResultObject(stdout: string): unknown {
  let envelope: { result?: unknown; is_error?: boolean };
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error(`claude -p: unparseable envelope: ${stdout.slice(0, 200)}`);
  }
  if (envelope.is_error) {
    throw new Error(`claude -p error: ${String(envelope.result).slice(0, 200)}`);
  }
  const text = typeof envelope.result === "string" ? envelope.result : "";
  return extractJsonObject(text);
}

// Find the outermost JSON object in a text blob — tolerant of markdown
// fences and leading/trailing prose. Returns null if none parses.
function extractJsonObject(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

function runClaude(
  system: string,
  userText: string,
  model: string,
  timeoutMs: number,
  imagePaths: string[] = [],
  allowedTools?: string[],
): Promise<string> {
  // Vision mode: stage the decoded images into a private temp dir, run with
  // cwd THERE and ONLY the Read tool allowed, and tell the model the local
  // filenames. cwd is the temp dir (not $HOME) so Read is scoped to just these
  // images — the model can't wander the filesystem. Text mode keeps cwd=$HOME
  // (dodges the repo-path uv_cwd EPERM glitch) with all tools denied.
  const images = imagePaths.filter((p) => existsSync(p));
  const visionDir = images.length > 0 ? mkdtempSync(join(tmpdir(), "ccvision-")) : null;
  let cwd = homedir();
  // Default: deny all tools (pure analysis). A research caller passes an explicit
  // allow-list (e.g. ["WebSearch"]) for a bounded agentic lookup — cwd stays $HOME
  // so a read tool can't reach the repo, and only the named tools are permitted.
  let toolArgs =
    allowedTools && allowedTools.length > 0
      ? ["--allowedTools", allowedTools.join(",")]
      : ["--disallowedTools", DISALLOWED_TOOLS];
  let prompt = userText;
  if (visionDir) {
    const names = images.map((p, i) => {
      const name = `image-${i + 1}${extname(p) || ".jpg"}`;
      copyFileSync(p, join(visionDir, name));
      return name;
    });
    cwd = visionDir;
    toolArgs = ["--allowedTools", "Read"];
    prompt =
      userText +
      `\n\nIMAGES attached to this message are in the current directory: ` +
      names.map((n) => `./${n}`).join(", ") +
      `. Read each before deciding — the point may be IN the image (transcribe any text).`;
  }
  const cleanup = (): void => {
    if (visionDir) {
      try {
        rmSync(visionDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  };
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      CLAUDE_BIN,
      ["-p", "--output-format", "json", "--model", model, ...toolArgs, "--system-prompt", system],
      {
        cwd,
        // Blank ANTHROPIC_API_KEY → use the logged-in subscription, never
        // the pay-per-token API. (claude reads OAuth creds from the keychain.)
        env: { ...process.env, ANTHROPIC_API_KEY: "" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      cleanup();
      reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      cleanup();
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      cleanup();
      if (code !== 0) {
        reject(
          new Error(`claude -p exit ${code}: ${(err || out).slice(0, 200)}`),
        );
        return;
      }
      resolvePromise(out);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Build an LlmCaller backed by `claude -p`. The original system prompt tells
// the model to call a tool; we override that tail with a JSON-only
// instruction since headless mode has no forced tool call.
export function createClaudeCliLlmCaller(opts: ClaudeCliOptions = {}): LlmCaller {
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (req) => {
    const vision = (req.imagePaths ?? []).length > 0;
    const schema = JSON.stringify(req.toolInputSchema);
    // Text mode forbids ALL tools. Vision mode must allow Read (to view the
    // image) but nothing else, then still return JSON-only.
    const outputRule = vision
      ? `\n\nUse the Read tool ONLY to view the attached image file(s); do NOT call any other tool. ` +
        `After viewing, respond with ONLY a single JSON object {"actions":[...]} whose "actions" array ` +
        `conforms to this JSON schema:\n${schema}\nNo markdown fences, no prose — just the JSON object.`
      : `\n\nOUTPUT MODE: Do NOT call any tool. Respond with ONLY a single JSON ` +
        `object of the form {"actions":[...]} whose "actions" array conforms to ` +
        `this JSON schema:\n${schema}\n` +
        `No markdown fences, no prose before or after — output the JSON object and nothing else.`;
    const stdout = await runClaude(req.system + outputRule, req.userText, model, timeoutMs, req.imagePaths ?? []);
    return parseDraftedActions(stdout);
  };
}

// A generic structured-JSON caller over `claude -p` (text-only, no vision):
// system + userText + a target schema → the parsed JSON object the model
// returned (or null if it emitted none). Used by the task-consolidation pass,
// which needs an arbitrary object shape, not the DraftedAction[] envelope.
export type JsonLlmCaller = (req: {
  system: string;
  userText: string;
  toolInputSchema: Record<string, unknown>;
}) => Promise<unknown>;

export function createClaudeCliJsonCaller(opts: ClaudeCliOptions = {}): JsonLlmCaller {
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (req) => {
    const system =
      req.system +
      `\n\nOUTPUT MODE: Do NOT call any tool. Respond with ONLY a single JSON ` +
      `object conforming to this JSON schema:\n${JSON.stringify(req.toolInputSchema)}\n` +
      `No markdown fences, no prose before or after — output the JSON object and nothing else.`;
    const stdout = await runClaude(system, req.userText, model, timeoutMs, []);
    return parseResultObject(stdout);
  };
}

// Unwrap the `claude -p` envelope → the model's raw result TEXT (not JSON). Used
// by the research caller, whose answer is prose, not a structured object.
export function unwrapResultText(stdout: string): string {
  let envelope: { result?: unknown; is_error?: boolean };
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error(`claude -p: unparseable envelope: ${stdout.slice(0, 200)}`);
  }
  if (envelope.is_error) throw new Error(`claude -p error: ${String(envelope.result).slice(0, 200)}`);
  return typeof envelope.result === "string" ? envelope.result : "";
}

// P6 slice 2 — a bounded agentic research caller: runs `claude -p` with a tool
// allow-list (default WebSearch only) and returns the model's text answer. Slow
// (it browses), so it gets its own longer timeout and is invoked ON DEMAND, never
// in the scan hot path. cwd=$HOME + WebSearch-only = it can search but not touch
// the repo or send anything.
export type ResearchLlmCaller = (req: {
  system: string;
  userText: string;
  allowedTools?: string[];
}) => Promise<string>;

export function createClaudeCliResearchCaller(opts: ClaudeCliOptions = {}): ResearchLlmCaller {
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? 180_000; // web search is slow; 3-min ceiling
  return async (req) => {
    const stdout = await runClaude(
      req.system,
      req.userText,
      model,
      timeoutMs,
      [],
      req.allowedTools ?? ["WebSearch"],
    );
    return unwrapResultText(stdout).trim();
  };
}
