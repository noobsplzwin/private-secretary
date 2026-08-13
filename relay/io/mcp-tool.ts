// Real MCP tool runner built on the official @modelcontextprotocol/sdk — not a
// hand-rolled protocol. A tool with `config.type: "mcp"` + `config.url`
// connects over Streamable HTTP; OAuth (the Notion-style flow) is handled by
// the SDK's auth layer with a Keychain-backed provider + a loopback callback:
//
//   1. connect with any stored token (Keychain, per authService)
//   2. expired → the provider silently refreshes; refresh fails or no token →
//      the SDK calls redirectToAuthorization (we open the browser) and throws
//      UnauthorizedError
//   3. the loopback server captures the auth code → transport.finishAuth(code)
//   4. reconnect → client.callTool({ name: params.mcp_tool ?? defaultTool })
//
// The tool's Keychain token lives at service `authService` (default
// `taiv-secretary-mcp-<key>`), account = the tool key.

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OAuthClientProvider, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { getJSON, setJSON, deleteSecret } from "./keychain.js";
import type { ToolRunner } from "../proc/execute.js";

// ─── the OAuth client provider (Keychain-backed) ────────────────────

// A provider instance is bound to one authService (the Keychain slot holding
// that tool's OAuth tokens) and one redirectUrl (the loopback callback).
class McpOAuthProvider implements OAuthClientProvider {
  private pendingCode: string | null = null;
  private pendingVerifier: string | null = null;
  private clientInfo: OAuthClientInformationMixed | undefined;

  constructor(
    private readonly authService: string,
    private readonly account: string,
    private readonly redirect: URL,
  ) {}

  // The registered client info (dynamic registration) persists in Keychain so
  // a later run reuses the same client_id instead of re-registering.
  private clientInfoService(): string {
    return `${this.authService}-client`;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.clientInfo) return this.clientInfo;
    return getJSON<OAuthClientInformationMixed>(this.clientInfoService(), this.account).catch(
      () => undefined,
    );
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    this.clientInfo = info;
    await setJSON(this.clientInfoService(), this.account, info);
  }

  async clearClientInformation(): Promise<void> {
    this.clientInfo = undefined;
    await deleteSecret(this.clientInfoService(), this.account);
  }

  get redirectUrl(): URL {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirect.toString()],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
      client_name: "Private Secretary",
    };
  }

  state(): string {
    return crypto.randomUUID();
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return getJSON<OAuthTokens>(this.authService, this.account).catch(() => undefined);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await setJSON(this.authService, this.account, tokens);
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    this.pendingCode = null;
    // macOS `open`; other platforms fall through (the URL is also returned).
    spawn("open", [url.toString()], { detached: true, stdio: "ignore" }).unref();
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.pendingVerifier = codeVerifier;
  }

  async codeVerifier(): Promise<string> {
    return this.pendingVerifier ?? "";
  }
}

// ─── connect + auth retry loop ───────────────────────────────────────

interface McpConnection {
  transport: StreamableHTTPClientTransport;
  client: Client;
}

// Start a loopback server that captures the OAuth authorization code.
function startCallbackServer(): Promise<{
  server: Server;
  redirectUrl: URL;
  waitForCode: () => Promise<string>;
}> {
  return new Promise((resolve) => {
    let resolveCode: (code: string) => void = () => {};
    const codePromise = new Promise<string>((r) => {
      resolveCode = r;
    });
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const code = url.searchParams.get("code") ?? "";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>Authorized — you can close this tab.</h1>");
      resolveCode(code);
      server.close();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const redirectUrl = new URL(`http://127.0.0.1:${port}/callback`);
      resolve({ server, redirectUrl, waitForCode: () => codePromise });
    });
  });
}

// The browser OAuth dance should finish in well under two minutes. If it
// doesn't (no popup, user closed the tab, discovery failed), fail loudly
// instead of hanging the "Connect" button on "Authorizing…" forever.
const OAUTH_CALLBACK_TIMEOUT_MS = 120_000;

function newTransportAndClient(url: string, provider: McpOAuthProvider): McpConnection {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    authProvider: provider,
  });
  const client = new Client({ name: "private-secretary", version: "1.0.0" });
  return { transport, client };
}

async function connect(url: string, authService: string, account: string): Promise<McpConnection> {
  const { server, redirectUrl, waitForCode } = await startCallbackServer();
  const provider = new McpOAuthProvider(authService, account, redirectUrl);
  let conn = newTransportAndClient(url, provider);

  try {
    await conn.client.connect(conn.transport);
    // Already authorized (token present) — the callback server was only for the
    // OAuth code; close it so it doesn't keep the process alive.
    server.close();
  } catch (e) {
    // The SDK threw UnauthorizedError after redirectToAuthorization opened the
    // browser. Wait for the loopback callback to capture the code, finish the
    // auth handshake, then reconnect once. A timeout so a failed flow doesn't
    // hang the caller forever. (The callback handler closes the server.)
    if (e instanceof UnauthorizedError) {
      console.log(`[mcp] ${url}: OAuth needed — browser should open for ${redirectUrl}`);
      const code = await Promise.race([
        waitForCode(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `OAuth authorization timed out (${OAUTH_CALLBACK_TIMEOUT_MS / 1000}s) — the browser flow did not complete.`,
                ),
              ),
            OAUTH_CALLBACK_TIMEOUT_MS,
          ),
        ),
      ]);
      await conn.transport.finishAuth(code);
      // The pre-auth transport already called start() once (that's how the
      // auth-needed request was sent); StreamableHTTPClientTransport refuses
      // a second start() on the same instance, so reconnect with a fresh
      // transport/client bound to the same provider (which now holds the token).
      conn = newTransportAndClient(url, provider);
      await conn.client.connect(conn.transport);
    } else {
      console.error(`[mcp] ${url}: connect failed: ${(e as Error).message ?? String(e)}`);
      server.close();
      throw e;
    }
  }
  return conn;
}

// ─── the ToolRunner ─────────────────────────────────────────────────

export interface McpToolOptions {
  url: string;
  authService: string;
  defaultTool?: string;
}

// Build a real-MCP ToolRunner for a URL-based (OAuth) server. The tool to call
// is `params.mcp_tool` (the LLM names it), falling back to config.defaultTool.
export function createMcpToolRunner(opts: McpToolOptions): ToolRunner {
  return {
    run: async (params: Record<string, unknown>) => {
      const toolName =
        (typeof params.mcp_tool === "string" && params.mcp_tool) || opts.defaultTool || "";
      if (!toolName) {
        throw new Error(`no mcp_tool in params and no defaultTool for ${opts.url}`);
      }
      // Strip our own envelope keys before they leak into the tool arguments.
      const { mcp_tool: _t, ...args } = params;

      const res = await callMcpTool(opts.url, opts.authService, toolName, args);
      return { ref: extractRef(callResultText(res), toolName) };
    },
  };
}

// Connect, call one tool, close. The low-level primitive callers with
// tool-specific field mapping (e.g. relay/io/jira-mcp.ts) build on instead of
// duplicating the connect/close plumbing above.
export async function callMcpTool(
  url: string,
  authService: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { client } = await connect(url, authService, url);
  try {
    return await client.callTool({ name: toolName, arguments: args });
  } finally {
    await client.close().catch(() => {});
  }
}

// Concatenate a callTool result's text blocks (or JSON.stringify the rest).
export function callResultText(res: unknown): string {
  const content = (res as { content?: unknown } | null)?.content;
  if (Array.isArray(content)) {
    const parts = content.map((c) => {
      const obj = c as { text?: unknown };
      return typeof obj?.text === "string" ? obj.text : JSON.stringify(c);
    });
    return parts.join("\n");
  }
  return JSON.stringify(res);
}

// A callTool result's DATA rows, flattened.
//
// `JSON.parse(callResultText(res))` is the obvious thing and it is wrong: a
// server may split one logical result across SEVERAL text blocks (TickTick's
// list_projects returns a JSON object per project), and callResultText joins
// them with "\n", so the parse dies on "Unexpected non-whitespace character
// after JSON" at the second document. Handled here, once, because it is a
// property of MCP and not of any one server:
//
//   · structuredContent wins when present — already-typed data, no parsing
//   · a value shaped {result: X} contributes X (TickTick's envelope)
//   · an array contributes its elements; anything else is one element
//   · a text block holding several concatenated JSON values is split
//   · a non-JSON block is kept as its string, never silently dropped
export function callResultRows(res: unknown): unknown[] {
  const r = res as { content?: unknown; structuredContent?: unknown } | null;
  if (r?.structuredContent !== undefined) return flattenResult(r.structuredContent);

  const content = r?.content;
  if (!Array.isArray(content)) return flattenResult(res);

  const rows: unknown[] = [];
  for (const block of content) {
    const text = (block as { text?: unknown } | null)?.text;
    if (typeof text !== "string") {
      rows.push(block);
      continue;
    }
    rows.push(...parseTextBlock(text));
  }
  return rows;
}

// The single object a create/update tool returns. Throws rather than returning
// undefined: every caller needs the id, and a silent undefined would surface
// later as "created nothing" with no explanation.
export function callResultObject(res: unknown): Record<string, unknown> {
  const first = callResultRows(res)[0];
  if (first === undefined || typeof first !== "object" || first === null) {
    throw new Error(`MCP result carried no object (got ${JSON.stringify(first)?.slice(0, 120)})`);
  }
  return first as Record<string, unknown>;
}

function flattenResult(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  const inner = (v as { result?: unknown }).result;
  if (inner !== undefined) return flattenResult(inner);
  return Array.isArray(v) ? v : [v];
}

function parseTextBlock(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    return flattenResult(JSON.parse(trimmed));
  } catch {
    // Either several JSON values in one block, or not JSON at all.
  }
  const docs = splitJsonDocuments(trimmed);
  const out: unknown[] = [];
  for (const d of docs) {
    try {
      out.push(...flattenResult(JSON.parse(d)));
    } catch {
      // An unparsable fragment — skip it, the rest of the block still counts.
    }
  }
  return out.length > 0 ? out : [trimmed];
}

// Split a string holding one or more concatenated top-level JSON values.
// String/escape state is tracked so a brace inside a string value cannot shift
// the nesting depth and truncate a document mid-way.
function splitJsonDocuments(text: string): string[] {
  const docs: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && start >= 0) {
        docs.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return docs;
}

// Trigger ONLY the OAuth handshake for a URL-based MCP tool (no tool call) —
// the Settings page's "Connect" button. Runs the browser flow, stores the
// token in Keychain, then disconnects. A tool whose token already exists
// returns immediately (already authorized).
export async function authorizeMcpTool(url: string, authService: string): Promise<void> {
  const { client } = await connect(url, authService, url);
  await client.close().catch(() => {});
}

// Debug / introspection: list the MCP server's tool names (to learn which
// tool a card's params.mcp_tool should name).
export async function listMcpTools(url: string, authService: string): Promise<string[]> {
  const { client } = await connect(url, authService, url);
  try {
    const res = await client.listTools();
    return res.tools.map((t) => t.name);
  } finally {
    await client.close().catch(() => {});
  }
}

// A short stable ref for the receipt: the server's text first line, trimmed.
export function extractRef(text: string, toolName: string): string {
  const first = text.split("\n")[0]?.trim().slice(0, 80) ?? "";
  return first ? `${toolName}: ${first}` : `${toolName}: ok`;
}

// The keychain service for a tool key's OAuth tokens, unless configured.
export function mcpAuthServiceFor(toolKey: string, configured?: string): string {
  return configured || `taiv-secretary-mcp-${toolKey}`;
}

// Debug / manual revoke: drop a tool's stored OAuth tokens.
export async function clearMcpTokens(authService: string, account: string): Promise<void> {
  await deleteSecret(authService, account);
}

/**
 * Full OAuth reset for one tool: tokens AND the dynamically-registered client.
 *
 * WHY BOTH: abandoning the browser consent leaves the registration saved but no
 * token, and the server can put that half-finished client into a state where it
 * answers every /authorize with a 500. Every retry then reads the same dead
 * client_id out of Keychain and fails identically — the connection is bricked
 * with no way out, which is exactly what happened to Jira (client
 * YM-Rz7OVYmnggW_r → 500 forever, while a freshly registered client → 200).
 *
 * Clearing the client info makes the SDK register a new one on the next
 * attempt. Safe to run any time: it only discards credentials, and the next
 * connect re-obtains them.
 */
export async function resetMcpAuth(url: string, authService: string): Promise<void> {
  // The provider keys both entries by the server URL (see connect()).
  //
  // Each delete tolerates a MISSING entry, because the state this exists to
  // clean up is precisely a partial one: client registration saved, token never
  // obtained. deleteSecret throws KeychainEntryMissing, so a strict version
  // would die on the absent token and never reach the client entry — failing in
  // the only case that matters.
  for (const service of [authService, `${authService}-client`]) {
    await deleteSecret(service, url).catch(() => undefined);
  }
}
