// Executor contract. Execution I/O (MCP sends, calendar calls) lives in the skill;
// the rules about WHAT may execute and WHEN live here, tested.

import { missingInfo, type ActionItem, type ActionType } from "./action-item.js";

// These types ALWAYS need human confirmation.
//
// `calendar` LEFT this set on 2026-09-14, by the owner's decision: 「限制取消，
// 日历允许自动创建」. He had a meeting agreed in writing and still had to tick a
// row to get it onto his calendar, which is not what a secretary is for.
//
// What makes that safe is not this set — it is missingInfo's calendar case,
// which refuses any event whose time was not CONFIRMED in the thread
// (params.time_confirmed). That gate exists because the engine once booked a
// fabricated hour and the owner asked 「你哪来的20-21时间?」. Auto-creation rides
// on it: an unconfirmed time still cannot become an event, by either route.
//
// Inviting other people is a different act from filling in his own calendar, so
// an auto-created event does not email anyone (see notifyAttendees in
// proc/execute.ts). Sending an invite is still his to trigger.
export const ALWAYS_CONFIRM: ReadonlySet<ActionType> = new Set([
  "reply",
  "relay",
  "forward",
  "tool",
]);

// Auto-execute threshold for low-risk types — IGNORE ONLY. Hard-coded
// constant, no config system (V1 hard decision). Used by the auto-archive
// flush; the rule is defined and tested here so it cannot drift.
//
// 2026-07-31: narrowed from "ignore + task" to ignore-only. An ignore card
// is noise reduction (the engine judged this needs no one) — safe to
// auto-clear. A task card is somebody's request; auto-completing it marks
// work DONE that no human did (the 报销单 incident in dogfooding), which
// contradicts the product's core promise. Tasks now always wait for a human.
export const AUTO_EXECUTE_CONFIDENCE = 0.9;

export function canAutoExecute(a: ActionItem): boolean {
  if (a.status !== "suggested") return false;
  if (a.action_type !== "ignore" && a.action_type !== "calendar") return false;
  if (a.confidence < AUTO_EXECUTE_CONFIDENCE) return false;
  // For a calendar this is the whole safety story: title, start, end, and
  // time_confirmed. A guessed hour fails here and never reaches the API.
  return missingInfo(a).length === 0;
}
