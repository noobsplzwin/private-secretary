import { describe, expect, it } from "vitest";
import { callResultObject, callResultRows, callResultText } from "./mcp-tool.js";

// Helper: a callTool result with N text blocks.
const result = (...texts: string[]) => ({ content: texts.map((text) => ({ type: "text", text })) });

describe("callResultRows", () => {
  // REGRESSION: this is the shape that broke the TickTick smoke test.
  // JSON.parse(callResultText(res)) throws "Unexpected non-whitespace
  // character after JSON" because the blocks are joined with "\n".
  it("reads one JSON object per text block (TickTick list_projects)", () => {
    const res = result('{"id":"1","name":"💼Work"}', '{"id":"2","name":"秦老师"}');
    expect(() => JSON.parse(callResultText(res))).toThrow(); // the old code path
    expect(callResultRows(res)).toEqual([
      { id: "1", name: "💼Work" },
      { id: "2", name: "秦老师" },
    ]);
  });

  it("splits several JSON documents inside ONE block", () => {
    const res = result('{"id":"1"}\n{"id":"2"}\n{"id":"3"}');
    expect(callResultRows(res)).toEqual([{ id: "1" }, { id: "2" }, { id: "3" }]);
  });

  it("unwraps the {result: …} envelope, list or single", () => {
    expect(callResultRows(result('{"result":[{"id":"1"},{"id":"2"}]}'))).toEqual([
      { id: "1" },
      { id: "2" },
    ]);
    expect(callResultRows(result('{"result":{"id":"9"}}'))).toEqual([{ id: "9" }]);
  });

  it("prefers structuredContent when the server provides it", () => {
    const res = { content: [{ type: "text", text: "ignored" }], structuredContent: { result: [{ id: "s" }] } };
    expect(callResultRows(res)).toEqual([{ id: "s" }]);
  });

  // A brace inside a string value must not shift the nesting depth, or the
  // document gets truncated mid-way and the parse silently loses data.
  it("is not fooled by braces or escaped quotes inside strings", () => {
    const res = result('{"title":"a { brace } and \\" quote"}{"id":"2"}');
    expect(callResultRows(res)).toEqual([
      { title: 'a { brace } and " quote' },
      { id: "2" },
    ]);
  });

  it("keeps a non-JSON block as its string rather than dropping it", () => {
    expect(callResultRows(result("rate limit exceeded"))).toEqual(["rate limit exceeded"]);
  });

  it("ignores empty blocks", () => {
    expect(callResultRows(result('{"id":"1"}', "   ", ""))).toEqual([{ id: "1" }]);
  });

  it("handles a top-level array block", () => {
    expect(callResultRows(result('[{"id":"1"},{"id":"2"}]'))).toEqual([{ id: "1" }, { id: "2" }]);
  });
});

describe("callResultObject", () => {
  it("returns the single object a create/update tool produced", () => {
    expect(callResultObject(result('{"id":"6a7c","title":"t"}'))).toEqual({ id: "6a7c", title: "t" });
  });

  it("unwraps a batch envelope", () => {
    const res = result('{"result":{"id2etag":{"a":"e"},"id2error":{}}}');
    expect(callResultObject(res)).toEqual({ id2etag: { a: "e" }, id2error: {} });
  });

  // Throwing beats returning undefined: the caller needs the id, and undefined
  // would surface much later as "created nothing" with no explanation.
  it("throws when there is no object to read", () => {
    expect(() => callResultObject(result(""))).toThrow(/no object/);
    expect(() => callResultObject(result("plain text"))).toThrow(/no object/);
  });
});
