// Google Drive v3 wire layer, bound to ONE Google account. Same token store as
// GmailClient (relay/io/google-oauth.ts): the bundle in Keychain must carry the
// drive scope — scripts/auth/google-oauth.ts consent grants it.
//
// Read: list/search, metadata, export (Google-native files), download (bytes).
// Write: upload a new file, create a folder. Nothing here edits, moves or
// deletes an existing file.

import { getAccessToken } from "./google-oauth.js";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FIELDS = "id,name,mimeType,size,modifiedTime,parents,webViewLink,owners(emailAddress)";
const ALL_DRIVES = "supportsAllDrives=true";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  parents?: string[];
  webViewLink?: string;
  owners?: Array<{ emailAddress?: string }>;
}

export class DriveScopeMissing extends Error {}

export class DriveClient {
  constructor(private readonly email: string, private readonly fetchFn: typeof fetch = globalThis.fetch) {}

  private async token(): Promise<string> {
    const b = await getAccessToken(this.email);
    if (!/\/auth\/drive(\s|$|\.readonly)/.test(b.scope)) {
      throw new DriveScopeMissing(
        `${this.email} has no Drive permission yet. Re-run: npx tsx scripts/auth/google-oauth.ts consent ${b.oauth_client_service} ${b.oauth_client_account} ${this.email}`,
      );
    }
    return b.access_token;
  }

  // Retries 429/5xx like GmailClient; any other non-2xx throws with the body.
  private async req(url: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const headers = { ...(init.headers as Record<string, string>), Authorization: `Bearer ${await this.token()}` };
      const r = await this.fetchFn(url, { ...init, headers });
      if ((r.status === 429 || r.status >= 500) && attempt < 3) {
        await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
        continue;
      }
      if (!r.ok) throw new Error(`Drive ${init.method ?? "GET"} ${url.split("?")[0]} failed: HTTP ${r.status} ${await r.text()}`);
      return r;
    }
  }

  async list(q: string, pageSize: number): Promise<DriveFile[]> {
    const p = new URLSearchParams({ q, pageSize: String(pageSize), fields: `files(${FIELDS})`, orderBy: "modifiedTime desc", includeItemsFromAllDrives: "true", supportsAllDrives: "true" });
    return ((await (await this.req(`${API}/files?${p}`)).json()) as { files?: DriveFile[] }).files ?? [];
  }

  async get(id: string): Promise<DriveFile> {
    return (await this.req(`${API}/files/${encodeURIComponent(id)}?fields=${FIELDS}&${ALL_DRIVES}`)).json() as Promise<DriveFile>;
  }

  async download(id: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.req(`${API}/files/${encodeURIComponent(id)}?alt=media&${ALL_DRIVES}`)).arrayBuffer());
  }

  async export(id: string, mimeType: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.req(`${API}/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(mimeType)}`)).arrayBuffer());
  }

  // Resumable upload: one session POST with the metadata, one PUT with the bytes.
  async upload(o: { name: string; mimeType: string; data: Uint8Array; parentId?: string }): Promise<DriveFile> {
    const meta = { name: o.name, ...(o.parentId ? { parents: [o.parentId] } : {}) };
    const start = await this.req(`${UPLOAD}/files?uploadType=resumable&${ALL_DRIVES}&fields=${FIELDS}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": o.mimeType },
      body: JSON.stringify(meta),
    });
    const session = start.headers.get("Location");
    if (!session) throw new Error("Drive upload: no resumable session URL returned");
    const done = await this.req(session, { method: "PUT", headers: { "Content-Type": o.mimeType }, body: new Blob([Buffer.from(o.data)]) });
    return done.json() as Promise<DriveFile>;
  }

  async createFolder(name: string, parentId?: string): Promise<DriveFile> {
    const r = await this.req(`${API}/files?${ALL_DRIVES}&fields=${FIELDS}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", ...(parentId ? { parents: [parentId] } : {}) }),
    });
    return r.json() as Promise<DriveFile>;
  }
}
