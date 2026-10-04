import { describe, expect, it } from "vitest";
import { closeDoneCards } from "./card-closure.js";

// 2026-10-03: he sent 李冰 the demo video; the card stayed open.
const card = (id: string, title: string, status = "suggested") =>
  ({ id, action_type: "task", status, headline: title, params: { title }, context: { sender_handle: "李冰Bezos", original_message: "弄好了之后，给我的老板看看" } }) as never;
const batch = [
  { id: "m1", platform: "wechat", senderHandle: "李冰Bezos", timestampMs: 1, text: "这个黑色logo是android的吗", threadContext: "我: 搞好了你敢信\n我: 录了个视频\n我: 能不能约领导" } as never,
];

describe("closeDoneCards", () => {
  it("closes the sender's card his own line shows done", async () => {
    const r = await closeDoneCards([card("c1", "发demo视频给李冰"), card("c2", "约高通时间")], batch, new Set(), async () => ({
      closed: [{ item: "R1", evidence: "录了个视频" }],
    }));
    expect(r).toEqual([{ id: "c1", evidence: "录了个视频" }]);
  });
  it("leaves cards alone for a sender whose draft failed, or with no open cards", async () => {
    let asked = 0;
    const json = async () => ((asked += 1), { closed: [{ item: "R1", evidence: "录了个视频" }] });
    expect(await closeDoneCards([card("c1", "发demo视频给李冰")], batch, new Set(["李冰Bezos"]), json)).toEqual([]);
    expect(await closeDoneCards([card("c1", "x", "executed")], batch, new Set(), json)).toEqual([]);
    expect(asked).toBe(0);
  });
});
