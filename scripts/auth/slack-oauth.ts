// Slack OAuth consent flow (PKCE) — the one-click replacement for SETUP.md §2's
// "create your own Slack app and paste an xoxp- token" ritual.
//
// Run it, click Allow in the browser, done. Everything happens on this machine:
// the browser redirects to localhost, this process exchanges the code with
// slack.com directly, and the token lands in Keychain. No Taiv server is
// involved at any point — there is none to involve.
//
//   npx tsx scripts/auth/slack-oauth.ts consent [account]
//   npx tsx scripts/auth/slack-oauth.ts show    [account]
//
// `account` defaults to the primary Slack account in config/identity.json and
// selects which workspace's Keychain entry is written (same service, one
// account key per workspace).
//
// Spawnable from the cockpit's Connections screen the same way reauth.ts
// spawns the Google consent script.

import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { page } from "../../relay/io/consent-page.js";
import { loadIdentity } from "../../relay/io/identity.js";
import { getSecret } from "../../relay/io/keychain.js";
import { SlackClient } from "../../relay/io/slack-api.js";
import {
  buildAuthorizeUrl,
  codeChallengeOf,
  createCodeVerifier,
  exchangeCode,
  parseStoredToken,
  saveSlackBundle,
  SLACK_CLIENT_ID,
  SLACK_REDIRECT_PATH,
  SLACK_REDIRECT_PORTS,
  SLACK_OAUTH_TOKEN_SERVICE,
  SLACK_TOKEN_SERVICE,
  slackRedirectUri,
} from "../../relay/io/slack-oauth.js";
import { appendSlackAccount } from "../../relay/io/identity-store.js";
import { restartDaemon } from "../../relay/io/daemon-control.js";

// The browser dance should take well under two minutes. Fail loudly rather
// than hanging forever if the user closes the tab.
const CALLBACK_TIMEOUT_MS = 120_000;

function defaultAccount(): string {
  const id = loadIdentity();
  return id.slackAccounts[0]?.account ?? id.primaryEmail;
}

// Slack only accepts redirect_uri values registered in app settings, so we
// cannot grab an arbitrary free port the way the Google loopback flow does —
// we try the registered ones in order.
async function listenOnRegisteredPort(
  handler: (code: string, state: string, respond: (html: string) => void) => void,
): Promise<{ port: number; close: () => void }> {
  for (const port of SLACK_REDIRECT_PORTS) {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (url.pathname !== SLACK_REDIRECT_PATH) {
        res.writeHead(404).end();
        return;
      }
      handler(
        url.searchParams.get("code") ?? "",
        url.searchParams.get("state") ?? "",
        (html) => {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        },
      );
    });
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (ok) return { port, close: () => server.close() };
  }
  throw new Error(
    `all registered redirect ports are busy (${SLACK_REDIRECT_PORTS.join(", ")}). ` +
      "Free one and retry — Slack only accepts redirect URLs registered in app settings.",
  );
}

function openBrowser(url: string): void {
  spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
}

// `add` authorizes a NEW workspace: the Keychain key is not known up front,
// because the user only picks the workspace on Slack's own page. auth.test
// tells us which team the token belongs to, and that is what it gets keyed on.
async function cmdConsent(account: string, mode: "reauth" | "add" = "reauth"): Promise<void> {
  if (!SLACK_CLIENT_ID) {
    throw new Error(
      "SLACK_CLIENT_ID is empty. Set the shipped client id in relay/io/slack-oauth.ts " +
        "(or export SLACK_CLIENT_ID) — it is the public id of the Slack app, not a secret.",
    );
  }
  const verifier = createCodeVerifier(randomBytes);
  const challenge = codeChallengeOf(verifier, (s) => createHash("sha256").update(s).digest());
  const state = randomUUID();

  // The browser response is deliberately HELD until the exchange has finished.
  // Answering "Connected" the moment the code arrives would be a lie whenever
  // the exchange or the auth.test check then fails — the user would close a
  // success page over a connection that does not work.
  type Callback = { code: string; respond: (html: string) => void };
  let resolveCb: (c: Callback) => void = () => {};
  let rejectCb: (e: Error) => void = () => {};
  const callback = new Promise<Callback>((res, rej) => {
    resolveCb = res;
    rejectCb = rej;
  });

  const { port, close } = await listenOnRegisteredPort((code, gotState, respond) => {
    // state must match, or this callback is not ours — a CSRF guard, and the
    // reason we do not just take whatever code arrives on the port.
    if (gotState !== state) {
      respond(
        page({
          ok: false,
          title: "Mismatched request",
          body: "This callback did not come from the sign-in that started here. Nothing was stored.",
          detail: "Close this tab and run the connect step again.",
        }),
      );
      rejectCb(new Error("state mismatch on the OAuth callback"));
      return;
    }
    if (!code) {
      respond(
        page({
          ok: false,
          title: "No authorization code",
          body: "Slack redirected back without a code, so there was nothing to exchange.",
          detail: "Close this tab and try connecting again.",
        }),
      );
      rejectCb(new Error("no code on the OAuth callback"));
      return;
    }
    resolveCb({ code, respond });
  });

  const redirectUri = slackRedirectUri(port);
  const authUrl = buildAuthorizeUrl({
    clientId: SLACK_CLIENT_ID,
    redirectUri,
    codeChallenge: challenge,
    state,
  });

  console.log(`Opening Slack authorization for ${account}…`);
  console.log("(If the browser doesn't open, paste this URL manually:)");
  console.log(authUrl);
  openBrowser(authUrl);

  const timeout = setTimeout(
    () => rejectCb(new Error("timed out waiting for the Slack callback")),
    CALLBACK_TIMEOUT_MS,
  );
  let cb: Callback;
  try {
    cb = await callback;
  } catch (e) {
    close();
    throw e;
  } finally {
    clearTimeout(timeout);
  }

  try {
    const bundle = await exchangeCode({
      clientId: SLACK_CLIENT_ID,
      code: cb.code,
      codeVerifier: verifier,
      redirectUri,
    });

    // Prove the token actually works before writing it — a stored-but-dead
    // credential is worse than none, because the daemon only finds out mid-scan.
    const who = await new SlackClient({ token: bundle.access_token }).authTest();

    // For a new workspace the account key comes from the team we just learned,
    // and identity.json gains an entry so the scan loop starts polling it.
    let target = account;
    if (mode === "add") {
      const reg = appendSlackAccount({ teamId: who.team_id, teamName: who.team });
      target = reg.account;
      console.log(
        reg.added
          ? `   registered ${who.team} as ${reg.label} in ${reg.path}`
          : `   ${who.team} was already registered as ${reg.label}`,
      );
      if (reg.added) {
        // The daemon reads slackAccounts once at startup, so without this the
        // new workspace sits registered but unpolled until something else
        // restarts it — the user would add it and see nothing happen.
        const r = await restartDaemon();
        console.log(`   ${r.detail}`);
      }
    }
    await saveSlackBundle(target, bundle);

    cb.respond(
      page({
        ok: true,
        title: "Connected",
        body: `${who.team} is linked. The secretary will start reading new messages on its next round — nothing sends without your approval.`,
        detail: `Signed in as ${who.user}. Stored in your macOS Keychain on this Mac only. You can close this tab.`,
      }),
    );

    console.log(`✅ ${who.team} — signed in as ${who.user}`);
    console.log(`   stored: ${SLACK_OAUTH_TOKEN_SERVICE} / ${target}`);
    console.log(
      bundle.expires_at
        ? `   rotating token, expires ${new Date(bundle.expires_at).toLocaleString()}`
        : "   non-rotating token (no expiry)",
    );
  } catch (e) {
    // The browser is still waiting on this response, so tell it the truth
    // rather than leaving a spinning tab next to a failed connect.
    cb.respond(
      page({
        ok: false,
        title: "Could not finish connecting",
        body: "Slack approved the request, but exchanging it for a token failed. Nothing was stored.",
        detail: e instanceof Error ? e.message : String(e),
      }),
    );
    throw e;
  } finally {
    // Only now: the response has to be written before the socket goes away.
    close();
  }
}

async function cmdShow(account: string): Promise<void> {
  const stored = parseStoredToken(await getSecret(SLACK_TOKEN_SERVICE, account));
  if (typeof stored === "string") {
    console.log(`${account}: legacy static token (${stored.slice(0, 12)}…) — no expiry`);
    return;
  }
  console.log(`${account}: ${stored.team_name || stored.team_id} user=${stored.user_id}`);
  console.log(`  scopes:  ${stored.scope}`);
  console.log(
    `  expires: ${stored.expires_at ? new Date(stored.expires_at).toLocaleString() : "never"}`,
  );
}

function usage(): never {
  console.error("usage:");
  console.error("  slack-oauth.ts consent [account]   re-authorize an existing workspace");
  console.error("  slack-oauth.ts add                 authorize an ADDITIONAL workspace");
  console.error("  slack-oauth.ts show    [account]");
  process.exit(2);
}

async function main(): Promise<void> {
  const [sub, account] = process.argv.slice(2);
  if (sub === "consent") await cmdConsent(account || defaultAccount());
  else if (sub === "add") await cmdConsent(defaultAccount(), "add");
  else if (sub === "show") await cmdShow(account || defaultAccount());
  else usage();
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
