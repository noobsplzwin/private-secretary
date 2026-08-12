import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CockpitApi, CockpitBadRequestError, type CockpitExecutor } from "./api.js";
import { loadState } from "../io/state.js";
import { toRfc3339 } from "../proc/execute.js";
import { activityPathFor, appendActivity, readActivity } from "../io/activity-log.js";
import { loadSettings } from "../io/settings.js";
import { labelsPathFor } from "../io/labels.js";
import { __setRunner, type SecurityRunner } from "../io/keychain.js";
import { _resetIdentity, _setIdentityForTest } from "../io/identity.js";
import {
  GOOGLE_CLIENT_ACCOUNT,
  GOOGLE_CLIENT_SERVICE,
  TOKEN_KEYCHAIN_SERVICE,
} from "../io/google-oauth.js";
import { ANTHROPIC_KEY_ACCOUNT, ANTHROPIC_KEY_SERVICE } from "../io/anthropic-api.js";
import { DEEPSEEK_KEY_ACCOUNT, DEEPSEEK_KEY_SERVICE } from "../io/deepseek-api.js";
import { markExecuted, withReceipt, type ActionItem } from "../core/action-item.js";
import { type TaskCluster, type TaskPlan } from "../core/tasks.js";
import type { JsonLlmCaller } from "../proc/llm-claude-cli.js";

// getState enriches each core cluster with the cockpit's `unit_key` + `plan`
// (getState's declared type is the pre-enrichment core TaskCluster).
type EnrichedCluster = TaskCluster & { unit_key?: string; plan?: TaskPlan & { tierManual?: boolean } };
function clustersOf(api: CockpitApi): EnrichedCluster[] {
  return api.getState().clusters as EnrichedCluster[];
}

let dir: string;
let statePath: string;
let personaDir: string;

function action(over: Partial<ActionItem> = {}): ActionItem {
  return {
    id: "a1",
    source_message_id: "slack:C1:1781000000.0001",
    action_type: "reply",
    target: { platform: "slack", personaKey: "michael-dobosz" },
    reason: "answer his question",
    confidence: 0.95,
    params: {},
    draft: "sounds good",
    status: "suggested",
    created_at: "2026-06-14T00:00:00Z",
    context: { sender_handle: "U_MICHAEL" },
    ...over,
  };
}

function seed(actions: ActionItem[], extra: Record<string, unknown> = {}): void {
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 2,
      marks: {},
      actions,
      outcomes: [],
      sourceErrors: {},
      tasks: {},
      ...extra,
    }),
  );
}

// A stub executor that "sends" by stamping a sent receipt.
const sendingExecutor: CockpitExecutor = async (a) => {
  const receipt = { kind: "sent" as const, ref: "https://slack/x", at: "2026-06-14T12:00:00Z" };
  return { ok: true, action: markExecuted(withReceipt(a, receipt)), receipt, awaitingManual: false };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cockpit-api-"));
  statePath = join(dir, "loop-state.json");
  personaDir = join(dir, "personas");
  mkdirSync(personaDir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function mkApi(executor: CockpitExecutor): CockpitApi {
  return new CockpitApi({ statePath, personaDir, executor, now: () => "2026-06-14T12:00:00Z" });
}

describe("getState", () => {
  it("buckets actions + computes counts", () => {
    seed([
      action({ id: "s1", task_id: "t1" }),
      action({ id: "s2", task_id: "t1" }),
      action({ id: "done1", status: "executed" }),
      action({ id: "skip1", status: "rejected" }),
      action({
        id: "manual1",
        status: "approved",
        target: { platform: "wechat", personaKey: "wang-acme" },
      }),
    ], { tasks: { t1: { title: "Chicago trip", created_at: "2026-06-08T00:00:00Z" } } });
    const api = mkApi(sendingExecutor);
    const s = api.getState();
    expect(s.counts.pending).toBe(2);
    expect(s.counts.tasks).toBe(1);
    expect(s.counts.awaitingManual).toBe(1);
    expect(s.done.map((a) => a.id)).toEqual(["done1"]);
    expect(s.skipped.map((a) => a.id)).toEqual(["skip1"]);
    expect(s.suggested[0]!.missing_info).toEqual([]);
  });

  // The executed list grows forever; getState caps the drawer's done payload
  // at the 200 most recent so the 15s poll doesn't ship unbounded history.
  it("done is capped at the 200 most recent executed actions", () => {
    seed(
      Array.from({ length: 205 }, (_, i) => action({ id: `d${i}`, status: "executed" })),
    );
    const api = mkApi(sendingExecutor);
    const s = api.getState();
    expect(s.done).toHaveLength(200);
    expect(s.done[0]!.id).toBe("d5"); // oldest 5 dropped, order preserved
    expect(s.done[199]!.id).toBe("d204");
  });

  // Regression: the Queue master list renders from clusters[].actions, not the
  // flat `suggested` array. Each cluster action MUST carry missing_info or the
  // UI crashes ("Cannot read properties of undefined (reading 'missing_info')").
  it("clusters[].actions each carry a missing_info array", () => {
    seed([
      action({ id: "ok1" }), // complete reply → no missing info
      action({ id: "needsinfo1", draft: undefined }), // reply w/o draft → missing
    ]);
    const api = mkApi(sendingExecutor);
    const clusterActions = api.getState().clusters.flatMap((c) => c.actions);
    expect(clusterActions).toHaveLength(2);
    for (const a of clusterActions) {
      expect(Array.isArray((a as { missing_info?: unknown }).missing_info)).toBe(true);
    }
    const needs = clusterActions.find((a) => a.id === "needsinfo1") as unknown as {
      missing_info: string[];
    };
    expect(needs.missing_info.length).toBeGreaterThan(0);
  });

  // sender_name fallback chain: persona-curated name → Slack display name
  // (context.sender_name, resolved at scan time) → raw sender handle.
  it("sender_name falls back persona → Slack display name → raw handle", () => {
    writeFileSync(
      join(personaDir, "michael-dobosz.yaml"),
      [
        "key: michael-dobosz",
        "display_name: Michael Dobosz",
        "handles:",
        "  slack: U_MICHAEL",
        "",
      ].join("\n"),
      "utf8",
    );
    seed([
      // persona match wins over the scan-resolved Slack name
      action({ id: "p1", context: { sender_handle: "U_MICHAEL", sender_name: "Mike" } }),
      // no persona → the Slack display name
      action({ id: "n1", context: { sender_handle: "U_UNKNOWN", sender_name: "Zack" } }),
      // neither → the raw id
      action({ id: "r1", context: { sender_handle: "U_RAW" } }),
    ]);
    const api = mkApi(sendingExecutor);
    const byId = new Map(
      api
        .getState()
        .suggested.map((a) => [a.id, (a as { sender_name?: string }).sender_name]),
    );
    expect(byId.get("p1")).toBe("Michael Dobosz");
    expect(byId.get("n1")).toBe("Zack");
    expect(byId.get("r1")).toBe("U_RAW");
  });

  // Regression: three ungrouped cards drafted from the SAME sender in one batch
  // used to share the conversation-derived unit_key (`__ungrouped_<hash>`), so
  // clicking one card selected — and highlighted — all three. unit_key is the
  // select/re-tier IDENTITY and must be UNIQUE per cluster; the conversation-
  // stable key is the plan/override key only.
  it("same-conversation ungrouped cards get DISTINCT unit_keys", () => {
    seed([action({ id: "u1" }), action({ id: "u2" }), action({ id: "u3" })]);
    const api = mkApi(sendingExecutor);
    const keys = clustersOf(api).map((c) => c.unit_key);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
    // each keys by its own action id, not the shared conversation hash
    expect(keys).toEqual(["__ungrouped_u1", "__ungrouped_u2", "__ungrouped_u3"]);
  });
});

describe("setTier", () => {
  // The frontend drags with the cluster identity key (task_id / unique
  // __ungrouped_<actionId>); the override stores under the STABLE conversation
  // key so getState's plan lookup finds it. A drag on one ungrouped card
  // re-tiers its same-conversation siblings together — they are one planning
  // unit (that is the P1 supersede-stable contract, not a bug).
  it("resolves an ungrouped identity key to the stable conversation key", () => {
    seed([action({ id: "u1" }), action({ id: "u2" })]);
    const api = mkApi(sendingExecutor);
    const u1 = clustersOf(api).find((c) => c.actions[0]!.id === "u1")!;
    api.setTier(u1.unit_key!, "A");
    const tiers = clustersOf(api).map((c) => c.plan?.tier);
    expect(tiers).toEqual(["A", "A"]);
  });

  it("a task_id identity passes through unchanged", () => {
    seed([action({ id: "t1", task_id: "task_a" })], {
      tasks: { task_a: { title: "Chicago trip", created_at: "2026-06-08T00:00:00Z" } },
    });
    const api = mkApi(sendingExecutor);
    api.setTier("task_a", "B");
    expect(clustersOf(api)[0]!.plan?.tier).toBe("B");
  });

  it("tier null clears the override (back to the AI rank)", () => {
    seed([action({ id: "u1" })]);
    const api = mkApi(sendingExecutor);
    const u1 = clustersOf(api).find((c) => c.actions[0]!.id === "u1")!;
    api.setTier(u1.unit_key!, "A");
    api.setTier(u1.unit_key!, null);
    expect(clustersOf(api)[0]!.plan?.tier).toBeUndefined();
  });
});

describe("approve → execute", () => {
  it("approves + executes a slack reply, persists executed + receipt", async () => {
    seed([action({ id: "a1" })]);
    const api = mkApi(sendingExecutor);
    const res = await api.approve("a1");
    expect(res.ok).toBe(true);
    expect(res.action.status).toBe("executed");
    const saved = loadState(statePath).actions.find((a) => a.id === "a1")!;
    expect(saved.status).toBe("executed");
    expect(saved.params.execution_receipt).toBeTruthy();
  });

  it("writes the executing claim BEFORE the side effect (crash-safe)", async () => {
    seed([action({ id: "a1" })]);
    let claimSeenOnDisk = false;
    const slowExecutor: CockpitExecutor = async (a, persistClaim) => {
      await persistClaim({ ...a, params: { ...a.params, execution_started_at: "2026-06-14T11:59:00Z" } });
      // at this point the claim must be on disk
      const onDisk = loadState(statePath).actions.find((x) => x.id === a.id)!;
      claimSeenOnDisk = onDisk.params.execution_started_at === "2026-06-14T11:59:00Z";
      const receipt = { kind: "sent" as const, ref: "x", at: "t" };
      return { ok: true, action: markExecuted(withReceipt(a, receipt)), receipt, awaitingManual: false };
    };
    await mkApi(slowExecutor).approve("a1");
    expect(claimSeenOnDisk).toBe(true);
  });

  it("blocks approve on missing-info (reply with no draft)", async () => {
    seed([action({ id: "a1", draft: "" })]);
    const api = mkApi(sendingExecutor);
    await expect(api.approve("a1")).rejects.toThrow(/missing info/);
    // unchanged on disk
    expect(loadState(statePath).actions[0]!.status).toBe("suggested");
  });

  it("calendar conflict → no execute, action restored to suggested, conflicts returned", async () => {
    seed([
      action({
        id: "cal1",
        action_type: "calendar",
        draft: undefined,
        target: { platform: "gmail" },
        params: {
          title: "Sync",
          start: "2026-06-15T20:00:00Z",
          end: "2026-06-15T21:00:00Z",
          attendees: ["x@y.com"],
        },
      }),
    ]);
    const conflictExecutor: CockpitExecutor = async (a) => ({
      ok: false,
      action: a,
      awaitingManual: false,
      conflicts: [
        {
          event: { summary: "Existing", start: {}, end: {} },
          window: { startMs: 0, endMs: 1 },
        },
      ],
    });
    const res = await mkApi(conflictExecutor).approve("cal1");
    expect(res.ok).toBe(false);
    expect(res.conflicts).toHaveLength(1);
    const saved = loadState(statePath).actions.find((a) => a.id === "cal1")!;
    expect(saved.status).toBe("suggested"); // restored — user re-times
  });

  it("gmail draft → awaitingManual, stays approved, records draft id", async () => {
    seed([
      action({
        id: "g1",
        target: { platform: "gmail", personaKey: "tony-fai" },
        params: { mailbox: "leo@taiv.tv", raw_mime: "x" },
      }),
    ]);
    const draftExecutor: CockpitExecutor = async (a) => ({
      ok: true,
      action: { ...a, params: { ...a.params, gmail_draft_id: "D1" } },
      awaitingManual: true,
    });
    const res = await mkApi(draftExecutor).approve("g1");
    expect(res.awaitingManual).toBe(true);
    const saved = loadState(statePath).actions.find((a) => a.id === "g1")!;
    expect(saved.status).toBe("approved");
    expect(saved.params.gmail_draft_id).toBe("D1");
  });

  // Regression: a failing executor must NOT strand the card as "approved"
  // (which showed a false "Draft created" and blocked re-approval). It rolls
  // back to suggested so the user can fix + retry.
  it("executor throws (no receipt) → card restored to suggested, error propagates", async () => {
    seed([action({ id: "g1", target: { platform: "gmail", personaKey: null }, params: {} })]);
    const failingExecutor: CockpitExecutor = async () => {
      throw new Error("Gmail reply has no params.raw_mime");
    };
    await expect(mkApi(failingExecutor).approve("g1")).rejects.toThrow(/raw_mime/);
    const saved = loadState(statePath).actions.find((a) => a.id === "g1")!;
    expect(saved.status).toBe("suggested"); // not stranded as approved
    expect(saved.params.execution_started_at).toBeUndefined();
  });
});

describe("edit / skip / restore / markSent", () => {
  it("edit patches draft + flags _edited, stays suggested", () => {
    seed([action({ id: "a1" })]);
    const api = mkApi(sendingExecutor);
    const updated = api.edit("a1", { draft: "revised text" });
    expect(updated.draft).toBe("revised text");
    expect(updated.params._edited).toBe(true);
    expect(updated.status).toBe("suggested");
  });

  it("skip → rejected; restore → suggested", () => {
    seed([action({ id: "a1" })]);
    const api = mkApi(sendingExecutor);
    expect(api.skip("a1").status).toBe("rejected");
    expect(api.restore("a1").status).toBe("suggested");
  });

  it("restore refuses an item with a receipt (would double-send)", () => {
    seed([
      action({
        id: "a1",
        status: "approved",
        params: { execution_receipt: { kind: "sent", ref: "x", at: "t" } },
      }),
    ]);
    const api = mkApi(sendingExecutor);
    expect(() => api.restore("a1")).toThrow();
  });

  it("markSent writes receipt + executed for an awaiting-manual item", () => {
    seed([
      action({
        id: "a1",
        status: "approved",
        target: { platform: "wechat", personaKey: "wang-acme" },
      }),
    ]);
    const api = mkApi(sendingExecutor);
    const updated = api.markSent("a1", "manual");
    expect(updated.status).toBe("executed");
    expect((updated.params.execution_receipt as { ref: string }).ref).toBe("manual");
  });

  it("not-found → CockpitNotFoundError", () => {
    seed([]);
    const api = mkApi(sendingExecutor);
    expect(() => api.skip("nope")).toThrow(/not found/);
  });
});

describe("flushAutoExecute", () => {
  it("auto-executes ignore ≥0.9, leaves task and reply/relay alone", async () => {
    seed([
      action({ id: "ig", action_type: "ignore", draft: undefined, target: {}, confidence: 0.98, params: { category: "newsletter" } }),
      action({ id: "tk", action_type: "task", draft: undefined, target: {}, confidence: 0.95, params: { title: "todo" } }),
      action({ id: "rep", action_type: "reply", confidence: 0.95 }), // ALWAYS_CONFIRM
    ]);
    const localExecutor: CockpitExecutor = async (a) => {
      const receipt = { kind: "local" as const, ref: "local", at: "t" };
      return { ok: true, action: markExecuted(withReceipt(a, receipt)), receipt, awaitingManual: false };
    };
    const api = mkApi(localExecutor);
    const n = await api.flushAutoExecute();
    expect(n).toBe(1);
    const state = loadState(statePath);
    expect(state.actions.find((a) => a.id === "ig")!.status).toBe("executed");
    // task stays put: somebody's request is never auto-completed (2026-07-31).
    expect(state.actions.find((a) => a.id === "tk")!.status).toBe("suggested");
    expect(state.actions.find((a) => a.id === "rep")!.status).toBe("suggested");
  });
});

describe("activity log (F3)", () => {
  it("cockpit decisions append one record each, in order", async () => {
    seed([
      action({ id: "a1", headline: "Q3 budget" }),
      action({ id: "a2", headline: "Lunch?" }),
    ]);
    const api = mkApi(sendingExecutor);
    api.edit("a1", { draft: "revised text" });
    api.skip("a2", { existence: "not_mine" });
    api.restore("a2");
    await api.approve("a1"); // stub executor stamps a sent receipt → executed
    const recs = readActivity(readFileSync(activityPathFor(statePath), "utf8"));
    expect(recs.map((r) => r.kind)).toEqual(["edit", "skip", "restore", "approve"]);
    expect(recs[0]!.summary).toContain("Q3 budget");
    expect(recs[0]!.summary).toContain("draft");
    expect(recs[1]!.summary).toContain("not_mine");
    expect(recs[3]!.summary).toContain("executed");
  });

  it("flushAutoExecute logs one auto-execute record (and nothing when idle)", async () => {
    seed([
      action({ id: "ig", action_type: "ignore", draft: undefined, target: {}, confidence: 0.98, params: { category: "newsletter" } }),
    ]);
    const localExecutor: CockpitExecutor = async (a) => {
      const receipt = { kind: "local" as const, ref: "local", at: "t" };
      return { ok: true, action: markExecuted(withReceipt(a, receipt)), receipt, awaitingManual: false };
    };
    const api = mkApi(localExecutor);
    expect(await api.flushAutoExecute()).toBe(1);
    const recs = readActivity(readFileSync(activityPathFor(statePath), "utf8"));
    expect(recs.map((r) => r.kind)).toEqual(["auto-execute"]);
    expect(recs[0]!.summary).toContain("auto-executed 1 card(s)");
    // Second flush: nothing left to auto-execute → no new line.
    expect(await api.flushAutoExecute()).toBe(0);
    expect(readActivity(readFileSync(activityPathFor(statePath), "utf8"))).toHaveLength(1);
  });

  it("getActivity: missing log → empty; kind filter + tail cap work", () => {
    seed([]);
    const api = mkApi(sendingExecutor);
    expect(api.getActivity().records).toEqual([]); // no file yet
    for (let i = 0; i < 5; i++) {
      appendActivity(activityPathFor(statePath), {
        at: `2026-07-31T10:0${i}:00.000Z`,
        kind: i % 2 === 0 ? "tick" : "skip",
        summary: `event ${i}`,
      });
    }
    expect(api.getActivity().records.map((r) => r.summary)).toEqual([
      "event 0", "event 1", "event 2", "event 3", "event 4",
    ]);
    expect(api.getActivity({ kind: "skip" }).records.map((r) => r.summary)).toEqual(["event 1", "event 3"]);
    expect(api.getActivity({ tail: 2 }).records.map((r) => r.summary)).toEqual(["event 3", "event 4"]);
  });
});

describe("getProjects", () => {
  it("groups live cards by project_id + buckets unmatched into misc", () => {
    const projectsDir = join(dir, "projects");
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(
      join(projectsDir, "OUS-1.yaml"),
      "id: OUS-1\ncompany: oushikesi\nname: Robotics line\ngoal: build robots\nstatus: active\nneeds:\n  - need: jetson board\n    status: gap\n  - need: done thing\n    status: covered\n",
    );
    seed([
      action({ id: "p1", project_id: "OUS-1", headline: "arm demo" }),
      action({ id: "p2", project_id: "OUS-1", headline: "jetson power" }),
      action({ id: "m1", project_id: "MISC", headline: "lunch" }),
      action({ id: "m2", headline: "no project field" }), // absent → misc
    ]);
    const api = new CockpitApi({ statePath, personaDir, projectsDir, executor: sendingExecutor });
    const r = api.getProjects();
    const ous = r.projects.find((p) => p.id === "OUS-1")!;
    expect(ous.name).toBe("Robotics line");
    expect((ous.cards as unknown[]).length).toBe(2); // p1 + p2
    expect((ous.needs as unknown[]).length).toBe(1); // only the gap, covered dropped
    expect(r.misc.length).toBe(2); // m1 (MISC) + m2 (absent)
  });
});

// Settings (S3): the LLM config file + Keychain key management. The keychain
// runner is stubbed — these tests never touch the real login keychain, and the
// env vars the resolvers also honor are cleared so the stub is the only source.
describe("settings", () => {
  let keychain: Map<string, string>;
  let runnerCalls: string[][];
  const KEY = "sk-ant-abcdef1234";

  const stubRunner: SecurityRunner = async (args) => {
    runnerCalls.push(args);
    if (args[0] === "find-generic-password") {
      const k = `${args[2]}|${args[4]}`;
      const v = keychain.get(k);
      if (v === undefined) {
        const err = new Error("not found") as Error & { code?: number };
        err.code = 44;
        throw err;
      }
      return { stdout: v + "\n", stderr: "" };
    }
    if (args[0] === "add-generic-password") {
      keychain.set(`${args[3]}|${args[5]}`, args[7]!);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "delete-generic-password") {
      const k = `${args[2]}|${args[4]}`;
      if (!keychain.delete(k)) {
        const err = new Error("not found") as Error & { code?: number };
        err.code = 44;
        throw err;
      }
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected security call: ${args[0]}`);
  };

  beforeEach(() => {
    keychain = new Map();
    runnerCalls = [];
    __setRunner(stubRunner);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
  });
  afterEach(() => __setRunner(null));

  // A settings-dedicated api whose state file sits in a nested state/ dir.
  // settingsPathFor() resolves the config dir TWO levels up from the state
  // file, so the shared root-level statePath would resolve it into the shared
  // $TMPDIR — leaking settings across tests (and across test FILES, which run
  // in parallel workers with the same $TMPDIR).
  let settingsStatePath: string;
  function mkSettingsApi(): CockpitApi {
    mkdirSync(join(dir, "state"), { recursive: true });
    settingsStatePath = join(dir, "state", "loop-state.json");
    writeFileSync(
      settingsStatePath,
      JSON.stringify({ version: 2, marks: {}, actions: [], outcomes: [], sourceErrors: {}, tasks: {} }),
    );
    return new CockpitApi({ statePath: settingsStatePath, personaDir, executor: sendingExecutor, now: () => "2026-06-14T12:00:00Z" });
  }

  it("getSettings masks keys to a last-4 preview and reports unconfigured services", async () => {
    keychain.set(`${ANTHROPIC_KEY_SERVICE}|${ANTHROPIC_KEY_ACCOUNT}`, KEY);
    const api = mkSettingsApi();
    const s = await api.getSettings();
    expect(s.llm).toEqual({ mode: "cli", draftModel: "opus" }); // no file yet → defaults
    expect(s.keys.anthropic).toEqual({ configured: true, preview: "…1234" });
    expect(s.keys.deepseek).toEqual({ configured: false, preview: null });
    // The full key must appear NOWHERE in the payload.
    expect(JSON.stringify(s)).not.toContain(KEY);
  });

  it("setLlm validates the mode enum and round-trips through the config file", () => {
    const api = mkSettingsApi();
    expect(() => api.setLlm({ mode: "wat", draftModel: "opus" })).toThrow(CockpitBadRequestError);
    expect(() => api.setLlm({ mode: "cli", draftModel: "  " })).toThrow(CockpitBadRequestError);
    const r = api.setLlm({ mode: "anthropic", draftModel: "claude-opus-4-8" });
    expect(r).toEqual({ ok: true, restartRequired: true });
    expect(loadSettings(settingsStatePath).llm).toEqual({ mode: "anthropic", draftModel: "claude-opus-4-8" });
    const log = readActivity(readFileSync(activityPathFor(settingsStatePath), "utf8"));
    expect(log.at(-1)!.summary).toBe("settings: llm mode=anthropic model=claude-opus-4-8");
  });

  it("setApiKey rejects services outside the anthropic/deepseek whitelist", async () => {
    const api = mkSettingsApi();
    await expect(api.setApiKey({ service: "slack", value: "xoxp-1" })).rejects.toThrow(
      CockpitBadRequestError,
    );
    expect(runnerCalls).toEqual([]); // whitelist fails BEFORE any keychain call
  });

  it("setApiKey writes the right Keychain entry and never logs the value", async () => {
    const api = mkSettingsApi();
    await api.setApiKey({ service: "deepseek", value: "sk-deepseek-9999" });
    const add = runnerCalls.find((c) => c[0] === "add-generic-password")!;
    expect(add[3]).toBe(DEEPSEEK_KEY_SERVICE);
    expect(add[5]).toBe(DEEPSEEK_KEY_ACCOUNT);
    expect(keychain.get(`${DEEPSEEK_KEY_SERVICE}|${DEEPSEEK_KEY_ACCOUNT}`)).toBe("sk-deepseek-9999");
    const logText = readFileSync(activityPathFor(settingsStatePath), "utf8");
    expect(logText).toContain("settings: deepseek key updated");
    expect(logText).not.toContain("sk-deepseek-9999");

    // Empty value removes the entry; removing again is a no-op, not an error.
    await api.setApiKey({ service: "deepseek", value: "" });
    expect(keychain.has(`${DEEPSEEK_KEY_SERVICE}|${DEEPSEEK_KEY_ACCOUNT}`)).toBe(false);
    await api.setApiKey({ service: "deepseek", value: "" });
  });
});

// Settings Google tab: first-time Gmail + Calendar onboarding. Everything goes
// through the injected keychain runner + identity seam — the real Keychain and
// the real config/identity.json are never touched.
describe("google setup (Settings Google tab)", () => {
  let keychain: Map<string, string>;
  let runnerCalls: string[][];

  const stubRunner: SecurityRunner = async (args) => {
    runnerCalls.push(args);
    if (args[0] === "find-generic-password") {
      const v = keychain.get(`${args[2]}|${args[4]}`);
      if (v === undefined) {
        const err = new Error("not found") as Error & { code?: number };
        err.code = 44;
        throw err;
      }
      return { stdout: v + "\n", stderr: "" };
    }
    if (args[0] === "add-generic-password") {
      keychain.set(`${args[3]}|${args[5]}`, args[7]!);
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected security call: ${args[0]}`);
  };

  const CLIENT_JSON = JSON.stringify({
    installed: { client_id: "abc.apps.googleusercontent.com", client_secret: "shh" },
  });

  beforeEach(() => {
    keychain = new Map();
    runnerCalls = [];
    __setRunner(stubRunner);
    _setIdentityForTest({
      primaryEmail: "me@work.com",
      mailboxes: ["me@work.com", "me@gmail.com"],
      calendarMailbox: "me@work.com",
    });
    seed([]);
  });
  afterEach(() => {
    __setRunner(null);
    _resetIdentity();
  });

  it("getGoogleSetup reports client + per-mailbox authorized state from Keychain", async () => {
    const api = mkApi(sendingExecutor);
    const empty = await api.getGoogleSetup();
    expect(empty.clientConfigured).toBe(false);
    expect(empty.mailboxes).toEqual([
      { email: "me@work.com", authorized: false, isCalendar: true },
      { email: "me@gmail.com", authorized: false, isCalendar: false },
    ]);

    keychain.set(`${GOOGLE_CLIENT_SERVICE}|${GOOGLE_CLIENT_ACCOUNT}`, CLIENT_JSON);
    keychain.set(`${TOKEN_KEYCHAIN_SERVICE}|me@gmail.com`, "{}");
    const s = await api.getGoogleSetup();
    expect(s.clientConfigured).toBe(true);
    expect(s.mailboxes.find((m) => m.email === "me@gmail.com")?.authorized).toBe(true);
    expect(s.mailboxes.find((m) => m.email === "me@work.com")?.authorized).toBe(false);
    // Status is booleans only — no token/client content crosses the wire.
    expect(JSON.stringify(s)).not.toContain("client_secret");
  });

  it("setGoogleClientJson rejects non-JSON and JSON without a client_id", async () => {
    const api = mkApi(sendingExecutor);
    await expect(api.setGoogleClientJson("not json {")).rejects.toThrow(CockpitBadRequestError);
    await expect(api.setGoogleClientJson('{"installed": {}}')).rejects.toThrow(CockpitBadRequestError);
    await expect(api.setGoogleClientJson('{"web": {"redirect_uris": []}}')).rejects.toThrow(
      CockpitBadRequestError,
    );
    expect(runnerCalls).toEqual([]); // validation fails BEFORE any keychain call
  });

  it("setGoogleClientJson stores the blob under the default client entry and never logs it", async () => {
    const api = mkApi(sendingExecutor);
    await expect(api.setGoogleClientJson(CLIENT_JSON)).resolves.toEqual({ ok: true });
    const add = runnerCalls.find((c) => c[0] === "add-generic-password")!;
    expect(add[3]).toBe(GOOGLE_CLIENT_SERVICE);
    expect(add[5]).toBe(GOOGLE_CLIENT_ACCOUNT);
    expect(add[7]).toBe(CLIENT_JSON);

    const logText = readFileSync(activityPathFor(statePath), "utf8");
    expect(logText).toContain("settings: google client JSON stored");
    expect(logText).not.toContain("client_secret");
    // A "web"-shaped download (wrong credential kind, still a client_id) is accepted.
    await expect(
      api.setGoogleClientJson(JSON.stringify({ web: { client_id: "x.apps.googleusercontent.com" } })),
    ).resolves.toEqual({ ok: true });
  });

  it("authorizeGoogleMailbox 400s when the client JSON is not stored yet", async () => {
    const api = mkApi(sendingExecutor);
    await expect(api.authorizeGoogleMailbox("me@work.com", () => {})).rejects.toThrow(
      /store the OAuth client JSON first/,
    );
  });

  it("authorizeGoogleMailbox rejects mailboxes outside the identity config", async () => {
    keychain.set(`${GOOGLE_CLIENT_SERVICE}|${GOOGLE_CLIENT_ACCOUNT}`, CLIENT_JSON);
    const api = mkApi(sendingExecutor);
    let spawned: string[][] = [];
    await expect(
      api.authorizeGoogleMailbox("evil@elsewhere.com", (argv) => spawned.push(argv)),
    ).rejects.toThrow(CockpitBadRequestError);
    expect(spawned).toEqual([]); // nothing reaches the consent script's argv
  });

  it("authorizeGoogleMailbox spawns consent with the default client + target mailbox", async () => {
    keychain.set(`${GOOGLE_CLIENT_SERVICE}|${GOOGLE_CLIENT_ACCOUNT}`, CLIENT_JSON);
    const api = mkApi(sendingExecutor);
    const spawned: string[][] = [];
    const r = await api.authorizeGoogleMailbox("me@gmail.com", (argv) => spawned.push(argv));
    expect(r).toEqual({ started: true });
    expect(spawned).toHaveLength(1);
    const argv = spawned[0]!;
    expect(argv[0]).toBe("tsx");
    expect(argv[1]).toMatch(/scripts[/\\]auth[/\\]google-oauth\.ts$/);
    expect(argv.slice(2)).toEqual(["consent", GOOGLE_CLIENT_SERVICE, GOOGLE_CLIENT_ACCOUNT, "me@gmail.com"]);

    const logText = readFileSync(activityPathFor(statePath), "utf8");
    expect(logText).toContain("settings: google consent started for me@gmail.com");
  });
});

describe("calendar double-booking guard", () => {
  it("approving a calendar card auto-rejects still-suggested siblings with the same start", async () => {
    const calExecutor: CockpitExecutor = async (a) => {
      const receipt = { kind: "calendar_event" as const, ref: "evt1", at: "t" };
      return { ok: true, action: markExecuted(withReceipt(a, receipt)), receipt, awaitingManual: false };
    };
    const cal = (id: string, title: string, start: string) =>
      action({ id, action_type: "calendar", draft: undefined, target: {}, params: { title, start, end: start } });
    seed([
      cal("c1", "Q3 评审", "2026-08-02T15:00:00+08:00"),
      cal("c2", "Q3 评审 (refresh dup)", "2026-08-02T15:00:00+08:00"),
      cal("c3", "别的事", "2026-08-03T10:00:00+08:00"),
    ]);
    const api = mkApi(calExecutor);
    await api.approve("c1");
    const state = loadState(statePath);
    expect(state.actions.find((a) => a.id === "c1")!.status).toBe("executed");
    // same start → auto-rejected (the six-duplicate-Q3-events guard)
    expect(state.actions.find((a) => a.id === "c2")!.status).toBe("rejected");
    // different start → untouched
    expect(state.actions.find((a) => a.id === "c3")!.status).toBe("suggested");
  });
});

describe("calendarConflicts (pre-check — the card's 有无冲突 line)", () => {
  // A calendar card with an explicit mailbox (tests have no identity.json, so
  // resolveCalendarMailbox returns params.mailbox without touching the keychain).
  const cal = (id: string, start: string, end: string) =>
    action({
      id,
      action_type: "calendar",
      draft: undefined,
      target: {},
      params: { title: id, start, end, mailbox: "leo@gmail.com" },
    });

  it("returns conflicts when the proposed window overlaps a busy event", async () => {
    seed([cal("c1", "2026-08-05T15:00:00+08:00", "2026-08-05T16:00:00+08:00")]);
    const api = new CockpitApi({
      statePath,
      personaDir,
      executor: sendingExecutor,
      calendarLister: () => async () => [
        { id: "evt", summary: "Existing standup", status: "confirmed",
          start: { dateTime: "2026-08-05T15:30:00+08:00" }, end: { dateTime: "2026-08-05T16:30:00+08:00" } },
      ],
    });
    const { conflicts } = await api.calendarConflicts("c1");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.event.summary).toBe("Existing standup");
  });

  it("returns [] when the window is clear", async () => {
    seed([cal("c1", "2026-08-05T15:00:00+08:00", "2026-08-05T16:00:00+08:00")]);
    const api = new CockpitApi({
      statePath,
      personaDir,
      executor: sendingExecutor,
      calendarLister: () => async () => [
        { id: "evt", summary: "Earlier", status: "confirmed",
          start: { dateTime: "2026-08-05T13:00:00+08:00" }, end: { dateTime: "2026-08-05T14:00:00+08:00" } },
      ],
    });
    expect((await api.calendarConflicts("c1")).conflicts).toEqual([]);
  });

  it("rejects a non-calendar action and an unknown id", async () => {
    seed([action({ id: "r1" })]); // a slack reply
    const api = new CockpitApi({ statePath, personaDir, executor: sendingExecutor });
    await expect(api.calendarConflicts("r1")).rejects.toThrow(/only for calendar/);
    await expect(api.calendarConflicts("nope")).rejects.toThrow(/unknown action/);
  });
});

describe("reTime (AI calendar re-time)", () => {
  const cal = (id: string, start: string, end: string) =>
    action({
      id,
      action_type: "calendar",
      draft: undefined,
      target: {},
      params: { title: id, start, end },
    });

  it("rewrites start/end from the LLM's parsed instruction and persists", async () => {
    seed([cal("c1", "2026-08-05T15:00:00+08:00", "2026-08-05T16:00:00+08:00")]);
    const jsonLlm: JsonLlmCaller = async () => ({
      start: "2026-08-07T15:00:00+08:00",
      end: "2026-08-07T16:00:00+08:00",
    });
    const api = new CockpitApi({ statePath, personaDir, executor: sendingExecutor, jsonLlm });
    const updated = await api.reTime("c1", "改到8月7号下午15:00-16:00");
    expect(updated.params.start).toBe("2026-08-07T15:00:00+08:00");
    expect(updated.params.end).toBe("2026-08-07T16:00:00+08:00");
    expect(loadState(statePath).actions.find((a) => a.id === "c1")!.params.start).toBe(
      "2026-08-07T15:00:00+08:00",
    );
  });

  it("normalizes a bare datetime to RFC3339 in the owner's zone", async () => {
    seed([cal("c1", "2026-08-05T15:00:00+08:00", "2026-08-05T16:00:00+08:00")]);
    const jsonLlm: JsonLlmCaller = async () => ({
      start: "2026-08-07T15:00",
      end: "2026-08-07T16:30",
    });
    const api = new CockpitApi({ statePath, personaDir, executor: sendingExecutor, jsonLlm });
    const updated = await api.reTime("c1", "延长半小时");
    // The offset is the machine zone's at that date (it used to be a hardcoded
    // +08:00). Assert the SHAPE plus agreement with toRfc3339 — hardcoding an
    // offset here would fail on any machine or CI runner in another zone.
    expect(updated.params.start).toMatch(/^2026-08-07T15:00:00([+-]\d{2}:\d{2}|Z)$/);
    expect(updated.params.start).toBe(toRfc3339("2026-08-07T15:00"));
    expect(updated.params.end).toBe(toRfc3339("2026-08-07T16:30"));
  });

  it("rejects unparseable LLM output without touching the card", async () => {
    seed([cal("c1", "2026-08-05T15:00:00+08:00", "2026-08-05T16:00:00+08:00")]);
    const api = new CockpitApi({
      statePath,
      personaDir,
      executor: sendingExecutor,
      jsonLlm: async () => ({ start: "not-a-time", end: "nope" }),
    });
    await expect(api.reTime("c1", "改成x")).rejects.toThrow(/couldn't parse/);
    expect(loadState(statePath).actions.find((a) => a.id === "c1")!.params.start).toBe(
      "2026-08-05T15:00:00+08:00",
    );
  });

  it("rejects end ≤ start", async () => {
    seed([cal("c1", "2026-08-05T15:00:00+08:00", "2026-08-05T16:00:00+08:00")]);
    const api = new CockpitApi({
      statePath,
      personaDir,
      executor: sendingExecutor,
      jsonLlm: async () => ({
        start: "2026-08-07T16:00:00+08:00",
        end: "2026-08-07T15:00:00+08:00",
      }),
    });
    await expect(api.reTime("c1", "改")).rejects.toThrow(/after start/);
  });

  it("rejects a non-calendar action and an empty instruction", async () => {
    seed([action({ id: "r1" })]); // a slack reply
    const api = new CockpitApi({ statePath, personaDir, executor: sendingExecutor });
    await expect(api.reTime("r1", "x")).rejects.toThrow(/only for calendar/);
    await expect(api.reTime("c1", "   ")).rejects.toThrow(/empty/);
  });
});

describe("tools config (Settings → Tools)", () => {
  // Same isolation trick as the settings tests: the api needs a state file
  // nested in a state/ dir so toolsPathFor resolves the config dir TWO levels
  // up into the per-test temp dir — not $TMPDIR (which would leak the config
  // across tests / test files).
  let toolsStatePath: string;
  beforeEach(() => {
    mkdirSync(join(dir, "state"), { recursive: true });
    toolsStatePath = join(dir, "state", "loop-state.json");
    writeFileSync(
      toolsStatePath,
      JSON.stringify({ version: 2, marks: {}, actions: [], outcomes: [], sourceErrors: {}, tasks: {} }),
    );
  });
  const toolsApi = () =>
    new CockpitApi({
      statePath: toolsStatePath,
      personaDir,
      executor: sendingExecutor,
      now: () => "2026-06-14T12:00:00Z",
    });

  it("getToolsConfig returns user overrides + the effective merged registry", async () => {
    const cfg = await toolsApi().getToolsConfig();
    expect(cfg.tools).toEqual({}); // no config file → no overrides
    expect(cfg.effective.jira).toBeDefined(); // built-in jira always present
  });

  it("setToolsConfig persists overrides; effective includes them", async () => {
    toolsApi().setToolsConfig({
      tools: { notion: { key: "notion", label: "Notion", requiredParams: ["title"] } },
    });
    const cfg = await toolsApi().getToolsConfig();
    expect(cfg.tools.notion?.label).toBe("Notion");
    expect(cfg.effective.notion?.label).toBe("Notion");
    expect(cfg.effective.jira).toBeDefined(); // built-ins survive the merge
  });
});

describe("comment — annotate without deciding", () => {
  // REGRESSION: the only free-text field used to live in the skip panel, so
  // leaving feedback rejected the card. 19 cards were annotated that way in one
  // sitting, several of them praised, and every one landed in the ledger as
  // `rejected`. A comment must never move a status or write a label.
  it("leaves the status untouched and writes NO label", () => {
    seed([action()]);
    const api = mkApi(sendingExecutor);
    const countLabels = () =>
      existsSync(labelsPathFor(statePath))
        ? readFileSync(labelsPathFor(statePath), "utf8").split("\n").filter(Boolean).length
        : 0;
    const before = countLabels();

    const out = api.comment("a1", "  this one is good, wrong date though  ");
    expect(out.status).toBe("suggested");
    expect(loadState(statePath).actions[0]!.status).toBe("suggested");

    expect(countLabels()).toBe(before); // the precision ledger stays decisions-only
  });

  it("appends, so refining a thought no longer needs restore + re-skip", () => {
    seed([action()]);
    const api = mkApi(sendingExecutor);
    api.comment("a1", "first");
    const out = api.comment("a1", "second");
    expect((out.params.comments as Array<{ text: string }>).map((c) => c.text)).toEqual([
      "first",
      "second",
    ]);
  });

  it("carries the full text into the activity log", () => {
    seed([action()]);
    mkApi(sendingExecutor).comment("a1", "wrong person — this is for Zack");
    const rows = readActivity(readFileSync(activityPathFor(statePath), "utf8"));
    const rec = rows.find((r) => r.kind === "comment");
    expect(rec).toBeTruthy();
    expect((rec!.data as { text?: string }).text).toBe("wrong person — this is for Zack");
  });

  // Commenting on something already decided is legitimate — refusing it would
  // recreate the coupling this exists to remove.
  it("works on an executed card too", () => {
    seed([action({ status: "executed", params: { execution_receipt: { kind: "local", ref: "l", at: "t" } } })]);
    expect(mkApi(sendingExecutor).comment("a1", "should not have sent this").status).toBe("executed");
  });

  it("refuses an empty comment", () => {
    seed([action()]);
    expect(() => mkApi(sendingExecutor).comment("a1", "   ")).toThrow(/empty/);
  });
});
