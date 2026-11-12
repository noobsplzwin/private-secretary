// Pure helpers for the messages MCP server (messages-server.ts).

import { randomBytes } from "node:crypto";
import { extname } from "node:path";

const TIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/;

// "YYYY-MM-DD" or "YYYY-MM-DD HH:MM", read as local time, to epoch ms. Anything
// else throws: a window the caller did not mean is worse than an error.
export function parseTime(s: string | undefined): number | undefined {
  if (!s?.trim()) return undefined;
  const m = TIME_RE.exec(s.trim());
  const d = m && new Date(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0));
  if (!d || d.getMonth() !== +m![2]! - 1 || d.getDate() !== +m![3]!) {
    throw new Error(`time must be YYYY-MM-DD or YYYY-MM-DD HH:MM, got "${s}"`);
  }
  return d.getTime();
}

export type Picked<T> = { kind: "one"; item: T } | { kind: "many"; items: T[] } | { kind: "none" };

// Find a conversation by a human name. An exact (case-insensitive) name wins;
// otherwise a substring that matches exactly one item. Several matches come
// back as candidates — the caller asks, it never picks one for the user.
export function pickByName<T>(items: T[], names: (t: T) => string[], query: string): Picked<T> {
  const q = query.trim().toLowerCase();
  const exact = items.filter((t) => names(t).some((n) => n.toLowerCase() === q));
  if (exact.length === 1) return { kind: "one", item: exact[0]! };
  const loose = exact.length ? exact : items.filter((t) => names(t).some((n) => n.toLowerCase().includes(q)));
  if (loose.length === 1) return { kind: "one", item: loose[0]! };
  return loose.length ? { kind: "many", items: loose } : { kind: "none" };
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n\n…[truncated: ${text.length - max} more characters]`;
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ─── gmail drafts ───────────────────────────────────────────────────

export interface MimeAttachment { filename: string; mimeType: string; data: Uint8Array }
export interface MimeMessage {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  attachments?: MimeAttachment[];
  boundary?: string; // tests pin it; otherwise random
}

// RFC 2047: a header value with anything outside printable ASCII goes out as one
// UTF-8 base64 encoded-word.
export function encodeHeaderWord(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

const b64Lines = (data: Uint8Array) => Buffer.from(data).toString("base64").replace(/.{76}/g, "$&\r\n");

// RFC 5322 message, ready for base64url → drafts.create. A CR or LF inside a
// header value is refused: it would let the value write headers of its own.
export function buildMime(m: MimeMessage): string {
  const values = [...m.to, ...(m.cc ?? []), ...(m.bcc ?? []), m.subject, m.inReplyTo ?? "", m.references ?? "", ...(m.attachments ?? []).map((a) => a.filename)];
  if (values.some((v) => /[\r\n]/.test(v))) throw new Error("header values must not contain line breaks");
  if (!m.to.length) throw new Error("a draft needs at least one To address");
  const head = [
    `To: ${m.to.join(", ")}`,
    m.cc?.length ? `Cc: ${m.cc.join(", ")}` : "",
    m.bcc?.length ? `Bcc: ${m.bcc.join(", ")}` : "",
    `Subject: ${encodeHeaderWord(m.subject)}`,
    m.inReplyTo ? `In-Reply-To: ${m.inReplyTo}` : "",
    m.references ? `References: ${m.references}` : "",
    "MIME-Version: 1.0",
  ].filter(Boolean);
  const text = ['Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", b64Lines(Buffer.from(m.body.replace(/\r?\n/g, "\r\n"), "utf8"))];
  if (!m.attachments?.length) return [...head, ...text].join("\r\n");
  const b = m.boundary ?? `=_part_${randomBytes(12).toString("hex")}`;
  const parts = m.attachments.flatMap((a) => {
    const name = encodeHeaderWord(a.filename.replace(/"/g, ""));
    return [`--${b}`, `Content-Type: ${a.mimeType}; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`, "Content-Transfer-Encoding: base64", "", b64Lines(a.data)];
  });
  return [...head, `Content-Type: multipart/mixed; boundary="${b}"`, "", `--${b}`, ...text, ...parts, `--${b}--`, ""].join("\r\n");
}

export const replySubject = (s: string) => (/^re:/i.test(s.trim()) ? s.trim() : `Re: ${s.trim()}`);

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json", ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
export const mimeFromName = (name: string) => MIME_BY_EXT[extname(name).toLowerCase()] ?? "application/octet-stream";

// ─── google drive ───────────────────────────────────────────────────

const driveQuote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

// Drive `q` from plain keywords and/or a folder. `raw` (Drive query syntax)
// replaces both. Trashed files never show unless `raw` asks for them.
export function driveQuery(o: { query?: string; folderId?: string; raw?: string }): string {
  if (o.raw?.trim()) return o.raw.trim();
  const parts = ["trashed = false"];
  if (o.folderId) parts.push(`${driveQuote(o.folderId)} in parents`);
  if (o.query?.trim()) parts.push(`(name contains ${driveQuote(o.query.trim())} or fullText contains ${driveQuote(o.query.trim())})`);
  return parts.join(" and ");
}

export const GOOGLE_DOC = "application/vnd.google-apps.document";
export const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
export const GOOGLE_SLIDES = "application/vnd.google-apps.presentation";
export const GOOGLE_FOLDER = "application/vnd.google-apps.folder";

// How to read a Google-native file as text (export), or null for a binary file.
export function textExportMime(mimeType: string): string | null {
  return { [GOOGLE_DOC]: "text/markdown", [GOOGLE_SHEET]: "text/csv", [GOOGLE_SLIDES]: "text/plain" }[mimeType] ?? null;
}

// Download format for a Google-native file: `as` picks one, else PDF.
const EXPORT_AS: Record<string, [string, string]> = {
  pdf: ["application/pdf", ".pdf"], docx: [MIME_BY_EXT[".docx"]!, ".docx"], xlsx: [MIME_BY_EXT[".xlsx"]!, ".xlsx"],
  pptx: [MIME_BY_EXT[".pptx"]!, ".pptx"], csv: ["text/csv", ".csv"], md: ["text/markdown", ".md"], txt: ["text/plain", ".txt"],
};
export function downloadExport(as: string | undefined): { mime: string; ext: string } {
  const hit = EXPORT_AS[(as ?? "pdf").toLowerCase()];
  if (!hit) throw new Error(`export_as must be one of ${Object.keys(EXPORT_AS).join(", ")}`);
  return { mime: hit[0], ext: hit[1] };
}
