import { describe, it, expect } from "vitest";
import { buildMime, clip, downloadExport, driveQuery, GOOGLE_DOC, GOOGLE_SHEET, mimeFromName, parseTime, pickByName, replySubject, textExportMime } from "./messages-core.js";

describe("parseTime", () => {
  it("reads a date and a date-time as local time", () => {
    expect(parseTime("2026-09-01")).toBe(new Date(2026, 8, 1).getTime());
    expect(parseTime("2026-09-01 14:30")).toBe(new Date(2026, 8, 1, 14, 30).getTime());
  });

  it("passes an absent value through and rejects anything else", () => {
    expect(parseTime(undefined)).toBeUndefined();
    expect(parseTime("")).toBeUndefined();
    expect(() => parseTime("last tuesday")).toThrow(/YYYY-MM-DD/);
    expect(() => parseTime("2026-13-40")).toThrow(/YYYY-MM-DD/);
  });
});

describe("pickByName", () => {
  const people = [
    { id: "U1", names: ["Michael Dobosz"] },
    { id: "U2", names: ["Michael Wenz"] },
    { id: "U3", names: ["Ihor Kachura", "ihor"] },
  ];
  const names = (p: (typeof people)[number]) => p.names;

  it("an exact name wins even when it is also a substring of others", () => {
    expect(pickByName(people, names, "ihor")).toEqual({ kind: "one", item: people[2] });
  });

  it("a substring with ONE match resolves to it", () => {
    expect(pickByName(people, names, "dobosz")).toEqual({ kind: "one", item: people[0] });
  });

  it("an ambiguous name returns every candidate instead of picking one", () => {
    expect(pickByName(people, names, "michael")).toEqual({ kind: "many", items: [people[0], people[1]] });
  });

  it("no match is reported as none", () => {
    expect(pickByName(people, names, "zack")).toEqual({ kind: "none" });
  });
});

describe("clip", () => {
  it("leaves short text alone and says how much a long one lost", () => {
    expect(clip("abc", 10)).toBe("abc");
    expect(clip("abcdefghij", 4)).toBe("abcd\n\n…[truncated: 6 more characters]");
  });
});

describe("buildMime", () => {
  const decode = (raw: string, marker: string) => {
    const lines = raw.split("\r\n");
    const at = lines.findIndex((l, i) => l === "" && lines[i - 1]?.startsWith(marker));
    const out: string[] = [];
    for (let i = at + 1; i < lines.length && lines[i] && !lines[i]!.startsWith("--"); i++) out.push(lines[i]!);
    return Buffer.from(out.join(""), "base64").toString("utf8");
  };

  it("a plain draft has no multipart wrapper and a base64 UTF-8 body", () => {
    const raw = buildMime({ to: ["a@x.pt"], subject: "Hello", body: "Line 1\nOlá" });
    expect(raw).toContain("To: a@x.pt\r\nSubject: Hello\r\n");
    expect(raw).not.toContain("multipart");
    expect(decode(raw, "Content-Transfer-Encoding")).toBe("Line 1\r\nOlá");
  });

  it("a reply carries In-Reply-To / References and Cc", () => {
    const raw = buildMime({ to: ["a@x.pt"], cc: ["b@x.pt", "c@x.pt"], subject: "Re: NIF", body: "ok", inReplyTo: "<m1@x>", references: "<m0@x> <m1@x>" });
    expect(raw).toContain("Cc: b@x.pt, c@x.pt\r\n");
    expect(raw).toContain("In-Reply-To: <m1@x>\r\nReferences: <m0@x> <m1@x>\r\n");
  });

  it("a non-ASCII subject and filename become RFC 2047 encoded-words", () => {
    const raw = buildMime({ to: ["a@x"], subject: "护照", body: "", attachments: [{ filename: "护照.pdf", mimeType: "application/pdf", data: new Uint8Array([1]) }], boundary: "B" });
    expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from("护照").toString("base64")}?=`);
    expect(raw).toContain(`filename="=?UTF-8?B?${Buffer.from("护照.pdf").toString("base64")}?="`);
  });

  it("attachments go in multipart/mixed after the text part, base64 in 76-char lines", () => {
    const data = new Uint8Array(200).fill(7);
    const raw = buildMime({ to: ["a@x"], subject: "s", body: "hi", attachments: [{ filename: "n.pdf", mimeType: "application/pdf", data }], boundary: "B" });
    expect(raw).toContain('Content-Type: multipart/mixed; boundary="B"');
    expect(raw.indexOf("text/plain")).toBeLessThan(raw.indexOf("application/pdf"));
    const b64 = raw.split("\r\n").filter((l) => /^[A-Za-z0-9+/=]+$/.test(l) && l.length > 4);
    expect(b64.every((l) => l.length <= 76)).toBe(true);
    expect(Buffer.from(raw.split('filename="n.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1]!.split("\r\n--B")[0]!.replace(/\r\n/g, ""), "base64")).toEqual(Buffer.from(data));
    expect(raw.trimEnd().endsWith("--B--")).toBe(true);
  });

  it("refuses header injection and an empty To", () => {
    expect(() => buildMime({ to: ["a@x"], subject: "x\r\nBcc: evil@y", body: "" })).toThrow(/line breaks/);
    expect(() => buildMime({ to: [], subject: "x", body: "" })).toThrow(/To/);
  });
});

describe("replySubject / mimeFromName", () => {
  it("adds Re: once", () => {
    expect(replySubject("NIF")).toBe("Re: NIF");
    expect(replySubject("RE: NIF")).toBe("RE: NIF");
  });
  it("guesses common types and falls back to octet-stream", () => {
    expect(mimeFromName("a/Leo_NOA_2025.PDF")).toBe("application/pdf");
    expect(mimeFromName("x.unknown")).toBe("application/octet-stream");
  });
});

describe("driveQuery", () => {
  it("keywords search name and full text, never trash", () => {
    expect(driveQuery({ query: "NOA" })).toBe("trashed = false and (name contains 'NOA' or fullText contains 'NOA')");
  });
  it("a folder lists its children and quotes are escaped", () => {
    expect(driveQuery({ folderId: "F1", query: "Leo's" })).toBe("trashed = false and 'F1' in parents and (name contains 'Leo\\'s' or fullText contains 'Leo\\'s')");
  });
  it("raw replaces everything", () => {
    expect(driveQuery({ query: "x", raw: "mimeType = 'application/pdf'" })).toBe("mimeType = 'application/pdf'");
  });
});

describe("textExportMime / downloadExport", () => {
  it("reads Docs as markdown, Sheets as csv, binaries not at all", () => {
    expect(textExportMime(GOOGLE_DOC)).toBe("text/markdown");
    expect(textExportMime(GOOGLE_SHEET)).toBe("text/csv");
    expect(textExportMime("application/pdf")).toBeNull();
  });
  it("downloads Google files as PDF unless told otherwise, and rejects unknown formats", () => {
    expect(downloadExport(undefined)).toEqual({ mime: "application/pdf", ext: ".pdf" });
    expect(downloadExport("docx").ext).toBe(".docx");
    expect(() => downloadExport("odt")).toThrow(/export_as/);
  });
});
