import { describe, expect, it } from "vitest";
import { isConsumeUnreadableCard } from "./unreadable-gate.js";

describe("isConsumeUnreadableCard", () => {
  // Every one of these is a real row the owner threw away with 🚫 on 2026-09-20.
  it("catches the cards the owner actually dismissed", () => {
    for (const h of [
      "查看照亮的微信图片消息",
      "查看金小奇法律群里发的图片",
      "听Max语音，确认极智嘉拜访计划",
      "打开图片查看具体内容",
      "听取Max的语音回复内容",
      "Listen to the voice note from Max",
      "Open the screenshot he sent",
    ]) {
      expect(isConsumeUnreadableCard(h), h).toBe(true);
    }
  });

  // The narrowness is the point: a card that merely MENTIONS an image is real
  // work. Dropping these would cost the owner more than the noise does.
  it("keeps real work that happens to mention a medium", () => {
    for (const h of [
      "回复温总 FCC/HDMI 认证进度，附上测试图片",
      "把具体改法回复陈古龙",
      "Send Renesas the block diagram image they asked for",
      "Reply to Amy with the FCC report",
      "审核并确认 FCC ID 报告草稿",
    ]) {
      expect(isConsumeUnreadableCard(h), h).toBe(false);
    }
  });

  // A consumption verb with no medium is a different problem (rule 8 generally),
  // and a medium with no consumption verb is just a noun.
  it("needs BOTH the verb and the medium", () => {
    expect(isConsumeUnreadableCard("查看合同条款")).toBe(false);
    expect(isConsumeUnreadableCard("客户发来的图片")).toBe(false);
    expect(isConsumeUnreadableCard("")).toBe(false);
  });

  // Judged on the headline, which is what claims the card exists — a step may
  // legitimately say "open the file" on the way to real work.
  it("judges the headline, not a mid-sentence verb", () => {
    expect(isConsumeUnreadableCard("准备合同后打开图片核对")).toBe(false);
  });
});
