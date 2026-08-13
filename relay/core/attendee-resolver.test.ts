import { describe, expect, it } from "vitest";
import { buildAttendeeIndex, resolveAttendees } from "./attendee-resolver.js";
import type { Persona } from "./types.js";

const persona = (over: Partial<Persona> & Pick<Persona, "key" | "displayName">): Persona => ({
  relationship: "colleague",
  handles: {},
  language: "en",
  register: "casual",
  toneNotes: "",
  context: "",
  ...over,
});

const michael = persona({
  key: "michael-dobosz",
  displayName: "Michael Dobosz",
  handles: { slack: "UMICHAEL", gmail: "michael@taiv.tv" },
});
const zech = persona({
  key: "zech-noiseux",
  displayName: "Zech Noiseux",
  handles: { slack: "UZECH", gmail: "zech@taiv.tv" },
});
// WeChat-only contact: a real person the engine cannot invite.
const gouwa = persona({ key: "gouwa-wang", displayName: "Gouwa Wang", handles: { wechat: "gouwa" } });

describe("resolveAttendees", () => {
  // The owner writes first names ("加 Michael 和 zech 到参加人"), and those used to
  // be dropped because buildCalendarEvent keeps only entries that are already
  // addresses.
  it("resolves a FIRST name to that person's address", () => {
    expect(resolveAttendees(["Michael", "zech"], [michael, zech])).toEqual({
      emails: ["michael@taiv.tv", "zech@taiv.tv"],
      unresolved: [],
    });
  });

  it("resolves a full display name, a persona key and a handle too", () => {
    const r = resolveAttendees(["Michael Dobosz", "zech-noiseux", "UMICHAEL"], [michael, zech]);
    expect(r.emails).toEqual(["michael@taiv.tv", "zech@taiv.tv"]);
    expect(r.unresolved).toEqual([]);
  });

  // An address the thread stated beats any lookup.
  it("passes an address through untouched", () => {
    expect(resolveAttendees(["outside@partner.com"], [michael]).emails).toEqual([
      "outside@partner.com",
    ]);
  });

  // REGRESSION: recipient-resolver's Map would have let the second Michael
  // overwrite the first and resolved to whoever loaded last. Silently picking
  // one of two people IS the wrong-recipient failure.
  it("refuses an ambiguous first name instead of picking one", () => {
    const other = persona({
      key: "michael-zhang",
      displayName: "Michael Zhang",
      handles: { gmail: "mzhang@osyx.tech" },
    });
    const r = resolveAttendees(["Michael"], [michael, other]);
    expect(r.emails).toEqual([]);
    expect(r.unresolved).toEqual(["Michael"]);
    // …while the unambiguous full name still resolves
    expect(resolveAttendees(["Michael Zhang"], [michael, other]).emails).toEqual([
      "mzhang@osyx.tech",
    ]);
  });

  it("reports a name with no persona at all", () => {
    expect(resolveAttendees(["Nobody Here"], [michael])).toEqual({
      emails: [],
      unresolved: ["Nobody Here"],
    });
  });

  // Resolved to a real person we cannot invite — reported, never invented.
  it("reports a persona that has no email on file", () => {
    expect(resolveAttendees(["Gouwa Wang"], [gouwa])).toEqual({
      emails: [],
      unresolved: ["Gouwa Wang"],
    });
  });

  it("dedupes, whether the same person arrives by name or by address", () => {
    const r = resolveAttendees(["Michael", "michael@taiv.tv", "Michael Dobosz"], [michael]);
    expect(r.emails).toEqual(["michael@taiv.tv"]);
  });

  it("ignores blanks and is case/whitespace insensitive", () => {
    const r = resolveAttendees(["  ", "  MICHAEL  "], [michael]);
    expect(r.emails).toEqual(["michael@taiv.tv"]);
    expect(r.unresolved).toEqual([]);
  });
});

describe("buildAttendeeIndex", () => {
  it("keeps a SET per alias so a collision is representable", () => {
    const other = persona({ key: "michael-zhang", displayName: "Michael Zhang", handles: {} });
    expect(buildAttendeeIndex([michael, other]).get("michael")?.size).toBe(2);
    expect(buildAttendeeIndex([michael, other]).get("michael dobosz")?.size).toBe(1);
  });

  it("does not add a first-name alias for a single-word display name", () => {
    const solo = persona({ key: "cody", displayName: "Cody", handles: { gmail: "cody@taiv.tv" } });
    expect(buildAttendeeIndex([solo]).get("cody")).toEqual(new Set(["cody"]));
  });
});
