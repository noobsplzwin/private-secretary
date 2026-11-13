import { describe, it, expect } from "vitest";
import { OUTAGE_ALERT_KEY, outageAlertRow } from "./outage-alert.js";

const ZONE = "America/Toronto";
const SINCE = "2026-11-09T04:34:00.000Z"; // 11/8 23:34 in Toronto
const mark = { message: "THE BRAIN IS DOWN — claude -p exit 1: OAuth session expired", at: "2026-11-13T00:00:00.000Z", since: SINCE };

describe("outageAlertRow — a lasting LLM outage is a row on his list", () => {
  it("raises nothing without an outage, or for a blip under 30 minutes", () => {
    expect(outageAlertRow(undefined, Date.parse(SINCE) + 86_400_000, ZONE)).toBeNull();
    expect(outageAlertRow(mark, Date.parse(SINCE) + 29 * 60_000, ZONE)).toBeNull();
  });

  it("raises one high-priority row, dated from when it began, with the fix", () => {
    const row = outageAlertRow(mark, Date.parse(SINCE) + 4 * 86_400_000, ZONE)!;
    expect(row.unitKey).toBe(OUTAGE_ALERT_KEY);
    expect(row.payload.title).toBe("⚠️ 秘书从 11/8 23:34 起掉线：消息只收不分析");
    expect(row.payload.priority).toBe(5);
    expect(row.payload.content).toContain("OAuth session expired");
    expect(row.payload.content).toContain("/login");
    expect(row.payload.content).not.toContain("THE BRAIN IS DOWN");
  });

  it("does not rewrite itself every tick: the payload is stable while the outage lasts", () => {
    const a = outageAlertRow(mark, Date.parse(SINCE) + 3_600_000, ZONE);
    const b = outageAlertRow({ ...mark, at: "2026-11-14T00:00:00.000Z" }, Date.parse(SINCE) + 7_200_000, ZONE);
    expect(b).toEqual(a);
  });

  it("falls back to `at` for a mark written before `since` existed", () => {
    const old = { message: "x", at: SINCE };
    expect(outageAlertRow(old, Date.parse(SINCE) + 3_600_000, ZONE)?.payload.title).toContain("11/8 23:34");
  });
});
