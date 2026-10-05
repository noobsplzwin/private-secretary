// Slack OAuth (PKCE) token store + auto-refresh — the Slack twin of
// google-oauth.ts.
//
// WHY PKCE: the old setup made every user create their own Slack app and
// paste an `xoxp-` token by hand (SETUP.md §2). To replace that with one
// "Connect" click we ship ONE Slack app's client_id, and PKCE lets a public
// client finish the exchange with no client_secret — Slack: "Refreshes for
// those tokens do not require a client_secret because they are intended to
// be used on a public client." Nothing passes through a Taiv server: the
// browser redirects to 127.0.0.1 on the user's own machine and this process
// talks to slack.com directly.
//
// TOKEN ROTATION is the cost of that. A PKCE app gets a short-lived
// access_token (~12h) plus a refresh_token that dies after 30 DAYS. A laptop
// closed for a month comes back needing full re-consent, which the cockpit
// must surface rather than failing silently.
//
// Keychain layout — two slots, one account key each (from identity.json):
//   taiv-secretary-slack        "xoxp-…"  the user's OWN app token, unthrottled
//   taiv-secretary-slack-oauth  {bundle}  ours, one-click, rate-limited
// Both may exist at once; resolveSlackCredential() decides which is used, and
// prefers the legacy one. Installs that predate the split hold a bundle in the
// first slot — that still resolves, and refreshes write back where they were
// found, so there is nothing to migrate.

import { getSecret, KeychainEntryMissing, setJSON, setSecret } from "./keychain.js";

// TWO slots, because the two credentials must coexist rather than overwrite
// each other. A hand-pasted token comes from the USER's own Slack app, which
// Slack treats as an internal custom app: 50+ req/min and 1000 objects per
// request. A token from our distributed app is capped at 1/min and 15 objects
// until we are listed on the Marketplace. Sharing one slot meant clicking
// Connect silently destroyed the only high-throughput credential — and it
// cannot be restored from here, because our flow can only ever issue OUR
// app's token.
export const SLACK_TOKEN_SERVICE = "taiv-secretary-slack";
export const SLACK_OAUTH_TOKEN_SERVICE = "taiv-secretary-slack-oauth";
export const SLACK_OAUTH_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
export const SLACK_OAUTH_TOKEN_URL = "https://slack.com/api/oauth.v2.access";

// The public client_id of the Taiv-owned Slack app. Public by design (PKCE
// means there is no secret to leak), so it is committed rather than stored in
// Keychain. Env override exists for staging apps and for anyone running their
// own Slack app instead of ours.
export const SLACK_CLIENT_ID =
  process.env.SLACK_CLIENT_ID ?? "11702423931251.11780990747270";

// Slack matches redirect_uri against the URLs registered in app settings, so
// unlike Google's loopback (any port) we can only use ports we pre-registered.
// Several, because a user's 4318 may already be taken.
export const SLACK_REDIRECT_PORTS: ReadonlyArray<number> = [4318, 4319, 4320];
export const SLACK_REDIRECT_PATH = "/slack/callback";

export function slackRedirectUri(port: number): string {
  return `http://localhost:${port}${SLACK_REDIRECT_PATH}`;
}

// User Token Scopes — the engine reads DMs and sends AS the user, so every
// scope is a user scope. Bot scopes are not merely unnecessary: Slack forbids
// them on desktop redirects ("Desktop redirects are not allowed to request bot
// scopes"), so asking for one would break the flow outright.
export const SLACK_USER_SCOPES: ReadonlyArray<string> = [
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "channels:read",
  "groups:read",
  "im:read",
  "mpim:read",
  "users:read",
  "users.profile:read",
  "chat:write",
  "files:read",
];

export interface SlackTokenBundle {
  access_token: string;
  refresh_token: string;
  // ms epoch. 0 means "never expires". Kept as a defensive branch only: with
  // the token-rotation setting never opted into, the live flow STILL returned a
  // ~12h rotating token (verified 2026-08-09), because a PKCE desktop redirect
  // rotates regardless. Do not treat non-rotating as a reachable happy path.
  expires_at: number;
  scope: string;
  team_id: string;
  team_name: string;
  user_id: string;
  granted_at: number;
  // ms epoch of the last successful issue/refresh. The refresh_token's 30-day
  // clock restarts every time it is used, so THIS — not expires_at — is what
  // says whether the connection is about to need human re-consent. Absent on
  // bundles written before this field existed; callers fall back to granted_at.
  refreshed_at?: number;
  client_id: string;
}

// Refresh this far ahead of expiry so a scan round never dies mid-flight on a
// token that expired between the check and the call.
const REFRESH_BUFFER_MS = 60_000;

type FetchFn = typeof fetch;
let fetchOverride: FetchFn | null = null;
export function __setSlackOAuthFetch(fn: FetchFn | null): void {
  fetchOverride = fn;
}
function getFetch(): FetchFn {
  return fetchOverride ?? globalThis.fetch;
}

// ─── PKCE ────────────────────────────────────────────────────────────

// RFC 7636: 43-128 chars from the unreserved set. 32 random bytes of
// base64url lands at 43 — the shortest compliant length, and the length
// Slack's own examples use.
export function createCodeVerifier(randomBytes: (n: number) => Buffer): string {
  return base64Url(randomBytes(32));
}

export function codeChallengeOf(
  verifier: string,
  sha256: (input: string) => Buffer,
): string {
  return base64Url(sha256(verifier));
}

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scopes?: ReadonlyArray<string>;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    // user_scope, NOT scope — `scope` requests BOT scopes, which a desktop
    // redirect may not ask for. Getting this wrong fails at the authorize
    // step with an opaque error.
    user_scope: (opts.scopes ?? SLACK_USER_SCOPES).join(","),
    redirect_uri: opts.redirectUri,
    code_challenge: opts.codeChallenge,
    // S256 is the only method Slack supports.
    code_challenge_method: "S256",
    state: opts.state,
  });
  return `${SLACK_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

// ─── token endpoint ──────────────────────────────────────────────────

interface SlackTokenResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  authed_user?: {
    id?: string;
    scope?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };
  team?: { id?: string; name?: string };
}

// Slack puts the user token under authed_user on the initial exchange, but the
// refresh response shape for user tokens is not documented. Accept BOTH
// nestings rather than betting on one — the cost is three `??` and it removes
// a whole class of "worked in dev, broke on refresh" failure.
function readTokenFields(json: SlackTokenResponse): {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  user_id: string;
} {
  const u = json.authed_user ?? {};
  const access_token = u.access_token ?? json.access_token ?? "";
  if (!access_token) {
    throw new Error("Slack OAuth response carried no user access_token");
  }
  return {
    access_token,
    refresh_token: u.refresh_token ?? json.refresh_token ?? "",
    expires_in: u.expires_in ?? json.expires_in ?? 0,
    scope: u.scope ?? json.scope ?? "",
    user_id: u.id ?? "",
  };
}

async function postForm(body: URLSearchParams): Promise<SlackTokenResponse> {
  const resp = await getFetch()(SLACK_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) {
    throw new Error(`Slack OAuth failed: HTTP ${resp.status} ${await resp.text()}`);
  }
  // Slack answers 200 with {ok:false,error:"…"} for real failures — status
  // alone tells you nothing.
  const json = (await resp.json()) as SlackTokenResponse;
  if (!json.ok) {
    throw new Error(`Slack OAuth failed: ${json.error ?? "unknown error"}`);
  }
  return json;
}

function bundleFrom(
  json: SlackTokenResponse,
  clientId: string,
  now: number,
  previous?: SlackTokenBundle,
): SlackTokenBundle {
  const f = readTokenFields(json);
  return {
    access_token: f.access_token,
    // A rotation-off app returns no refresh_token; keep the previous one on
    // refresh so we never blank a working credential.
    refresh_token: f.refresh_token || previous?.refresh_token || "",
    expires_at: f.expires_in ? now + f.expires_in * 1000 : 0,
    scope: f.scope || previous?.scope || "",
    team_id: json.team?.id ?? previous?.team_id ?? "",
    team_name: json.team?.name ?? previous?.team_name ?? "",
    user_id: f.user_id || previous?.user_id || "",
    granted_at: previous?.granted_at ?? now,
    refreshed_at: now,
    client_id: clientId,
  };
}

// Exchange the authorization code for a token bundle. No client_secret — the
// code_verifier is what proves this is the same client that started the flow.
export async function exchangeCode(opts: {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  now?: number;
}): Promise<SlackTokenBundle> {
  const json = await postForm(
    new URLSearchParams({
      client_id: opts.clientId,
      code: opts.code,
      code_verifier: opts.codeVerifier,
      redirect_uri: opts.redirectUri,
    }),
  );
  return bundleFrom(json, opts.clientId, opts.now ?? Date.now());
}

// Refresh a rotating token. Slack wants only grant_type + refresh_token +
// client_id here — no PKCE params, no secret.
export async function refreshBundle(
  bundle: SlackTokenBundle,
  now: number = Date.now(),
): Promise<SlackTokenBundle> {
  if (!bundle.refresh_token) {
    throw new Error("Slack token bundle has no refresh_token — re-consent required");
  }
  const json = await postForm(
    new URLSearchParams({
      client_id: bundle.client_id || SLACK_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: bundle.refresh_token,
    }),
  );
  return bundleFrom(json, bundle.client_id || SLACK_CLIENT_ID, now, bundle);
}

// ─── Keychain store (dual-mode) ──────────────────────────────────────

export function parseStoredToken(raw: string): SlackTokenBundle | string {
  const trimmed = raw.trim();
  // Legacy installs hold a bare xoxp- string. Detect by shape, not by a
  // try/catch on JSON.parse alone: a bare token is not valid JSON, but being
  // explicit keeps the two cases readable.
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as SlackTokenBundle;
    if (typeof parsed?.access_token === "string" && parsed.access_token) return parsed;
  } catch {
    // fall through — treat unparseable content as a raw token
  }
  return trimmed;
}

export function needsRefresh(bundle: SlackTokenBundle, now: number = Date.now()): boolean {
  // expires_at 0 = non-rotating token, valid until revoked.
  if (!bundle.expires_at) return false;
  return bundle.expires_at - now <= REFRESH_BUFFER_MS;
}

async function readSlot(
  service: string,
  account: string,
): Promise<SlackTokenBundle | string | null> {
  try {
    return parseStoredToken(await getSecret(service, account));
  } catch {
    return null;
  }
}

export interface ResolvedCredential {
  /** A hand-pasted token from the user's own app, or our OAuth bundle. */
  kind: "legacy" | "pkce";
  token: string;
  bundle?: SlackTokenBundle;
  /** Which Keychain service it came from — refreshes write back to the same one. */
  service: string;
}

// Which credential the runtime actually uses when both exist. LEGACY WINS, and
// that is the whole point: it is the unthrottled one. Preferring the newer
// credential would quietly cut a heavy user's throughput by ~50x.
export async function resolveSlackCredential(
  account: string,
): Promise<ResolvedCredential | null> {
  const primary = await readSlot(SLACK_TOKEN_SERVICE, account);
  if (typeof primary === "string") {
    return { kind: "legacy", token: primary, service: SLACK_TOKEN_SERVICE };
  }
  // A bundle can sit in EITHER slot: installs that predate the split wrote
  // theirs into the original slot. Refreshes write back where they were found,
  // so no migration step is needed.
  const bundle = primary ?? (await readSlot(SLACK_OAUTH_TOKEN_SERVICE, account));
  if (bundle && typeof bundle !== "string") {
    return {
      kind: "pkce",
      token: bundle.access_token,
      bundle,
      service: primary ? SLACK_TOKEN_SERVICE : SLACK_OAUTH_TOKEN_SERVICE,
    };
  }
  return null;
}

// THE read path every Slack caller goes through. Returns a usable bearer
// token, refreshing first when the stored bundle is close to expiry.
export async function readSlackToken(
  account: string,
  now: number = Date.now(),
): Promise<string> {
  const cred = await resolveSlackCredential(account);
  if (!cred) throw new KeychainEntryMissing(SLACK_TOKEN_SERVICE, account);
  if (cred.kind === "legacy" || !cred.bundle) return cred.token;
  if (!needsRefresh(cred.bundle, now)) return cred.token;
  const next = await refreshBundle(cred.bundle, now);
  await setJSON(cred.service, account, next);
  return next.access_token;
}

// The Connect flow writes to the OAuth slot only, so it can never clobber a
// hand-pasted token sitting in the legacy slot.
export async function saveSlackBundle(
  account: string,
  bundle: SlackTokenBundle,
): Promise<void> {
  await setJSON(SLACK_OAUTH_TOKEN_SERVICE, account, bundle);
}

// Store a token pasted from the user's own Slack app. Shape-checked here
// because the whole value of this path is that it is the unthrottled one — a
// bundle pasted in by mistake would silently be the throttled credential.
export async function saveLegacyToken(account: string, token: string): Promise<void> {
  const t = token.trim();
  if (!t.startsWith("xoxp-")) {
    throw new Error("Expected a user token starting with xoxp- (not a bot xoxb- token)");
  }
  // A pre-split install keeps its OAuth bundle in THIS slot, so writing here
  // blind would destroy it — the exact overwrite the two-slot split exists to
  // prevent. Relocate it first; reads already accept a bundle from either slot,
  // so moving it changes nothing except that it now survives.
  const existing = await readSlot(SLACK_TOKEN_SERVICE, account);
  if (existing && typeof existing !== "string") {
    await setJSON(SLACK_OAUTH_TOKEN_SERVICE, account, existing);
  }
  await setSecret(SLACK_TOKEN_SERVICE, account, t);
}
