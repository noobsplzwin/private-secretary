#!/usr/bin/env -S npx tsx
// One-shot Google OAuth flow for a single mailbox. Loads the OAuth client
// JSON from Keychain, opens the browser consent page, captures the redirect
// callback on a local port, exchanges the code for tokens, and stores the
// bundle back in Keychain — keyed by the TARGET email (not the client's
// owner email).
//
// Run once per Google account at setup, then re-run on "refresh-token
// expired" (External Testing apps, every 7 days). `refresh` subcommand
// trades the stored refresh_token for a fresh access_token without re-
// consenting — used both for verification and during the runtime polling
// loop.
//
// Usage:
//   npx tsx scripts/auth/google-oauth.ts consent <client-service> <client-account> <target-email>
//   npx tsx scripts/auth/google-oauth.ts refresh <target-email>
//   npx tsx scripts/auth/google-oauth.ts list
//
// Examples (the 4 Taiv Secretary mailboxes):
//   ... consent taiv-secretary-gcp-A leo@taiv.tv       leo@taiv.tv
//   ... consent taiv-secretary-gcp-B leo@osyx.tech     leo@osyx.tech
//   ... consent taiv-secretary-gcp-C leo@taiv.tv       huizhezheng@gmail.com
//   ... consent taiv-secretary-gcp-C leo@taiv.tv       zhenghleo@gmail.com
//
// After consent, the script verifies the token by calling gmail.users.getProfile
// and checks that the returned email matches the target — catches the
// "signed in as the wrong Google account in the browser" failure mode.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { URL } from "node:url";
import {
  getJSON,
  setJSON,
  KeychainEntryMissing,
} from "../../relay/io/keychain.js";

// Scopes are FIXED — gmail.modify is a superset of read + compose + label,
// calendar.events covers list + create, drive serves the messages MCP's Drive
// tools (relay/io/drive-api.ts: read, plus upload/new folder behind an
// approval rule; never edits or deletes). Adding more here forces Google's
// scope-justification flow and clutters the consent screen for no win.
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive",
];

const TOKEN_KEYCHAIN_SERVICE = "taiv-secretary-token-google";

interface OAuthClientJson {
  installed: {
    client_id: string;
    client_secret: string;
    auth_uri: string;
    token_uri: string;
    redirect_uris: string[];
  };
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

interface StoredTokenBundle {
  refresh_token: string;
  access_token: string;
  expires_at: number; // ms epoch when access_token expires
  scope: string;
  granted_at: number; // ms epoch of initial consent
  email: string; // the mailbox this bundle is for
  oauth_client_service: string; // Keychain service holding the OAuth client
  oauth_client_account: string; // Keychain account holding the OAuth client
}

interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        reject(new Error("could not get free port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

// Boots a tiny HTTP server on the given port, resolves with the OAuth `code`
// when Google redirects the user back. 5-minute total timeout. State value
// is verified to mitigate CSRF.
async function waitForCallback(port: number, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const srv = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const sendHtml = (status: number, html: string): void => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      };
      if (error) {
        sendHtml(400, `<h1>OAuth error</h1><p>${error}</p>`);
        settle(() => {
          srv.close();
          reject(new Error(`OAuth error: ${error}`));
        });
        return;
      }
      if (state !== expectedState) {
        sendHtml(400, "<h1>State mismatch</h1>");
        settle(() => {
          srv.close();
          reject(new Error("OAuth state mismatch — possible CSRF"));
        });
        return;
      }
      if (!code) {
        sendHtml(400, "<h1>No code received</h1>");
        settle(() => {
          srv.close();
          reject(new Error("No OAuth code received"));
        });
        return;
      }
      sendHtml(
        200,
        `<html><body style="font-family:system-ui;padding:40px;max-width:600px;margin:auto">
          <h1>✅ Authorized</h1>
          <p>You can close this tab. Token bundle saved to macOS Keychain.</p>
        </body></html>`,
      );
      settle(() => {
        srv.close();
        resolve(code);
      });
    });
    srv.on("error", (e) => settle(() => reject(e)));
    srv.listen(port, "127.0.0.1");
    const timeout = setTimeout(
      () =>
        settle(() => {
          srv.close();
          reject(new Error("OAuth callback timed out after 5 minutes"));
        }),
      5 * 60 * 1000,
    );
    // Don't keep the event loop alive solely for the timeout.
    timeout.unref();
  });
}

function openBrowser(url: string): void {
  const child = spawn("open", [url], { detached: true, stdio: "ignore" });
  child.unref();
}

async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  tokenUri: string;
}): Promise<TokenResponse> {
  const params = new URLSearchParams({
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    grant_type: "authorization_code",
  });
  const resp = await fetch(opts.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed: ${resp.status} ${text}`);
  }
  return (await resp.json()) as TokenResponse;
}

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
  const resp = await fetch(opts.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Refresh failed: ${resp.status} ${text}`);
  }
  return (await resp.json()) as TokenResponse;
}

// Sanity-check the access_token by calling gmail.users.getProfile. Catches
// the most common silent failure: the user signed into the BROWSER as a
// different Google account than the one this token is supposed to serve.
async function verifyTokenAgainstGmail(
  accessToken: string,
  expectedEmail: string,
): Promise<{ ok: true; profile: GmailProfile } | { ok: false; warning: string }> {
  const resp = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!resp.ok) {
    const text = await resp.text();
    return { ok: false, warning: `gmail.users.getProfile failed: ${resp.status} ${text}` };
  }
  const profile = (await resp.json()) as GmailProfile;
  if (profile.emailAddress.toLowerCase() !== expectedEmail.toLowerCase()) {
    return {
      ok: false,
      warning: `token's email (${profile.emailAddress}) does not match target (${expectedEmail}) — wrong Google account signed in?`,
    };
  }
  return { ok: true, profile };
}

async function cmdConsent(
  clientService: string,
  clientAccount: string,
  targetEmail: string,
): Promise<void> {
  console.log(`Loading OAuth client from Keychain: ${clientService}/${clientAccount}`);
  const client = await getJSON<OAuthClientJson>(clientService, clientAccount);
  const { client_id, client_secret, auth_uri, token_uri } = client.installed;

  const port = await findFreePort();
  const redirectUri = `http://localhost:${port}`;
  const state = randomBytes(16).toString("hex");

  const authUrl = new URL(auth_uri);
  authUrl.searchParams.set("client_id", client_id);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES.join(" "));
  // access_type=offline + prompt=consent is what guarantees a refresh_token
  // every time. Without prompt=consent, repeat consents return only an
  // access_token if the user has consented before — surprising and broken.
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("login_hint", targetEmail);
  authUrl.searchParams.set("state", state);

  console.log("");
  console.log(`Opening browser for consent. SIGN IN AS: ${targetEmail}`);
  console.log("(If the browser doesn't open, paste this URL manually:)");
  console.log(authUrl.toString());
  console.log("");
  openBrowser(authUrl.toString());

  const code = await waitForCallback(port, state);
  console.log("Got authorization code. Exchanging for tokens...");

  const tokens = await exchangeCode({
    clientId: client_id,
    clientSecret: client_secret,
    code,
    redirectUri,
    tokenUri: token_uri,
  });

  if (!tokens.refresh_token) {
    throw new Error(
      "No refresh_token in response. This usually means consent was previously granted without prompt=consent. " +
        "Revoke at https://myaccount.google.com/permissions and re-run.",
    );
  }

  const bundle: StoredTokenBundle = {
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
    scope: tokens.scope,
    granted_at: Date.now(),
    email: targetEmail,
    oauth_client_service: clientService,
    oauth_client_account: clientAccount,
  };

  await setJSON(TOKEN_KEYCHAIN_SERVICE, targetEmail, bundle);

  console.log("");
  console.log(`Stored token bundle:`);
  console.log(`  Keychain: service=${TOKEN_KEYCHAIN_SERVICE} account=${targetEmail}`);
  console.log(`  Scope: ${tokens.scope}`);
  console.log(`  Access token expires: ${new Date(bundle.expires_at).toISOString()}`);
  console.log(`  Refresh token: ${tokens.refresh_token.slice(0, 12)}...${tokens.refresh_token.slice(-4)}`);

  // Verify the access_token works AND it's bound to the right mailbox.
  const verify = await verifyTokenAgainstGmail(tokens.access_token, targetEmail);
  if (verify.ok) {
    console.log(
      `Verified via gmail.users.getProfile: ${verify.profile.emailAddress} (${verify.profile.messagesTotal} messages, ${verify.profile.threadsTotal} threads)`,
    );
  } else {
    console.warn(`WARNING: ${verify.warning}`);
  }
}

async function cmdRefresh(targetEmail: string): Promise<void> {
  console.log(`Loading stored bundle for ${targetEmail}...`);
  let bundle: StoredTokenBundle;
  try {
    bundle = await getJSON<StoredTokenBundle>(TOKEN_KEYCHAIN_SERVICE, targetEmail);
  } catch (e) {
    if (e instanceof KeychainEntryMissing) {
      throw new Error(
        `No stored token for ${targetEmail}. Run \`consent\` first.`,
      );
    }
    throw e;
  }
  const client = await getJSON<OAuthClientJson>(
    bundle.oauth_client_service,
    bundle.oauth_client_account,
  );
  const tokens = await exchangeRefreshToken({
    clientId: client.installed.client_id,
    clientSecret: client.installed.client_secret,
    refreshToken: bundle.refresh_token,
    tokenUri: client.installed.token_uri,
  });
  const newBundle: StoredTokenBundle = {
    ...bundle,
    access_token: tokens.access_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
    // Google may rotate the refresh_token; keep the new one if provided
    refresh_token: tokens.refresh_token ?? bundle.refresh_token,
    scope: tokens.scope ?? bundle.scope,
  };
  await setJSON(TOKEN_KEYCHAIN_SERVICE, targetEmail, newBundle);
  console.log(
    `Refreshed. New access token expires: ${new Date(newBundle.expires_at).toISOString()}`,
  );
  const verify = await verifyTokenAgainstGmail(tokens.access_token, targetEmail);
  if (verify.ok) {
    console.log(`Verified: ${verify.profile.emailAddress}`);
  } else {
    console.warn(`WARNING: ${verify.warning}`);
  }
}

async function cmdList(): Promise<void> {
  // No direct way to list Keychain entries by service via `security`; users
  // can `security dump-keychain | grep taiv-secretary-token-google` if they
  // need to. We just print the expected emails for the Taiv Secretary setup.
  console.log("Expected token bundles (each via `consent` once):");
  console.log("  taiv-secretary-token-google / leo@taiv.tv");
  console.log("  taiv-secretary-token-google / leo@osyx.tech");
  console.log("  taiv-secretary-token-google / huizhezheng@gmail.com");
  console.log("  taiv-secretary-token-google / zhenghleo@gmail.com");
}

function usage(): never {
  console.error("usage:");
  console.error("  google-oauth.ts consent <client-service> <client-account> <target-email>");
  console.error("  google-oauth.ts refresh <target-email>");
  console.error("  google-oauth.ts list");
  process.exit(2);
}

async function main(): Promise<void> {
  const [sub, ...args] = process.argv.slice(2);
  if (sub === "consent") {
    if (args.length !== 3) usage();
    await cmdConsent(args[0]!, args[1]!, args[2]!);
  } else if (sub === "refresh") {
    if (args.length !== 1) usage();
    await cmdRefresh(args[0]!);
  } else if (sub === "list") {
    await cmdList();
  } else {
    usage();
  }
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
