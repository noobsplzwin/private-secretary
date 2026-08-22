import { describe, expect, it } from "vitest";
import { CallGate } from "./call-gate.js";

describe("CallGate", () => {
  it("answers false the first time and true on the repeat", () => {
    const g = new CallGate();
    const sig = CallGate.signature("thread text");
    expect(g.answered("conv", sig)).toBe(false);
    g.record("conv", sig);
    expect(g.answered("conv", sig)).toBe(true);
  });

  it("keys are independent", () => {
    const g = new CallGate();
    const sig = CallGate.signature("same input");
    g.record("convA", sig);
    expect(g.answered("convB", sig)).toBe(false);
  });

  it("distinguishes inputs, including absent vs empty ordering", () => {
    expect(CallGate.signature("a", "b")).not.toBe(CallGate.signature("ab"));
    expect(CallGate.signature(undefined, "a")).not.toBe(CallGate.signature("a", undefined));
    expect(CallGate.signature(undefined)).toBe(CallGate.signature(""));
  });

  // Oscillation is real — thread readers return a sliding window.
  it("remembers more than the last signature", () => {
    const g = new CallGate();
    const [a, b] = [CallGate.signature("A"), CallGate.signature("B")];
    g.record("c", a);
    g.record("c", b);
    expect(g.answered("c", a)).toBe(true);
  });

  it("forgets past its bound rather than growing forever", () => {
    const g = new CallGate(2);
    const sigs = ["A", "B", "C"].map((x) => CallGate.signature(x));
    sigs.forEach((s) => g.record("c", s));
    expect(g.answered("c", sigs[0]!)).toBe(false); // evicted
    expect(g.answered("c", sigs[2]!)).toBe(true);
  });
});
