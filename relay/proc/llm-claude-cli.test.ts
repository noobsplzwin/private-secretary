import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDraftedActions, claudeExitReason } from "./llm-claude-cli.js";

// Wrap a model-result string in the `claude -p --output-format json` envelope.
function envelope(result: string, is_error = false): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error, result });
}

describe("parseDraftedActions", () => {
  it("parses bare-JSON model output (the happy path)", () => {
    const result = JSON.stringify({
      actions: [{ action_type: "reply", reason: "asked for spec", confidence: 0.7, draft: "on it" }],
    });
    const actions = parseDraftedActions(envelope(result));
    expect(actions).toHaveLength(1);
    expect(actions[0]!.action_type).toBe("reply");
    expect(actions[0]!.draft).toBe("on it");
  });

  it("tolerates markdown-fenced output", () => {
    const result = "```json\n" + JSON.stringify({ actions: [{ action_type: "ignore", reason: "newsletter", confidence: 0.95 }] }) + "\n```";
    const actions = parseDraftedActions(envelope(result));
    expect(actions).toHaveLength(1);
    expect(actions[0]!.action_type).toBe("ignore");
  });

  it("tolerates stray prose around the JSON object", () => {
    const result = 'Here are the actions:\n{"actions":[{"action_type":"task","reason":"fyi","confidence":0.5}]}\nDone.';
    const actions = parseDraftedActions(envelope(result));
    expect(actions).toHaveLength(1);
    expect(actions[0]!.action_type).toBe("task");
  });

  it("returns [] when the model emits no JSON object", () => {
    expect(parseDraftedActions(envelope("I cannot help with that."))).toEqual([]);
  });

  it("returns [] when actions is missing or not an array", () => {
    expect(parseDraftedActions(envelope('{"foo":1}'))).toEqual([]);
    expect(parseDraftedActions(envelope('{"actions":"nope"}'))).toEqual([]);
  });

  it("throws on an unparseable CLI envelope", () => {
    expect(() => parseDraftedActions("not json at all")).toThrow(/unparseable envelope/);
  });

  it("throws when the CLI reports is_error", () => {
    expect(() => parseDraftedActions(envelope("Not logged in", true))).toThrow(/claude -p error/);
  });
});

describe("claudeExitReason", () => {
  // 2026-09-04: an expired subscription session hid for two days behind a
  // 200-char prefix of the result envelope — which is all telemetry.
  it("pulls the CLI's own reason out of the result envelope", () => {
    const envelope = JSON.stringify({
      is_error: true,
      duration_api_ms: 0,
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      terminal_reason: "api_error",
      result: "Failed to authenticate: OAuth session expired and could not be refreshed",
    });
    expect(claudeExitReason(envelope, "")).toBe(
      "Failed to authenticate: OAuth session expired and could not be refreshed",
    );
  });

  it("falls back to stderr when stdout is not an envelope", () => {
    expect(claudeExitReason("", "claude: command failed")).toBe("claude: command failed");
  });

  it("never returns an empty string", () => {
    expect(claudeExitReason("", "")).toBe("(no output)");
  });
});

// 2026-09-04: the scan loop's llm:draft-empty message names llm-draft-raw.jsonl,
// but only the DeepSeek path ever wrote it — on the claude -p path the file did
// not exist, so "why did this sender draft nothing" had no evidence at all.
describe("empty drafts leave evidence in the raw log", () => {
  const withFakeClaude = async (
    result: string,
  ): Promise<{ records: Array<Record<string, unknown>>; actions: unknown[] }> => {
    const dir = mkdtempSync(join(tmpdir(), "rawlog-"));
    const bin = join(dir, "fake-claude.sh");
    const logPath = join(dir, "llm-draft-raw.jsonl");
    writeFileSync(
      bin,
      `#!/bin/sh\ncat > /dev/null\ncat <<'EOF'\n${JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result,
      })}\nEOF\n`,
      { mode: 0o755 },
    );
    vi.resetModules();
    vi.stubEnv("CLAUDE_BIN", bin);
    const { createClaudeCliLlmCaller } = await import("./llm-claude-cli.js");
    const caller = createClaudeCliLlmCaller({ rawLogPath: logPath });
    const actions = await caller({
      system: "s",
      userText: "u",
      toolName: "t",
      toolInputSchema: {},
    });
    const records = existsSync(logPath)
      ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
    return { records, actions };
  };

  it("records an off-format answer as parse-failure, keeping what was said", async () => {
    const { records, actions } = await withFakeClaude("Nothing actionable in this thread.");
    expect(actions).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]!.kind).toBe("parse-failure");
    expect(records[0]!.raw).toBe("Nothing actionable in this thread.");
  });

  it("records a well-formed empty answer as empty-actions", async () => {
    const { records } = await withFakeClaude('{"actions":[]}');
    expect(records).toHaveLength(1);
    expect(records[0]!.kind).toBe("empty-actions");
  });

  it("writes nothing when the model DID produce actions", async () => {
    const { records, actions } = await withFakeClaude(
      '{"actions":[{"action_type":"task","reason":"r","confidence":0.9,"params":{"title":"x"},"headline":"x"}]}',
    );
    expect(actions).toHaveLength(1);
    expect(records).toEqual([]);
  });
});
