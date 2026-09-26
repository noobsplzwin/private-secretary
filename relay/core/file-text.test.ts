import { describe, expect, it } from "vitest";
import { fileToText, svgToText, isReadableFile, MAX_FILE_CHARS } from "./file-text.js";

describe("svgToText", () => {
  // THE REAL FILE. 股权方案.svg is 35KB of mostly path data; its <text> nodes
  // are the entire plan, and they are what the owner meant by "read the svg".
  it("keeps the labels and drops the drawing", () => {
    const xml = `<svg><path d="M0 0 L100 100"/><text x="1" y="2">股权方案</text>
      <g><text class="t"><tspan>老出资回收</tspan> → <tspan>工商变更</tspan></text></g>
      <rect/><text>  </text><text>作价 60万</text></svg>`;
    expect(svgToText(xml)).toBe("股权方案\n老出资回收 → 工商变更\n作价 60万");
  });

  it("unescapes entities, so 张三 &amp; 李四 reads as one name pair", () => {
    expect(svgToText("<text>A &amp; B &lt;C&gt;</text>")).toBe("A & B <C>");
  });
});

describe("fileToText", () => {
  it("reads the text-shaped formats", () => {
    expect(fileToText("notes.md", "# hi")!.text).toBe("# hi");
    expect(fileToText("config.c", "int main(){}")!.text).toBe("int main(){}");
    expect(fileToText("plan.svg", "<text>一步</text>")!.text).toBe("一步");
  });

  // Everything else stays on the declared-unreadable path, which is honest and
  // already wired — better than a half-parsed PDF.
  it("refuses binary formats rather than guessing", () => {
    for (const n of ["FCC ID草稿.zip", "报告.pdf", "合同.docx", "表.xlsx", "invite.ics"]) {
      expect(fileToText(n, "anything"), n).toBeNull();
    }
  });

  it("refuses a file with no usable text", () => {
    expect(fileToText("empty.txt", "   \n  ")).toBeNull();
    // A binary blob renamed .txt decodes to replacement characters; feeding
    // that to the model is worse than saying nothing.
    expect(fileToText("fake.txt", "�".repeat(50) + "abc")).toBeNull();
  });

  // Truncation is announced in the text itself: a silently cut document is a
  // document the model will reason about as if it were complete.
  it("truncates out loud", () => {
    const r = fileToText("big.txt", "x".repeat(MAX_FILE_CHARS + 500))!;
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("已截断");
    expect(r.text.length).toBeLessThan(MAX_FILE_CHARS + 60);
  });

  it("isReadableFile is case-insensitive on the extension", () => {
    expect(isReadableFile("PLAN.SVG")).toBe(true);
    expect(isReadableFile("noextension")).toBe(false);
  });
});
