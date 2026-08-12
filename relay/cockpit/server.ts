// Cockpit HTTP server. Loopback-only, dependency-free (node:http). Serves
// the single-page UI + a small JSON API that drives CockpitApi. Security
// baseline (T8) enforced via security.ts on every request.
//
// Routes:
//   GET  /                       → web/dist/index.html, the React app (CSRF token
//                                  injected; build-hint page when dist is missing)
//   GET  /index.html             → same as /
//   GET  /assets/**              → vite build output (hashed, immutable cache;
//                                  whitelisted extensions, contained in web/dist)
//   GET  /api/state              → CockpitState (queue, counts, gate, errors)
//   GET  /api/personas           → persona[] for the People screen
//   GET  /api/activity?tail=&kind= → activity-log tail (F3, read-only)
//   GET  /api/calendar/events?start=&end= → week of Google Calendar events
//                                  (read-only; Calendar screen)
//   GET  /api/settings             → llm config + per-service key status (masked)
//   POST /api/settings/llm         → {mode, draftModel} → config file (daemon restart)
//   POST /api/settings/keys        → {service, value} → macOS Keychain (value never logged)
//   GET  /api/settings/google      → Google setup status (client + per-mailbox authorized)
//   POST /api/settings/google/client    → {json} → OAuth client JSON → Keychain (never logged)
//   POST /api/settings/google/authorize → {mailbox} → spawn browser consent flow
//   POST /api/actions/:id/approve   → approve + execute
//   POST /api/actions/:id/edit      → {draft?, params?}
//   POST /api/actions/:id/skip
//   POST /api/actions/:id/comment  → {text}  (annotate; NO status change, NO label)
//   POST /api/actions/:id/restore
//   POST /api/actions/:id/mark-sent → {ref?}  (awaiting-manual → executed)
//   POST /api/flush-auto             → auto-execute task/ignore ≥0.9
//
// The server NEVER mutates loop-state itself — every write goes through
// CockpitApi → relay/core + the lock.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, resolve, sep } from "node:path";
import {
  CockpitApi,
  CockpitBadRequestError,
  CockpitBadStateError,
  CockpitBusyError,
  CockpitNotFoundError,
  type CockpitApiOptions,
} from "./api.js";
import { checkRequest, loadOrMintCsrfToken } from "./security.js";
import { startGmailReauth } from "./reauth.js";
import {
  addLegacyWorkspace,
  disconnectSlack,
  InvalidSlackToken,
  slackConnectionStatus,
  startSlackConnect,
} from "./slack-connect.js";
import { saveLegacyToken } from "../io/slack-oauth.js";
import { SLACK_TOKEN_ACCOUNT } from "../io/slack-api.js";
import { loadIdentity } from "../io/identity.js";
import { identityStatus, InvalidIdentity, writeIdentity } from "../io/identity-store.js";
import { restartDaemon } from "./daemon-control.js";
import { captureRunningSha, restartServices, runUpdate, updateStatus } from "./updater.js";
import { loadSettings } from "../io/settings.js";
import {
  bootstrapState,
  InvalidBootstrapRequest,
  startPersonaBootstrap,
  validateRequest,
} from "./persona-bootstrap.js";
import { spawn } from "node:child_process";
import { InvalidActionTransition } from "../core/action-item.js";
import {
  EXISTENCE_VERDICTS,
  FIELD_ERRORS,
  type ExistenceVerdict,
  type FieldError,
} from "../io/labels.js";
import { ACTIVITY_KINDS, type ActivityKind } from "../io/activity-log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// The React app's build output (`npm run cockpit:build`). Served for "/" and
// "/assets/**".
const DEFAULT_WEB_DIST_DIR = join(__dirname, "web", "dist");
// How often an auto-updating install looks for a new version. Half an hour is
// slow enough that the git fetch is invisible and fast enough that a fix lands
// the same working day.
const AUTO_UPDATE_INTERVAL_MS = 30 * 60 * 1000;

export interface CockpitServerOptions extends CockpitApiOptions {
  port?: number; // default 4317
  host?: string; // default 127.0.0.1 — do NOT change to 0.0.0.0
  // Overrides the web/dist location — tests point this at a temp fixture so
  // they never depend on a real build. Defaults to DEFAULT_WEB_DIST_DIR.
  webDistDir?: string;
}

export interface RunningCockpit {
  server: Server;
  port: number;
  url: string;
  csrfToken: string;
  close: () => Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

// Extensions servable from web/dist/assets — vite's hashed build output plus
// the static kinds the app references. Anything else (TS sources, configs…)
// is a 404 even if the file exists.
const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

// Served at "/" when the React app hasn't been built yet (fresh clone, or
// cockpit started before `npm run cockpit:build`). HTTP 200 with instructions,
// not an error — the API routes work regardless.
const BUILD_HINT_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>secretary</title></head>
<body style="font-family: ui-monospace, monospace; padding: 2rem; color: #1A1D21;">
<p>Cockpit web app is not built yet.</p>
<p>Run <code>npm run cockpit:build</code>, then reload this page.</p>
</body></html>`;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function errorStatus(e: unknown): { status: number; message: string } {
  if (e instanceof CockpitNotFoundError) return { status: 404, message: e.message };
  if (e instanceof CockpitBusyError) return { status: 409, message: e.message };
  if (e instanceof CockpitBadStateError) return { status: 409, message: e.message };
  if (e instanceof InvalidActionTransition) return { status: 400, message: e.message };
  if (e instanceof CockpitBadRequestError) return { status: 400, message: e.message };
  return { status: 500, message: (e as Error).message ?? "internal error" };
}

export function createCockpitServer(opts: CockpitServerOptions): {
  server: Server;
  csrfToken: string;
  host: string;
  port: number;
} {
  const api = new CockpitApi(opts);
  // Record the commit THIS process loaded, before anything can pull a new one.
  void captureRunningSha();

  // Kick both agents over. Deferred a beat so the HTTP response that triggered
  // it is on the wire before launchctl kills the process writing it.
  function applyRestart(): void {
    setTimeout(() => {
      restartServices((file, args) => {
        spawn(file, args, { detached: true, stdio: "ignore" }).unref();
      });
    }, 500).unref();
  }

  // Unattended updates, when the owner asked for them. Checked here rather
  // than in the daemon because the cockpit is what already knows how to
  // update; the setting is re-read every tick so toggling it takes effect
  // without a restart. A dirty checkout or a failed step just leaves the
  // install where it was — runUpdate never resets or force-merges.
  const t = setInterval(() => {
    void (async () => {
      if (!loadSettings(opts.statePath).autoUpdate) return;
      const r = await runUpdate().catch(() => null);
      if (r?.ok && r.needsRestart) applyRestart();
    })();
  }, AUTO_UPDATE_INTERVAL_MS);
  t.unref(); // a background timer must never hold the process (or a test) open
  // Persisted in the state dir so a restart reuses the same token (open tabs
  // keep working instead of failing CSRF on the next approve).
  const csrfToken = loadOrMintCsrfToken(dirname(opts.statePath));
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 4317;
  // resolve() up front so the /assets containment check below compares
  // absolute, normalized paths.
  const webDistDir = resolve(opts.webDistDir ?? DEFAULT_WEB_DIST_DIR);

  const server = createServer((req, res) => {
    void handle(req, res).catch((e) => {
      const { status, message } = errorStatus(e);
      if (!res.headersSent) sendJson(res, status, { error: message });
    });
  });

  // The port to validate Host/Origin against — the ACTUAL bound port,
  // resolved at request time so port:0 (ephemeral, tests) works.
  function effectivePort(): number {
    const addr = server.address();
    return addr && typeof addr !== "string" ? addr.port : port;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const boundPort = effectivePort();
    const url = new URL(req.url ?? "/", `http://${host}:${boundPort}`);
    const path = url.pathname;

    // ── security gate (every request) ────────────────────────────
    const verdict = checkRequest({
      method,
      host: req.headers.host,
      origin: typeof req.headers.origin === "string" ? req.headers.origin : undefined,
      csrfHeader: typeof req.headers["x-csrf-token"] === "string"
        ? (req.headers["x-csrf-token"] as string)
        : undefined,
      expectedCsrf: csrfToken,
      port: boundPort,
    });
    if (!verdict.ok) {
      sendJson(res, verdict.status, { error: verdict.reason });
      return;
    }

    // ── static + index ──────────────────────────────────────────
    // The React app: web/dist/index.html with the CSRF token injected (same
    // mechanism as the legacy SPA — src/lib/api.ts reads the meta). no-store:
    // the token must never come from a cache. Missing dist → build hint.
    // replaceAll: a stray literal placeholder (e.g. in an HTML comment) must
    // never leave the <meta> itself uninjected.
    if (method === "GET" && (path === "/" || path === "/index.html")) {
      let html: string;
      try {
        html = readFileSync(join(webDistDir, "index.html"), "utf8").replaceAll(
          "__CSRF_TOKEN__",
          csrfToken,
        );
      } catch {
        html = BUILD_HINT_HTML;
      }
      res.writeHead(200, { "Content-Type": CONTENT_TYPES[".html"], "Cache-Control": "no-store" });
      res.end(html);
      return;
    }
    // Vite build output. Filenames carry a content hash, so immutable caching
    // is safe (index.html above stays no-store and points at the new hashes
    // after each build). The resolved path must stay inside webDistDir (../
    // traversal rejected) and the extension must be whitelisted.
    if (method === "GET" && path.startsWith("/assets/")) {
      const file = resolve(webDistDir, "." + path);
      const contentType = ASSET_CONTENT_TYPES[extname(file)];
      if (!contentType || !file.startsWith(webDistDir + sep)) {
        sendJson(res, 404, { error: `no route: ${method} ${path}` });
        return;
      }
      let body: Buffer;
      try {
        body = readFileSync(file); // binary-safe: .png/.woff2/.ico are servable
      } catch {
        sendJson(res, 404, { error: `no route: ${method} ${path}` });
        return;
      }
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      res.end(body);
      return;
    }

    // ── API ──────────────────────────────────────────────────────
    if (path === "/api/state" && method === "GET") {
      sendJson(res, 200, api.getState());
      return;
    }
    if (path === "/api/personas" && method === "GET") {
      sendJson(res, 200, { personas: api.getPeople() });
      return;
    }
    if (path === "/api/projects" && method === "GET") {
      sendJson(res, 200, api.getProjects());
      return;
    }
    // F3 activity log (read-only): the engine's operational trail for the
    // Activity screen. ?kind= is validated against the known kinds; ?tail=
    // is capped inside getActivity.
    if (path === "/api/activity" && method === "GET") {
      const tailParam = Number(url.searchParams.get("tail") ?? "100");
      const kindParam = url.searchParams.get("kind");
      const kind = kindParam && ACTIVITY_KINDS.has(kindParam) ? (kindParam as ActivityKind) : undefined;
      sendJson(res, 200, api.getActivity({
        tail: Number.isFinite(tailParam) ? tailParam : 100,
        ...(kind ? { kind } : {}),
      }));
      return;
    }
    if (path === "/api/flush-auto" && method === "POST") {
      const n = await api.flushAutoExecute();
      sendJson(res, 200, { autoHandled: n });
      return;
    }

    // Calendar screen's read-only week feed. start/end must both parse as
    // dates; Calendar API failures surface as 500 with the message so the
    // screen can show its error strip (expired token etc.).
    if (path === "/api/calendar/events" && method === "GET") {
      const start = url.searchParams.get("start");
      const end = url.searchParams.get("end");
      if (!start || !end || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) {
        sendJson(res, 400, { error: "start and end (ISO dates) required" });
        return;
      }
      sendJson(res, 200, await api.getCalendarEvents({ timeMin: start, timeMax: end }));
      return;
    }

    // Read-only conflict pre-check for ONE calendar card (the Queue's
    // conflict line). Same conflict logic as approve, never inserts.
    if (method === "GET") {
      const conflictMatch = path.match(/^\/api\/actions\/([^/]+)\/calendar-conflicts$/);
      if (conflictMatch) {
        const id = decodeURIComponent(conflictMatch[1]!);
        sendJson(res, 200, await api.calendarConflicts(id));
        return;
      }
    }

    // Settings screen (S3). Read is free-form; both writes validate the body
    // here (shape) and inside CockpitApi (enum/whitelist → 400). Key values
    // pass straight through to the Keychain — they are never logged.
    if (path === "/api/settings" && method === "GET") {
      sendJson(res, 200, await api.getSettings());
      return;
    }
    if (path === "/api/settings/auto-update" && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown>;
      sendJson(res, 200, api.setAutoUpdate({ autoUpdate: body.autoUpdate === true }));
      return;
    }
    if (path === "/api/settings/timezone" && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown>;
      sendJson(res, 200, api.setTimezone({ timezone: String(body.timezone ?? "") }));
      return;
    }
    if (path === "/api/settings/llm" && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown>;
      if (typeof body.mode !== "string" || typeof body.draftModel !== "string") {
        sendJson(res, 400, { error: "mode and draftModel (strings) required" });
        return;
      }
      sendJson(res, 200, api.setLlm({ mode: body.mode, draftModel: body.draftModel }));
      return;
    }
    if (path === "/api/settings/keys" && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown>;
      if (typeof body.service !== "string" || typeof body.value !== "string") {
        sendJson(res, 400, { error: "service and value (strings) required" });
        return;
      }
      sendJson(res, 200, await api.setApiKey({ service: body.service, value: body.value }));
      return;
    }

    // Settings Google tab: first-time Gmail + Calendar onboarding. The client
    // JSON passes straight through to the Keychain after shape validation
    // inside CockpitApi — like the API keys, it is never logged. authorize
    // validates the mailbox against the identity config before it reaches
    // the spawned consent script's argv.
    if (path === "/api/settings/tools" && method === "GET") {
      sendJson(res, 200, await api.getToolsConfig());
      return;
    }
    if (path === "/api/settings/tools" && method === "POST") {
      const body = (await readBody(req)) as { tools?: Record<string, unknown> };
      sendJson(res, 200, api.setToolsConfig({ tools: body.tools }));
      return;
    }
    // OAuth connect for a URL-based MCP tool (Settings → Tools "Connect"). Runs
    // the browser flow; the request holds until the token is stored.
    const authorizeMatch = path.match(/^\/api\/settings\/tools\/([^/]+)\/authorize$/);
    if (authorizeMatch && method === "POST") {
      const toolKey = decodeURIComponent(authorizeMatch[1]!);
      sendJson(res, 200, await api.authorizeTool(toolKey));
      return;
    }
    // Drop a tool's stored OAuth token (Connections "Disconnect"). Local only —
    // MCP servers expose no documented revoke, so the grant may live on at the
    // provider.
    const deauthMatch = path.match(/^\/api\/settings\/tools\/([^/]+)\/deauthorize$/);
    if (deauthMatch && method === "POST") {
      const toolKey = decodeURIComponent(deauthMatch[1]!);
      sendJson(res, 200, await api.deauthorizeTool(toolKey));
      return;
    }
    if (path === "/api/settings/google" && method === "GET") {
      sendJson(res, 200, await api.getGoogleSetup());
      return;
    }
    if (path === "/api/settings/google/client" && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown>;
      if (typeof body.json !== "string" || !body.json.trim()) {
        sendJson(res, 400, { error: "json (string) required" });
        return;
      }
      sendJson(res, 200, await api.setGoogleClientJson(body.json));
      return;
    }
    if (path === "/api/settings/google/authorize" && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown>;
      const mailbox = typeof body.mailbox === "string" ? body.mailbox.trim() : "";
      if (!mailbox) {
        sendJson(res, 400, { error: "mailbox required" });
        return;
      }
      sendJson(res, 200, await api.authorizeGoogleMailbox(mailbox));
      return;
    }

    // Re-authorize a Gmail mailbox whose refresh_token expired (the Connections
    // "Reconnect" button). Spawns the consent flow (opens the browser); the
    // daemon picks up the fresh token on its next tick.
    if (path === "/api/connections/gmail/reauth" && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown>;
      const mailbox = typeof body.mailbox === "string" ? body.mailbox.trim() : "";
      if (!mailbox) {
        sendJson(res, 400, { error: "mailbox required" });
        return;
      }
      const result = await startGmailReauth(mailbox);
      sendJson(res, result.started ? 200 : 400, result);
      return;
    }

    // Software update. Inspect and apply; the restart is not a third step the
    // user has to find, it follows a successful apply automatically. The
    // cockpit is one of the processes being restarted, so it cannot report the
    // outcome of its own restart — the browser confirms by watching the
    // reported commit change instead.
    if (path === "/api/update" && method === "GET") {
      // ?force=1 is the explicit check; a plain load answers from cache.
      sendJson(res, 200, await updateStatus(undefined, { force: url.searchParams.get("force") === "1" }));
      return;
    }
    if (path === "/api/update" && method === "POST") {
      const r = await runUpdate();
      sendJson(res, r.ok ? 200 : 400, r);
      if (r.ok && r.needsRestart) applyRestart();
      return;
    }

    // Persona bootstrap. The cockpit does not run it — see persona-bootstrap.ts
    // for why — it reports the ledger the skill writes, and starts the session.
    if (path === "/api/personas/bootstrap" && method === "GET") {
      sendJson(res, 200, bootstrapState(opts.statePath));
      return;
    }
    if (path === "/api/personas/bootstrap" && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown>;
      try {
        const started = startPersonaBootstrap(
          opts.statePath,
          validateRequest({
            contacts: body.contacts as string,
            historyYears: body.historyYears as number,
            dryRun: body.dryRun === true,
          }),
          (file, args) => {
            spawn(file, args, { detached: true, stdio: "ignore" }).unref();
          },
        );
        sendJson(res, 200, { ok: true, ...started });
      } catch (e) {
        if (e instanceof InvalidBootstrapRequest) throw new CockpitBadRequestError(e.message);
        throw e;
      }
      return;
    }

    // Who this instance belongs to. A fresh install has no config/identity.json
    // (it is gitignored), and without it nothing polls and Connect is inert —
    // so the cockpit has to be able to create it.
    if (path === "/api/identity" && method === "GET") {
      sendJson(res, 200, identityStatus(loadIdentity()));
      return;
    }
    if (path === "/api/identity" && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown>;
      try {
        writeIdentity({
          primaryEmail: String(body.primaryEmail ?? ""),
          ...(Array.isArray(body.mailboxes) ? { mailboxes: body.mailboxes as string[] } : {}),
        });
      } catch (e) {
        if (e instanceof InvalidIdentity) {
          sendJson(res, 400, { error: e.message });
          return;
        }
        throw e;
      }
      // The daemon caches identity for its process lifetime, so saving alone
      // would leave it polling nothing until something else restarted it.
      const daemon = await restartDaemon();
      sendJson(res, 200, { ...identityStatus(loadIdentity()), daemonRestarted: daemon.restarted });
      return;
    }

    // Slack credential status — drives the Connections card between "not
    // connected" (first run), a legacy hand-pasted token, and a rotating PKCE
    // bundle with an expiry.
    if (path === "/api/connections/slack" && method === "GET") {
      sendJson(res, 200, await slackConnectionStatus());
      return;
    }

    // Disconnect Slack: revoke at Slack, then delete the local token.
    if (path === "/api/connections/slack/disconnect" && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown>;
      const account = typeof body.account === "string" ? body.account.trim() : "";
      // Defaults to our own credential. Removing the user's own app token is
      // unrecoverable from here, so it must be named.
      const which = body.which === "legacy" ? "legacy" : "oauth";
      sendJson(res, 200, await disconnectSlack(account || undefined, undefined, which));
      return;
    }

    // Register a NEW workspace straight from a token pasted out of the user's
    // own Slack app. The one-click add can only mint our rate-limited token, so
    // this is the path that works for a heavy mailbox.
    if (path === "/api/connections/slack/add-legacy" && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown>;
      try {
        sendJson(res, 200, await addLegacyWorkspace(String(body.token ?? "")));
      } catch (e) {
        if (e instanceof InvalidSlackToken || e instanceof InvalidIdentity) {
          sendJson(res, 400, { error: e.message });
          return;
        }
        // A token that cannot answer auth.test is the user's problem to fix,
        // not a server fault — say what Slack said.
        sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }

    // Store a token pasted from the user's OWN Slack app. That credential is
    // an internal custom app to Slack — 50+ req/min against our 1/min — so it
    // stays the only workable path for a heavy mailbox until we are listed.
    if (path === "/api/connections/slack/legacy" && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown>;
      const token = typeof body.token === "string" ? body.token : "";
      const target = typeof body.account === "string" && body.account.trim()
        ? body.account.trim()
        : SLACK_TOKEN_ACCOUNT;
      try {
        await saveLegacyToken(target, token);
      } catch (e) {
        sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
        return;
      }
      sendJson(res, 200, await slackConnectionStatus());
      return;
    }

    // Connect / reconnect Slack. Same shape as the Gmail reauth above: spawn
    // the consent flow (opens the browser) and answer immediately.
    if (path === "/api/connections/slack/connect" && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown>;
      const account = typeof body.account === "string" ? body.account.trim() : "";
      // mode "add" authorizes an ADDITIONAL workspace and registers it in
      // identity.json; the account key is only knowable after the user picks a
      // workspace on Slack's page.
      const mode = body.mode === "add" ? "add" : "reauth";
      const result = startSlackConnect(account || undefined, undefined, mode);
      sendJson(res, result.started ? 200 : 400, result);
      return;
    }

    const actionMatch = path.match(/^\/api\/actions\/([^/]+)\/([a-z-]+)$/);
    if (actionMatch && method === "POST") {
      const id = decodeURIComponent(actionMatch[1]!);
      const op = actionMatch[2]!;
      const body = (await readBody(req)) as Record<string, unknown>;
      switch (op) {
        case "approve":
          sendJson(res, 200, await api.approve(id));
          return;
        case "edit":
          sendJson(res, 200, {
            action: api.edit(id, {
              draft: typeof body.draft === "string" ? body.draft : undefined,
              params: typeof body.params === "object" && body.params !== null
                ? (body.params as Record<string, unknown>)
                : undefined,
            }),
          });
          return;
        case "skip": {
          // P0 typed skip: the reason is the whole point of the埋点. Validated
          // against the enums so a stray UI value can't poison the ledger.
          const existence =
            typeof body.existence === "string" && EXISTENCE_VERDICTS.has(body.existence)
              ? (body.existence as ExistenceVerdict)
              : undefined;
          const field_errors = Array.isArray(body.field_errors)
            ? body.field_errors.filter(
                (f): f is FieldError => typeof f === "string" && FIELD_ERRORS.has(f),
              )
            : undefined;
          sendJson(res, 200, {
            action: api.skip(id, {
              existence,
              field_errors,
              note: typeof body.note === "string" ? body.note.slice(0, 500) : undefined,
            }),
          });
          return;
        }
        case "comment": {
          // Annotating is NOT deciding: no status change, no label. Bounded the
          // same way the skip note is, so one paste can't bloat loop-state.
          const text = typeof body.text === "string" ? body.text.slice(0, 2000) : "";
          if (!text.trim()) {
            sendJson(res, 400, { error: "comment text is required" });
            return;
          }
          sendJson(res, 200, { action: api.comment(id, text) });
          return;
        }
        case "done":
          sendJson(res, 200, { action: api.markDone(id) });
          return;
        case "re-time":
          sendJson(res, 200, {
            action: await api.reTime(
              id,
              typeof body.instruction === "string" ? body.instruction : "",
            ),
          });
          return;
        case "restore":
          sendJson(res, 200, { action: api.restore(id) });
          return;
        case "mark-sent":
          sendJson(res, 200, {
            action: api.markSent(id, typeof body.ref === "string" ? body.ref : undefined),
          });
          return;
        default:
          sendJson(res, 404, { error: `unknown op: ${op}` });
          return;
      }
    }

    // Manual tier override: drag a task to another A/B/C/D section. tier null/""
    // clears the override (back to the AI ranking).
    const tierMatch = path.match(/^\/api\/tasks\/([^/]+)\/tier$/);
    if (tierMatch && method === "POST") {
      const key = decodeURIComponent(tierMatch[1]!);
      const body = (await readBody(req)) as Record<string, unknown>;
      const tier = typeof body.tier === "string" && ["A", "B", "C", "D"].includes(body.tier)
        ? (body.tier as "A" | "B" | "C" | "D")
        : null;
      sendJson(res, 200, api.setTier(key, tier));
      return;
    }

    sendJson(res, 404, { error: `no route: ${method} ${path}` });
  }

  return { server, csrfToken, host, port };
}

// Start + bind. Resolves once listening so callers (and tests) get the
// real port (0 → ephemeral).
export async function startCockpit(opts: CockpitServerOptions): Promise<RunningCockpit> {
  const { server, csrfToken, host, port } = createCockpitServer(opts);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  const boundPort = addr && typeof addr !== "string" ? addr.port : port;
  const url = `http://${host}:${boundPort}`;
  return {
    server,
    port: boundPort,
    url,
    csrfToken,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
