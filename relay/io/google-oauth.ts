// Google OAuth token store + auto-refresh.
//
// scripts/auth/google-oauth.ts handles the one-time browser consent
// dance (per mailbox); this file is the headless runtime path: load a
// stored token bundle from Keychain, refresh the access_token when it's
// close to expiry, write it back. Used by every Gmail / Calendar API
// caller in the runtime.
//
// Keychain layout (set up by scripts/auth/google-oauth.ts):
//   service:  taiv-secretary-token-google
//   account:  <mailbox email>
//   value:    StoredTokenBundle JSON
//
// One process-shared cache in front of Keychain keeps a hot token
// in memory across rapid back-to-back API calls without re-hitting
// the `security` binary every time.

import { loadIdentity } from "./identity.js";
import { getJSON, setJSON } from "./keychain.js";

export const TOKEN_KEYCHAIN_SERVICE = "taiv-secretary-token-google";

export interface OAuthClientJson {
  installed: {
    client_id: string;
    client_secret: string;
    auth_uri: string;
    token_uri: string;
    redirect_uris: string[];
  };
}

export interface StoredTokenBundle {
  refresh_token: string;
  access_token: string;
  expires_at: number; // ms epoch when access_token expires
  scope: string;
  granted_at: number; // ms epoch of initial consent
  email: string;
  oauth_client_service: string;
  oauth_client_account: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type: string;
}

// Treat tokens as "expiring soon" inside this window — refresh proactively
// instead of letting a request fail with 401 mid-call.
const REFRESH_BUFFER_MS = 60_000;

// Module-scope cache so repeated calls within one process don't thrash
// Keychain or the token endpoint. Keyed by email.
const tokenCache = new Map<string, { bundle: StoredTokenBundle }>();

export function clearTokenCache(): void {
  tokenCache.clear();
}

async function loadBundle(email: string): Promise<StoredTokenBundle> {
  const cached = tokenCache.get(email);
  if (cached) return cached.bundle;
  const bundle = await getJSON<StoredTokenBundle>(TOKEN_KEYCHAIN_SERVICE, email);
  tokenCache.set(email, { bundle });
  return bundle;
}

async function persistBundle(bundle: StoredTokenBundle): Promise<void> {
  await setJSON(TOKEN_KEYCHAIN_SERVICE, bundle.email, bundle);
  tokenCache.set(bundle.email, { bundle });
}

function nowMs(): number {
  return Date.now();
}

// Inject for tests so we don't actually hit accounts.google.com.
type FetchFn = typeof fetch;
let fetchOverride: FetchFn | null = null;
export function __setOAuthFetch(fn: FetchFn | null): void {
  fetchOverride = fn;
}
function getFetch(): FetchFn {
  return fetchOverride ?? globalThis.fetch;
}

// Exchange a refresh_token for a new access_token. Doesn't touch
// Keychain — caller decides whether to persist (we always do, but
// keeping the API surface narrow helps the test).
async function exchangeRefreshToken(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenUri: string;
}): Promise<TokenResponse> {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    refresh_token: opts.refreshToken,
    grant_type: "refresh_token",
  });
  const resp = await getFetch()(opts.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `OAuth refresh failed for ${opts.clientId}: HTTP ${resp.status} ${text}`,
    );
  }
  return (await resp.json()) as TokenResponse;
}

// Get a valid access_token for a mailbox, refreshing if it's expired or
// about to expire. Returns the live bundle so callers can also see scope
// + expiry.
export async function getAccessToken(email: string): Promise<StoredTokenBundle> {
  const bundle = await loadBundle(email);
  if (bundle.expires_at - nowMs() > REFRESH_BUFFER_MS) {
    return bundle;
  }
  // Refresh.
  const client = await getJSON<OAuthClientJson>(
    bundle.oauth_client_service,
    bundle.oauth_client_account,
  );
  let tokens: TokenResponse;
  try {
    tokens = await exchangeRefreshToken({
      clientId: client.installed.client_id,
      clientSecret: client.installed.client_secret,
      refreshToken: bundle.refresh_token,
      tokenUri: client.installed.token_uri,
    });
  } catch (e) {
    // The stored refresh_token failed (expired/revoked invalid_grant, or a
    // transient error). Drop the cached bundle so the NEXT call re-reads
    // Keychain — this is what lets a re-consent (which writes a fresh bundle to
    // Keychain) recover a long-running daemon WITHOUT a restart, instead of
    // staying pinned to the dead token for the process lifetime.
    tokenCache.delete(email);
    throw e;
  }
  const next: StoredTokenBundle = {
    ...bundle,
    access_token: tokens.access_token,
    expires_at: nowMs() + tokens.expires_in * 1000,
    // Google may rotate the refresh_token; keep the new one if it
    // sends one, otherwise stick with the existing one.
    refresh_token: tokens.refresh_token ?? bundle.refresh_token,
    scope: tokens.scope ?? bundle.scope,
  };
  await persistBundle(next);
  return next;
}

// Convenience: just give me the access_token string. Most call-sites
// want this directly to plug into Authorization: Bearer ...
export async function getBearerToken(email: string): Promise<string> {
  const bundle = await getAccessToken(email);
  return bundle.access_token;
}

// List every mailbox that has a token bundle stored. macOS `security`
// has no clean list-by-service API, so we rely on the caller to know
// the email set. The runtime passes its 4 known accounts in.
// Every Gmail mailbox this instance polls, from config/identity.json (see
// relay/io/identity.ts). Was a hard-coded 4-address tuple for one person.
export const KNOWN_MAILBOXES: ReadonlyArray<string> = loadIdentity().mailboxes;

export type KnownMailbox = string;
