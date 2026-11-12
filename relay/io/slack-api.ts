// Slack Web API wire layer. Direct REST against slack.com/api, NOT through
// the Slack MCP — the secretary's Phase-3 runtime owns its own token and
// rate limits.
//
// What lives here:
//   - SlackClient — token-bound, fetch-based, retries on 429/5xx
//   - Typed wrappers for the endpoints the source polls:
//       auth.test, conversations.list, conversations.history,
//       conversations.replies, conversations.info, users.info, users.list,
//       files.info, files.list, search.messages
//   - downloadFile(url) for attachments — Slack file URLs require the
//     bearer token; raw fetch returns bytes
//
// What does NOT live here:
//   - the source's polling logic (when to advance cursors, when to fetch
//     replies, how to call this client). That's relay/sources/slack-direct.ts
//   - any decision about which channels to poll — caller passes ids
//
// Concurrency / rate-limiting:
//   Slack publishes per-method tiers (Tier 2 = ~20/min, Tier 3 = ~50/min,
//   Tier 4 = ~100/min). We don't implement a token bucket here — we
//   honor Retry-After when it comes, and serialize calls through one
//   instance so a single SlackClient never has two outstanding requests.

import { loadIdentity } from "./identity.js";
import { readSlackToken } from "./slack-oauth.js";

// Owned by slack-oauth.ts (the token store); re-exported here so the many
// existing importers of this name keep working.
export { SLACK_TOKEN_SERVICE } from "./slack-oauth.js";
// The primary workspace's Keychain account, from config/identity.json (see
// relay/io/identity.ts). Was hard-coded to one person; now per-user.
export const SLACK_TOKEN_ACCOUNT = loadIdentity().slackAccounts[0]?.account ?? loadIdentity().primaryEmail;
export const SLACK_API_BASE = "https://slack.com/api";

// The Slack workspaces the daemon scans, each via its own Keychain user token
// (same service, different account key). label = the per-account source tag
// used for cursors / sourceErrors / perSource (must be stable — it keys
// persisted state). Taiv keeps the legacy "slack:direct" label so its existing
// cursors/marks are untouched; additional workspaces get their own.
export const SLACK_ACCOUNTS: ReadonlyArray<{ account: string; label: string }> =
  loadIdentity().slackAccounts;

// ─── error class so callers can branch on transient vs permanent ────

export class SlackApiError extends Error {
  constructor(
    public method: string,
    public errorCode: string,
    public response: unknown,
  ) {
    super(`Slack ${method} failed: ${errorCode}`);
    this.name = "SlackApiError";
  }
}

export interface SlackAuthTestResponse {
  url: string;
  team: string;
  user: string;
  team_id: string;
  user_id: string;
  is_enterprise_install: boolean;
}

// ─── typed message + container shapes ───────────────────────────────

export interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
}

export interface SlackMessage {
  type?: string;
  subtype?: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text: string;
  reply_count?: number;
  reply_users?: string[];
  reply_users_count?: number;
  latest_reply?: string;
  parent_user_id?: string;
  files?: SlackFile[];
  // Slack's response includes many more fields; we only type what we use.
}

export interface SlackConversation {
  id: string;
  name?: string;
  is_im?: boolean; // 1:1 DM
  is_mpim?: boolean; // group DM
  is_private?: boolean;
  is_channel?: boolean;
  is_group?: boolean;
  user?: string; // for IMs, the other user's id
  is_member?: boolean;
  is_archived?: boolean;
  num_members?: number;
}

export interface SlackUser {
  id: string;
  team_id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: {
    display_name?: string;
    real_name?: string;
    email?: string;
  };
}

export interface SlackHistoryResponse {
  messages: SlackMessage[];
  has_more: boolean;
  response_metadata?: { next_cursor?: string };
}

export interface SlackSearchResponse {
  messages: {
    total: number;
    matches: Array<SlackMessage & { channel?: { id: string; name?: string }; username?: string; permalink?: string }>;
  };
}

export interface SlackRepliesResponse {
  messages: SlackMessage[]; // first element is the parent
  has_more: boolean;
  response_metadata?: { next_cursor?: string };
}

export interface SlackConversationsListResponse {
  channels: SlackConversation[];
  response_metadata?: { next_cursor?: string };
}

export interface SlackUsersListResponse {
  members: SlackUser[];
  response_metadata?: { next_cursor?: string };
}

// ─── client ─────────────────────────────────────────────────────────

export interface SlackClientOptions {
  token: string;
  baseUrl?: string;
  // Override fetch — tests pass an in-memory mock.
  fetchFn?: typeof fetch;
  // Retries on 429/5xx before giving up. Default 3. Honors Retry-After.
  maxRetries?: number;
}

export class SlackClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly maxRetries: number;
  private inFlight: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: SlackClientOptions) {
    this.baseUrl = opts.baseUrl ?? SLACK_API_BASE;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  // GET-style call (Slack accepts both GET with querystring and POST with
  // form-encoded body for read endpoints; we use POST + form to avoid URL
  // length limits on cursor params).
  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    // Serialize all requests through one promise chain so a single client
    // instance never hits Slack with two simultaneous requests.
    const result = this.inFlight.then(() => this.callRaw<T>(method, params));
    this.inFlight = result.catch(() => undefined);
    return result;
  }

  private async callRaw<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v == null) continue;
      if (Array.isArray(v)) body.set(k, v.join(","));
      else body.set(k, String(v));
    }
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const resp = await this.fetchFn(`${this.baseUrl}/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.opts.token}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
      // 429 = rate limited; 5xx = transient — both retry with backoff.
      if (resp.status === 429 || resp.status >= 500) {
        const retryAfterHeader = resp.headers.get("Retry-After");
        const wait = retryAfterHeader ? parseFloat(retryAfterHeader) * 1000 : 2000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, Math.min(wait, 30_000)));
        lastErr = new Error(`Slack ${method} HTTP ${resp.status}`);
        continue;
      }
      const data = (await resp.json()) as { ok: boolean; error?: string } & Record<string, unknown>;
      if (!data.ok) {
        // "ratelimited" can also come through here with HTTP 200.
        if (data.error === "ratelimited" && attempt < this.maxRetries) {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          lastErr = new SlackApiError(method, data.error, data);
          continue;
        }
        throw new SlackApiError(method, data.error ?? "unknown_error", data);
      }
      return data as unknown as T;
    }
    throw lastErr ?? new Error(`Slack ${method} exhausted retries`);
  }

  // ─── typed endpoints used by the source ───────────────────────────

  async authTest(): Promise<SlackAuthTestResponse> {
    return this.call("auth.test", {});
  }

  // Revoke this token at Slack. Deleting our Keychain copy alone would only
  // make US forget it — the grant would still be live on Slack's side and the
  // app would still be listed under the user's installed apps. Disconnect has
  // to do both, and this is the half that actually withdraws access.
  async authRevoke(): Promise<{ revoked: boolean }> {
    return this.call("auth.revoke", {});
  }

  // List ALL conversations the user is in (IM + MPIM + private + public).
  // Paginates internally via the response cursor; returns everything in one
  // array because the caller (source) wants a registry of "what to poll".
  async listAllConversations(opts: {
    types?: string; // default "im,mpim,private_channel,public_channel"
    excludeArchived?: boolean; // default true
  } = {}): Promise<SlackConversation[]> {
    const out: SlackConversation[] = [];
    let cursor: string | undefined;
    while (true) {
      const resp = await this.call<SlackConversationsListResponse>(
        "users.conversations",
        {
          types: opts.types ?? "im,mpim,private_channel,public_channel",
          exclude_archived: opts.excludeArchived ?? true,
          limit: 1000,
          cursor,
        },
      );
      out.push(...resp.channels);
      cursor = resp.response_metadata?.next_cursor;
      if (!cursor) break;
    }
    return out;
  }

  // Fetch history for one channel, since `oldest` (exclusive), newest first
  // by default. Returns the raw page — caller decides whether to paginate.
  async conversationsHistory(opts: {
    channel: string;
    oldest?: string; // slack ts ("1781140064.001200"); exclusive lower bound
    latest?: string; // slack ts; exclusive upper bound
    limit?: number; // 1-1000, default 100
    cursor?: string; // opaque, from response_metadata
    inclusive?: boolean;
  }): Promise<SlackHistoryResponse> {
    return this.call("conversations.history", {
      channel: opts.channel,
      oldest: opts.oldest,
      latest: opts.latest,
      limit: opts.limit ?? 100,
      cursor: opts.cursor,
      inclusive: opts.inclusive,
    });
  }

  // One file's metadata (name, mimetype, url_private_download). Needs files:read.
  async filesInfo(file: string): Promise<{ file: SlackFile }> {
    return this.call("files.info", { file });
  }

  // Full-text search across the workspace, newest first. Needs the search:read
  // user scope; a token without it fails with SlackApiError "missing_scope".
  async searchMessages(opts: { query: string; count?: number; page?: number }): Promise<SlackSearchResponse> {
    return this.call("search.messages", {
      query: opts.query,
      count: opts.count ?? 20,
      page: opts.page ?? 1,
      sort: "timestamp",
    });
  }

  async conversationsReplies(opts: {
    channel: string;
    ts: string;
    oldest?: string;
    latest?: string;
    limit?: number;
    cursor?: string;
  }): Promise<SlackRepliesResponse> {
    return this.call("conversations.replies", {
      channel: opts.channel,
      ts: opts.ts,
      oldest: opts.oldest,
      latest: opts.latest,
      limit: opts.limit ?? 100,
      cursor: opts.cursor,
    });
  }

  // Fetch every reply for a thread, paginating until exhausted. Convenience
  // because the source needs the full reply_users set, not a page.
  async listAllReplies(channel: string, ts: string): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    let cursor: string | undefined;
    while (true) {
      const resp = await this.conversationsReplies({ channel, ts, cursor, limit: 1000 });
      out.push(...resp.messages);
      cursor = resp.response_metadata?.next_cursor;
      if (!cursor || !resp.has_more) break;
    }
    return out;
  }

  async usersInfo(user: string): Promise<SlackUser> {
    const data = await this.call<{ user: SlackUser }>("users.info", { user });
    return data.user;
  }

  // Send a message. This is the WRITE side — the cockpit's approve flow
  // calls it for reply/relay/forward action items targeting Slack, AFTER
  // the user approves. threadTs replies in-thread. Returns the new
  // message's ts + channel so the caller can build a permalink receipt.
  async postMessage(opts: {
    channel: string;
    text: string;
    threadTs?: string;
  }): Promise<{ ts: string; channel: string }> {
    const data = await this.call<{ ts: string; channel: string }>(
      "chat.postMessage",
      {
        channel: opts.channel,
        text: opts.text,
        thread_ts: opts.threadTs,
        // We send as the user (xoxp token) — Slack uses the user's identity.
        // Disable link unfurling so the secretary's messages stay clean.
        unfurl_links: false,
        unfurl_media: false,
      },
    );
    return { ts: data.ts, channel: data.channel };
  }

  // Resolve a permalink for a posted message — used to build the execution
  // receipt's `ref`. Best-effort: if it fails we synthesize a deep link from
  // the team url + channel + ts (Slack's archive URL format is stable).
  async getPermalink(channel: string, messageTs: string): Promise<string> {
    try {
      const data = await this.call<{ permalink: string }>("chat.getPermalink", {
        channel,
        message_ts: messageTs,
      });
      return data.permalink;
    } catch {
      const tsPart = messageTs.replace(".", "");
      return `https://slack.com/archives/${channel}/p${tsPart}`;
    }
  }

  // Download an attached file (url_private). Slack requires the bearer token
  // in Authorization for these private URLs; the response is the raw bytes.
  async downloadFile(urlPrivate: string): Promise<Uint8Array> {
    const resp = await this.fetchFn(urlPrivate, {
      headers: { Authorization: `Bearer ${this.opts.token}` },
    });
    if (!resp.ok) {
      throw new Error(`Slack file download failed: HTTP ${resp.status} ${urlPrivate}`);
    }
    const ab = await resp.arrayBuffer();
    return new Uint8Array(ab);
  }
}

// Convenience factory: pull the user token out of Keychain and build a
// client. Throws KeychainEntryMissing (re-raised) if the token isn't set
// up — caller should treat that as the "run /relay setup first" case.
export async function createSlackClientFromKeychain(
  overrides: Partial<SlackClientOptions> = {},
  account: string = SLACK_TOKEN_ACCOUNT,
): Promise<SlackClient> {
  // account selects WHICH workspace's user token to use — default is the Taiv
  // token (leo@taiv.tv); pass another account (e.g. the OSYX huizhezheng@gmail.com
  // entry) to read a second workspace. Same service, different account key.
  //
  // readSlackToken handles both credential shapes: a legacy hand-pasted xoxp-
  // string (returned as-is) and a PKCE bundle (refreshed here if it is close to
  // expiry). Every Slack caller funnels through this factory, so this one line
  // is the whole refresh integration.
  const token = await readSlackToken(account);
  return new SlackClient({ token, ...overrides });
}
