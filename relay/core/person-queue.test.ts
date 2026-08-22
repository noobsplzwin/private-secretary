import { describe, expect, it } from "vitest";
import { markAssessed, personsNeedingAssessment, recordTraffic } from "./person-queue.js";

describe("personsNeedingAssessment", () => {
  it("selects a person who spoke since their last assessment", () => {
    const out = personsNeedingAssessment({ zech: 200 }, { zech: 100 }, 10);
    expect(out).toEqual([{ personaKey: "zech", trafficMs: 200 }]);
  });

  it("skips a person whose assessment already covers their traffic", () => {
    expect(personsNeedingAssessment({ zech: 100 }, { zech: 200 }, 10)).toEqual([]);
  });

  // Strictly-greater. A coarse clock would otherwise re-assess the same tick
  // forever, every tick, on a person who never speaks again.
  it("treats an equal stamp as already covered", () => {
    expect(personsNeedingAssessment({ zech: 100 }, { zech: 100 }, 10)).toEqual([]);
  });

  it("includes someone never assessed before", () => {
    expect(personsNeedingAssessment({ newperson: 5 }, {}, 10)).toEqual([
      { personaKey: "newperson", trafficMs: 5 },
    ]);
  });

  // Oldest first, so a chatty contact cannot starve a quiet one out of the cap.
  it("serves the longest-waiting person first and caps the tick", () => {
    const out = personsNeedingAssessment({ late: 300, early: 100, mid: 200 }, {}, 2);
    expect(out.map((e) => e.personaKey)).toEqual(["early", "mid"]);
  });

  it("returns nothing when the cap is zero or negative", () => {
    expect(personsNeedingAssessment({ a: 1 }, {}, 0)).toEqual([]);
    expect(personsNeedingAssessment({ a: 1 }, {}, -1)).toEqual([]);
  });

  // A quiet tick must cost nothing -- that is the whole cost argument for
  // person-first (spec §5).
  it("returns nothing when nobody has spoken", () => {
    expect(personsNeedingAssessment({}, { zech: 100 }, 10)).toEqual([]);
  });
});

describe("recordTraffic", () => {
  it("keeps the newest stamp when someone speaks twice", () => {
    const out = recordTraffic({}, [
      { personaKey: "zech", timestampMs: 100 },
      { personaKey: "zech", timestampMs: 300 },
      { personaKey: "zech", timestampMs: 200 },
    ]);
    expect(out.zech).toBe(300);
  });

  it("never moves a cursor backwards", () => {
    expect(recordTraffic({ zech: 500 }, [{ personaKey: "zech", timestampMs: 100 }]).zech).toBe(500);
  });

  it("ignores messages that resolved to nobody", () => {
    expect(recordTraffic({}, [{ personaKey: "", timestampMs: 100 }])).toEqual({});
  });

  it("does not mutate its input", () => {
    const before = { zech: 100 };
    recordTraffic(before, [{ personaKey: "zech", timestampMs: 900 }]);
    expect(before).toEqual({ zech: 100 });
  });
});

describe("markAssessed", () => {
  // The invariant that keeps a message arriving mid-pass from being lost: the
  // cursor advances to what we READ, never to "now".
  it("advances the cursor to the traffic stamp that was covered", () => {
    const out = markAssessed({}, [{ personaKey: "zech", trafficMs: 200 }]);
    expect(out.zech).toBe(200);
  });

  it("leaves later traffic pending", () => {
    const traffic = { zech: 500 };
    const queue = personsNeedingAssessment({ zech: 200 }, {}, 10); // read at 200
    const assessed = markAssessed({}, queue);
    // 500 arrived after the corpus was read, so the person is owed another pass.
    expect(personsNeedingAssessment(traffic, assessed, 10)).toEqual([
      { personaKey: "zech", trafficMs: 500 },
    ]);
  });

  it("never moves a cursor backwards", () => {
    expect(markAssessed({ zech: 500 }, [{ personaKey: "zech", trafficMs: 100 }]).zech).toBe(500);
  });
});
