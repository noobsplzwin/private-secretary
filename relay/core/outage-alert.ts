// THE BRAIN IS DOWN — say so where he looks. Pure core.
//
// 2026-10-31 → 11-08 and again 11-09 → 11-13: `claude -p` lost its login, every
// draft failed, and the only trace was `[llm] OUTAGE` in a log file nobody
// reads. The inbox filled, ~1,800 messages were dropped, and he learned of it
// only by noticing TickTick had gone quiet (「ticktick好久没更新了」).
//
// So a lasting outage becomes a TickTick row, on the one list he reads. It is a
// desired row like any other: present while the outage lasts, and the sync
// completes it on its own once a draft succeeds again. No 🚫 line — there is no
// card or commitment behind it for a verdict to land on.

import { ENGINE_TAG, type TickTickTaskPayload } from "./ticktick.js";

export const OUTAGE_ALERT_KEY = "system:llm-outage";

/** A blip is not an outage: only one that has lasted this long is raised. */
export const OUTAGE_ALERT_AFTER_MS = 30 * 60_000;

/** `sourceErrors["llm:draft-outage"]`; `since` is when it began. */
export interface OutageMark {
  message: string;
  at: string;
  since?: string;
}

export function outageAlertRow(
  mark: OutageMark | undefined,
  nowMs: number,
  zone: string,
): { unitKey: string; payload: TickTickTaskPayload; executable: [] } | null {
  if (!mark) return null;
  const since = Date.parse(mark.since ?? mark.at);
  if (!(nowMs - since >= OUTAGE_ALERT_AFTER_MS)) return null;
  const day = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "numeric", day: "numeric" }).format(since);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit" }).format(since);
  return {
    unitKey: OUTAGE_ALERT_KEY,
    executable: [],
    payload: {
      // The title carries the start, not a running count — a count would
      // rewrite the task every tick.
      title: `⚠️ 秘书从 ${day} ${time} 起掉线：消息只收不分析`,
      kind: "TEXT",
      priority: 5,
      tags: [ENGINE_TAG],
      content: [
        `分析调用全部失败：${mark.message.replace(/^THE BRAIN IS DOWN — /, "")}`,
        "",
        "登录过期的修法：终端运行 claude，输入 /login。",
        "长期修法：claude setup-token，再把令牌存进钥匙串（服务名 taiv-secretary-claude-token），重启秘书。",
        "",
        "积压队列满 300 条后，溢出的消息存在 state/inbox-overflow.jsonl，不会再丢。",
        "恢复后这条会自动完成。",
      ].join("\n"),
      desc: "",
      items: [],
      timeZone: zone,
    },
  };
}
