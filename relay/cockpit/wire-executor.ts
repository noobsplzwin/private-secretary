// Wires the cockpit's approve flow to the real Direct-API executors.
// Lives apart from api.ts so the API core stays Keychain-free and
// unit-testable; this module is the prod adapter that builds the
// Slack / Gmail / Calendar clients from Keychain and adapts
// executeAction into the CockpitExecutor shape (action + persistClaim).
//
// Clients are built lazily + cached: the first approve spins up the
// Slack client + per-mailbox Gmail/Calendar clients; later approves
// reuse them. OAuth refresh happens inside the Gmail/Calendar clients
// via google-oauth, so a long-lived cockpit keeps working past token
// expiry without re-wiring.

import { buildRawMimeMessage } from "../sources/gmail-direct.js";
import { createSlackClientFromKeychain } from "../io/slack-api.js";
import { GmailClient } from "../io/gmail-api.js";
import { CalendarClient } from "../io/calendar-api.js";
import { KNOWN_MAILBOXES } from "../io/google-oauth.js";
import { effectiveToolSpecs } from "../io/tools.js";
import { createMcpToolRunner, mcpAuthServiceFor } from "../io/mcp-tool.js";
import { createJiraToolRunner } from "../io/jira-mcp.js";
import { createTickTickToolRunner } from "../io/ticktick-mcp.js";
import { loadState } from "../io/state.js";
import { unitKey } from "../core/unit-key.js";
import { executeAction, type ExecuteDeps, type ToolRunner } from "../proc/execute.js";
import type { CockpitExecutor } from "./api.js";
import type { ActionItem } from "../core/action-item.js";
import type { TaskPlan } from "../core/tasks.js";

// Lazy singletons — built on first use, reused after.
let depsPromise: Promise<Omit<ExecuteDeps, "now" | "persistClaim" | "tools">> | null = null;

async function buildDeps(): Promise<Omit<ExecuteDeps, "now" | "persistClaim" | "tools">> {
  if (depsPromise) return depsPromise;
  depsPromise = (async () => {
    const slack = await createSlackClientFromKeychain();
    const gmail: Record<string, GmailClient> = {};
    const calendar: Record<string, CalendarClient> = {};
    for (const email of KNOWN_MAILBOXES) {
      gmail[email] = new GmailClient({ email });
      calendar[email] = new CalendarClient({ email });
    }
    return { slack, gmail, calendar };
  })();
  return depsPromise;
}

// A runner for EVERY configured tool (effective registry), resolved fresh on
// each approve so a tool added in Settings takes effect without a restart.
// A tool configured with `type: "mcp"` + `url` uses the REAL MCP client
// (relay/io/mcp-tool.ts — Streamable HTTP + OAuth, the Notion-style flow);
// anything else stays a STUB (returns a synthetic ref + logs a warning) until
// its real integration lands.
function toolStubs(statePath: string): Record<string, ToolRunner> {
  const runners: Record<string, ToolRunner> = {};
  for (const [key, spec] of Object.entries(effectiveToolSpecs(statePath))) {
    const cfg = spec.config ?? {};
    if (cfg.type === "mcp" && cfg.url) {
      const runnerOpts = {
        url: cfg.url,
        authService: mcpAuthServiceFor(key, cfg.authService),
        defaultTool: cfg.defaultTool,
      };
      // Jira needs field mapping (project→projectKey, issueTypeName default,
      // assignee→assignee_account_id) that other generic MCP tools don't.
      runners[key] = key === "jira" ? createJiraToolRunner(runnerOpts) : createMcpToolRunner(runnerOpts);
    } else {
      runners[key] = {
        async run() {
          const ref = `${key.toUpperCase()}-STUB-${Date.now().toString(36).toUpperCase()}`;
          console.warn(`[${key}] STUB — no real ${key} created (${ref})`);
          return { ref };
        },
      };
    }
  }
  return runners;
}

// The REAL TickTick runner, or undefined when TickTick isn't connected. Kept
// out of toolStubs deliberately: every registry key gets a stub there, and a
// task card routed through a stub would report success while creating nothing.
// Undefined here means `task` cards stay local (relay/proc/execute.ts).
function ticktickRunner(statePath: string): ToolRunner | undefined {
  const spec = effectiveToolSpecs(statePath).ticktick;
  const cfg = spec?.config ?? {};
  if (cfg.type !== "mcp" || !cfg.url) return undefined;
  return createTickTickToolRunner({
    url: cfg.url,
    authService: mcpAuthServiceFor("ticktick", cfg.authService),
    ...(cfg.project ? { project: cfg.project } : {}),
  });
}

// The destination list NAME + the plan tier are what turn a bare `task` card
// into a filed, prioritised TickTick to-do.
function planLookup(statePath: string): (action: ActionItem) => TaskPlan | undefined {
  return (action) => {
    try {
      return loadState(statePath).plans?.[unitKey(action)];
    } catch {
      return undefined; // a missing/corrupt state file must not block an approve
    }
  };
}

export function createWiredExecutor(
  statePath: string,
  now: () => string = () => new Date().toISOString(),
): CockpitExecutor {
  return async (action: ActionItem, persistClaim) => {
    const base = await buildDeps();
    // Gmail reply/relay/forward need a raw MIME body. The scan/LLM path
    // should have populated params.raw_mime; if it didn't but we have a
    // draft + recipient, assemble one here so the executor has something
    // to draft. (Belt-and-suspenders — the LLM path is expected to set it.)
    const prepared = ensureGmailRaw(action);
    const ticktick = ticktickRunner(statePath);
    return executeAction(prepared, {
      ...base,
      tools: toolStubs(statePath),
      ...(ticktick ? { ticktick } : {}),
      planFor: planLookup(statePath),
      now,
      persistClaim,
    });
  };
}

// If a Gmail-targeted reply/relay/forward lacks params.raw_mime but has a
// draft + the bits to build one, assemble it. Mailbox + recipient + subject
// come from params/context the scan persisted.
function ensureGmailRaw(action: ActionItem): ActionItem {
  if (action.target?.platform !== "gmail") return action;
  if (typeof action.params.raw_mime === "string") return action;
  const draft = action.draft;
  const to = typeof action.params.to === "string" ? action.params.to : action.context?.sender_handle;
  const from = typeof action.params.mailbox === "string" ? action.params.mailbox : undefined;
  const subject =
    typeof action.params.subject === "string" ? action.params.subject : "Re: (no subject)";
  if (typeof draft !== "string" || !to || !from) return action; // executor will error clearly
  const raw = buildRawMimeMessage({
    from,
    to,
    subject,
    body: draft,
    inReplyTo: typeof action.params.in_reply_to === "string" ? action.params.in_reply_to : undefined,
  });
  return { ...action, params: { ...action.params, raw_mime: raw } };
}
