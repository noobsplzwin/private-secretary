// An attached file, turned into text the drafter can actually read.
//
// WHY: the pipeline had no file reader at all. 「股权方案.svg」 — a finished
// three-stage equity plan the owner had just agreed with five people — reached
// the model as the six characters 「[文件] 股权方案.svg」 and nothing else, so
// no card was ever minted for it. Declaring it unreadable (2026-09-27) stopped
// the engine handing its blindness back as a to-do; this is the other half.
//
// DELIBERATELY DEPENDENCY-FREE. This repo runs on two runtime packages and a
// PDF or .docx reader is not worth becoming the third — those are zip+binary
// formats whose parsers carry real surface area. Everything text-shaped is
// read here; everything else stays declared-unreadable, which is honest and
// already wired.

/** Extensions whose bytes ARE text. Anything else is left to the unreadable path. */
const TEXT_EXT = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "xml", "svg", "html", "htm",
  "yml", "yaml", "log", "ini", "conf", "toml",
  // Source files get attached surprisingly often — config.c in a bring-up
  // thread is the point of the message, not decoration.
  "c", "h", "cpp", "hpp", "py", "ts", "js", "sh", "rs", "go", "java", "sql", "dts",
]);

/**
 * Per file. Big enough for a real document, small enough that one attachment
 * cannot crowd out the conversation it arrived in — the prompt already carries
 * persona, projects and thread history.
 */
export const MAX_FILE_CHARS = 20_000;

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function isReadableFile(name: string): boolean {
  return TEXT_EXT.has(extensionOf(name));
}

/**
 * Strip an SVG down to the words a human would see. A 35KB drawing is mostly
 * path data; its <text> nodes are the whole content, and feeding the raw markup
 * would spend the budget on coordinates. Returns the labels in document order,
 * which for a diagram is reading order closely enough to follow.
 */
export function svgToText(xml: string): string {
  const out: string[] = [];
  for (const m of xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)) {
    const line = unescapeXml(m[1]!.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (line !== "") out.push(line);
  }
  return out.join("\n");
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export interface FileText {
  name: string;
  text: string;
  /** True when the content was cut at MAX_FILE_CHARS — said out loud, never silent. */
  truncated: boolean;
}

/**
 * Returns null when the extension is not text-shaped, or the bytes decode to
 * nothing useful. A null here means the caller keeps declaring the file
 * unreadable, which is the pre-existing, honest behaviour.
 */
export function fileToText(name: string, raw: string): FileText | null {
  if (!isReadableFile(name)) return null;
  const ext = extensionOf(name);
  let text = ext === "svg" ? svgToText(raw) : raw;
  // A binary file renamed .txt, or a decode that produced replacement chars:
  // better to declare it unreadable than to feed the model noise.
  const junk = (text.match(/�/g) ?? []).length;
  if (text.trim() === "" || junk > text.length / 50) return null;
  const truncated = text.length > MAX_FILE_CHARS;
  if (truncated) text = `${text.slice(0, MAX_FILE_CHARS)}\n…（已截断，原文更长）`;
  return { name, text, truncated };
}
