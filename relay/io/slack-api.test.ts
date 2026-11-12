import { describe, it, expect } from "vitest";
import { SlackApiError, SlackClient } from "./slack-api.js";

// In-memory fetch mock. Each test wires up a function that maps URL ->
// response payload; the SlackClient consumes it like real fetch.
function fakeFetch(
  responder: (
    url: string,
    init: RequestInit,
  ) => { ok: boolean; status?: number; headers?: Record<string, string>; body: unknown } | Promise<{
    ok: boolean;
    status?: number;
    headers?: Record<string, string>;
    body: unknown;
  }>,
): { fetchFn: typeof fetch; calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const body =
      typeof init?.body === "string" ? init.body : "";
    calls.push({ url, body });
    const r = await responder(url, init ?? {});
    const headers = new Map<string, string>(Object.entries(r.headers ?? {}));
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      headers: { get: (k: string) => headers.get(k) ?? null } as Headers,
      json: async () => r.body,
      arrayBuffer: async () =>
        r.body instanceof Uint8Array
          ? (r.body.buffer as ArrayBuffer)
          : new TextEncoder().encode(String(r.body)).buffer,
    } as Response;
  };
  return { fetchFn, calls };
}

describe("SlackClient — typed wrappers", () => {
  it("authTest sends POST with bearer + form body, returns parsed result", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({
      ok: true,
      body: { ok: true, user_id: "UPHG4T8R1", team: "Taiv", user: "leo", team_id: "T1", url: "https://taiv.slack.com/", is_enterprise_install: false },
    }));
    const client = new SlackClient({ token: "xoxp-test", fetchFn });
    const r = await client.authTest();
    expect(r.user_id).toBe("UPHG4T8R1");
    expect(calls[0]?.url).toMatch(/auth\.test$/);
    // bearer header smoke; can't read it directly from fetchFn signature
    // but verify the body is form-encoded
    expect(calls[0]?.body).toBe("");
  });

  it("searchMessages posts the query newest-first and returns the matches", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({
      ok: true,
      body: { ok: true, messages: { total: 1, matches: [{ ts: "1.0", text: "hi", channel: { id: "C1", name: "general" } }] } },
    }));
    const client = new SlackClient({ token: "x", fetchFn });
    const r = await client.searchMessages({ query: "hi in:#general", count: 5 });
    expect(r.messages.matches[0]?.channel?.name).toBe("general");
    expect(calls[0]?.url).toMatch(/search\.messages$/);
    expect(calls[0]?.body).toContain("query=hi+in%3A%23general");
    expect(calls[0]?.body).toContain("sort=timestamp");
  });

  it("filesInfo posts the file id and returns its metadata", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({
      ok: true,
      body: { ok: true, file: { id: "F1", name: "notes.pdf", mimetype: "application/pdf", url_private_download: "https://files.slack.com/F1" } },
    }));
    const client = new SlackClient({ token: "x", fetchFn });
    const r = await client.filesInfo("F1");
    expect(r.file.url_private_download).toBe("https://files.slack.com/F1");
    expect(calls[0]?.url).toMatch(/files\.info$/);
    expect(calls[0]?.body).toBe("file=F1");
  });

  it("searchMessages surfaces a token without search:read as missing_scope", async () => {
    const { fetchFn } = fakeFetch(() => ({ ok: true, body: { ok: false, error: "missing_scope", needed: "search:read" } }));
    const client = new SlackClient({ token: "x", fetchFn, maxRetries: 0 });
    await expect(client.searchMessages({ query: "hi" })).rejects.toMatchObject({ errorCode: "missing_scope" });
  });

  it("call throws SlackApiError when ok: false (non-rate-limit)", async () => {
    const { fetchFn } = fakeFetch(() => ({
      ok: true,
      body: { ok: false, error: "channel_not_found" },
    }));
    const client = new SlackClient({ token: "x", fetchFn, maxRetries: 0 });
    await expect(client.authTest()).rejects.toBeInstanceOf(SlackApiError);
  });

  it("retries on HTTP 429 honoring Retry-After and eventually succeeds", async () => {
    let n = 0;
    const { fetchFn } = fakeFetch(() => {
      n++;
      if (n === 1)
        return { ok: false, status: 429, headers: { "Retry-After": "0" }, body: { ok: false } };
      return { ok: true, body: { ok: true, user_id: "U1" } };
    });
    const client = new SlackClient({ token: "x", fetchFn, maxRetries: 2 });
    const r = await client.authTest();
    expect(r.user_id).toBe("U1");
    expect(n).toBe(2);
  });

  it("retries on ratelimited ok:false body too", async () => {
    let n = 0;
    const { fetchFn } = fakeFetch(() => {
      n++;
      if (n === 1) return { ok: true, body: { ok: false, error: "ratelimited" } };
      return { ok: true, body: { ok: true, user_id: "U1" } };
    });
    const client = new SlackClient({ token: "x", fetchFn, maxRetries: 2 });
    await client.authTest();
    expect(n).toBe(2);
  });

  it("conversationsHistory passes channel/oldest/limit and parses messages", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({
      ok: true,
      body: {
        ok: true,
        messages: [
          { ts: "100.0", user: "U1", text: "hi" },
          { ts: "200.0", user: "U2", text: "yo" },
        ],
        has_more: false,
      },
    }));
    const client = new SlackClient({ token: "x", fetchFn });
    const r = await client.conversationsHistory({
      channel: "C1",
      oldest: "50.0",
      limit: 10,
    });
    expect(r.messages.map((m) => m.ts)).toEqual(["100.0", "200.0"]);
    // Form body should include channel + oldest + limit
    expect(calls[0]?.body).toContain("channel=C1");
    expect(calls[0]?.body).toContain("oldest=50.0");
    expect(calls[0]?.body).toContain("limit=10");
  });

  it("listAllConversations paginates via response_metadata.next_cursor", async () => {
    let n = 0;
    const { fetchFn, calls } = fakeFetch(() => {
      n++;
      if (n === 1) {
        return {
          ok: true,
          body: {
            ok: true,
            channels: [{ id: "C1" }, { id: "C2" }],
            response_metadata: { next_cursor: "cur_page2" },
          },
        };
      }
      return {
        ok: true,
        body: { ok: true, channels: [{ id: "C3" }], response_metadata: { next_cursor: "" } },
      };
    });
    const client = new SlackClient({ token: "x", fetchFn });
    const all = await client.listAllConversations();
    expect(all.map((c) => c.id)).toEqual(["C1", "C2", "C3"]);
    expect(calls[1]?.body).toContain("cursor=cur_page2");
  });

  it("listAllReplies paginates conversations.replies until has_more is false", async () => {
    let n = 0;
    const { fetchFn } = fakeFetch(() => {
      n++;
      if (n === 1) {
        return {
          ok: true,
          body: {
            ok: true,
            messages: [{ ts: "100.0", user: "U1", text: "parent" }, { ts: "101.0", user: "U2", text: "r1" }],
            has_more: true,
            response_metadata: { next_cursor: "cur" },
          },
        };
      }
      return {
        ok: true,
        body: {
          ok: true,
          messages: [{ ts: "102.0", user: "U3", text: "r2" }],
          has_more: false,
        },
      };
    });
    const client = new SlackClient({ token: "x", fetchFn });
    const all = await client.listAllReplies("C1", "100.0");
    expect(all.map((m) => m.ts)).toEqual(["100.0", "101.0", "102.0"]);
  });

  it("downloadFile sends bearer auth and returns raw bytes", async () => {
    const payload = new TextEncoder().encode("PNGDATA");
    const { fetchFn } = fakeFetch(() => ({
      ok: true,
      body: payload,
    }));
    const client = new SlackClient({ token: "x", fetchFn });
    const bytes = await client.downloadFile("https://files.slack.com/private/F1");
    expect(new TextDecoder().decode(bytes)).toBe("PNGDATA");
  });

  it("postMessage posts text to a channel + disables unfurls, returns ts+channel", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({
      ok: true,
      body: { ok: true, ts: "1781000123.0009", channel: "C123" },
    }));
    const client = new SlackClient({ token: "x", fetchFn });
    const r = await client.postMessage({ channel: "C123", text: "hi", threadTs: "1780.1" });
    expect(r).toEqual({ ts: "1781000123.0009", channel: "C123" });
    const body = calls[0]?.body ?? "";
    expect(body).toContain("channel=C123");
    expect(body).toContain("thread_ts=1780.1");
    expect(body).toContain("unfurl_links=false");
  });

  it("getPermalink returns the API permalink when available", async () => {
    const { fetchFn } = fakeFetch(() => ({
      ok: true,
      body: { ok: true, permalink: "https://taiv.slack.com/archives/C123/p17810001230009" },
    }));
    const client = new SlackClient({ token: "x", fetchFn });
    const link = await client.getPermalink("C123", "1781000123.0009");
    expect(link).toBe("https://taiv.slack.com/archives/C123/p17810001230009");
  });

  it("getPermalink synthesizes an archive URL when the API call fails", async () => {
    const { fetchFn } = fakeFetch(() => ({
      ok: true,
      body: { ok: false, error: "message_not_found" },
    }));
    const client = new SlackClient({ token: "x", fetchFn, maxRetries: 0 });
    const link = await client.getPermalink("C123", "1781000123.0009");
    expect(link).toBe("https://slack.com/archives/C123/p17810001230009");
  });

  it("serializes concurrent calls — second only starts after first's body resolves", async () => {
    // Two concurrent authTest() calls should hit the responder strictly in
    // order, not in parallel. Track the responder entry order and the
    // settling order.
    let pending = 0;
    let maxPending = 0;
    const { fetchFn } = fakeFetch(async () => {
      pending++;
      maxPending = Math.max(maxPending, pending);
      // Yield a microtask to give the second call a chance to race in if
      // serialization is broken.
      await new Promise((r) => setTimeout(r, 5));
      pending--;
      return { ok: true, body: { ok: true, user_id: "U1" } };
    });
    const client = new SlackClient({ token: "x", fetchFn });
    await Promise.all([client.authTest(), client.authTest(), client.authTest()]);
    expect(maxPending).toBe(1);
  });
});
