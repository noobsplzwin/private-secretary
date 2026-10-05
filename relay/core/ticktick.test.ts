import { describe, expect, it } from "vitest";
import { resolveTickTickProject } from "./ticktick.js";

describe("resolveTickTickProject", () => {
  const projects = [
    { id: "1", name: "💼Work" },
    { id: "2", name: "🏡Memo" },
    { id: "3", name: "秦老师" },
  ];

  it("resolves an exact name, ignoring case and surrounding space", () => {
    expect(resolveTickTickProject("  💼work ", projects)).toEqual({ status: "resolved", id: "1" });
    expect(resolveTickTickProject("秦老师", projects)).toEqual({ status: "resolved", id: "3" });
  });

  // ASK-not-GUESS: a near miss must not file the to-do somewhere the user
  // never looks.
  it("does not resolve a partial or fuzzy match", () => {
    expect(resolveTickTickProject("Work", projects)).toEqual({ status: "not_found" });
    expect(resolveTickTickProject("", projects)).toEqual({ status: "not_found" });
  });

  it("reports ambiguity instead of picking one", () => {
    const dupes = [{ id: "1", name: "Work" }, { id: "2", name: "work" }];
    expect(resolveTickTickProject("Work", dupes)).toEqual({
      status: "ambiguous",
      matches: ["1", "2"],
    });
  });
});
