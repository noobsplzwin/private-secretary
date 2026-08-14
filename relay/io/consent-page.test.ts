import { describe, expect, it } from "vitest";
import { escapeHtml, page } from "./consent-page.js";

describe("escapeHtml", () => {
  // The page interpolates a Slack team name and raw error text. Both are
  // outside our control, so neither may reach the DOM as markup.
  it("neutralises markup", () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).not.toContain("<img");
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml("it's \"quoted\"")).toBe("it&#39;s &quot;quoted&quot;");
  });
});

describe("consent page", () => {
  const ok = page({ ok: true, title: "Connected", body: "Acme is linked.", detail: "As leo." });

  it("renders a complete standalone document", () => {
    expect(ok).toMatch(/^<!doctype html>/i);
    expect(ok).toContain("<title>Connected</title>");
    expect(ok).toContain("Acme is linked.");
    expect(ok).toContain("As leo.");
  });

  // It is served by a local listener with no network access, so every style
  // must be inline — an external stylesheet would silently never load.
  it("references no external resources", () => {
    expect(ok).not.toMatch(/<link[^>]+href=/i);
    expect(ok).not.toMatch(/<script/i);
    expect(ok).not.toMatch(/https?:\/\//);
  });

  it("carries both colour schemes, since it opens in the user's browser", () => {
    expect(ok).toContain("prefers-color-scheme: dark");
  });

  it("distinguishes success from failure by more than words", () => {
    const bad = page({ ok: false, title: "Could not finish connecting", body: "Nothing stored." });
    expect(ok).toContain("--st:var(--ok)");
    expect(bad).toContain("--st:var(--err)");
  });

  it("omits the detail block when there is no detail", () => {
    expect(page({ ok: true, title: "T", body: "B" })).not.toContain("class=\"detail\"");
  });

  it("escapes interpolated values rather than trusting them", () => {
    const evil = page({ ok: true, title: "T", body: "<script>alert(1)</script>", detail: "d" });
    expect(evil).not.toContain("<script>alert(1)</script>");
    expect(evil).toContain("&lt;script&gt;");
  });
});
