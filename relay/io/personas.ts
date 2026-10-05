// Persona file loader. personas/<key>.yaml -> Persona[]. Rebuilt every pass (cheap).
// Reads BOTH layouts: the v3 hierarchical schema (specs/persona-v3.md) and the
// legacy flat v2 shape (pre-migration), mapping either to the flat Persona the
// pipeline consumes. Validation is strict: a malformed persona throws with a
// clear message rather than silently producing a half-built contact.
//
// WRITES never happen here — every persona write goes through the
// relay/io/persona-store.ts chokepoint (R1 guard).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Language, Persona, Platform, Register } from "../core/types.js";
import { isV3, type PersonaV3 } from "../core/persona-v3.js";

const PLATFORMS: Platform[] = ["slack", "gmail", "wechat"];
const LANGS: Language[] = ["en", "zh"];
const REGISTERS: Register[] = ["formal", "casual"];

export class PersonaParseError extends Error {
  constructor(file: string, detail: string) {
    super(`Invalid persona ${file}: ${detail}`);
    this.name = "PersonaParseError";
  }
}

function parseHandles(raw: unknown): Partial<Record<Platform, string>> {
  const handles: Partial<Record<Platform, string>> = {};
  const h = (raw ?? {}) as Record<string, unknown>;
  for (const p of PLATFORMS) {
    const v = h[p];
    if (v != null && typeof v === "string" && v.trim() !== "") handles[p] = v;
  }
  return handles;
}

function requireEnum<T extends string>(
  file: string,
  field: string,
  value: unknown,
  allowed: T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw new PersonaParseError(file, `${field} must be one of ${allowed.join("|")}`);
  return value as T;
}

function requireString(file: string, field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new PersonaParseError(file, `missing or empty "${field}"`);
  return value;
}

function parseV3(o: Record<string, unknown>, file: string): Persona {
  const v3 = o as unknown as PersonaV3;
  const comm = v3.communication ?? {};
  const identity = v3.identity ?? {};
  const relationship = [identity.role, identity.relationship]
    .filter((s): s is string => typeof s === "string" && s.trim() !== "")
    .join("; ");
  return {
    key: requireString(file, "key", v3.key),
    displayName: requireString(file, "display_name", v3.display_name),
    relationship,
    handles: parseHandles(v3.handles),
    language: requireEnum(file, "communication.language", comm.language, LANGS),
    register: requireEnum(file, "communication.register", comm.register, REGISTERS),
    toneNotes: typeof comm.tone_notes === "string" ? comm.tone_notes : "",
    context: typeof v3.open_threads === "string" ? v3.open_threads : "",
    ...(v3.work && (v3.work.skills?.length || v3.work.owns?.length || v3.work.projects?.length)
      ? { work: v3.work }
      : {}),
    ...(Array.isArray(v3.behavior?.landmines) && v3.behavior.landmines.length > 0
      ? { landmines: v3.behavior.landmines }
      : {}),
    ...(Array.isArray(v3.corrections) && v3.corrections.length > 0
      ? { corrections: v3.corrections }
      : {}),
  };
}

function parseLegacy(o: Record<string, unknown>, file: string): Persona {
  return {
    key: requireString(file, "key", o.key),
    displayName: requireString(file, "display_name", o.display_name),
    relationship: typeof o.relationship === "string" ? o.relationship : "",
    handles: parseHandles(o.handles),
    language: requireEnum(file, "language", o.language, LANGS),
    register: requireEnum(file, "register", o.register, REGISTERS),
    toneNotes: typeof o.tone_notes === "string" ? o.tone_notes : "",
    context: typeof o.context === "string" ? o.context : "",
  };
}

export function parsePersona(raw: unknown, file = "<inline>"): Persona {
  if (typeof raw !== "object" || raw === null)
    throw new PersonaParseError(file, "not a mapping");
  const o = raw as Record<string, unknown>;
  return isV3(o) ? parseV3(o, file) : parseLegacy(o, file);
}

export function loadPersonas(dir: string): Persona[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  } catch {
    return []; // no personas dir yet -> empty (unknown senders still surface)
  }
  return files.map((f) => parsePersona(parse(readFileSync(join(dir, f), "utf8")), f));
}

