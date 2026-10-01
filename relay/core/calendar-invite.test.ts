import { describe, expect, it } from "vitest";
import { applyInvite, cardForInvite, parseInvite } from "./calendar-invite.js";
import type { ActionItem } from "./action-item.js";

// Shaped like the real invite João sent on 2026-10-01 (Google Calendar).
const ICS = [
  "BEGIN:VCALENDAR",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "DTSTART:20261001T130000Z",
  "DTEND:20261001T140000Z",
  "ORGANIZER;CN=João Peixoto:mailto:jpeixoto@osyx.tech",
  "UID:abc123@google.com",
  "SUMMARY:NXP AGV Sync",
  "ATTENDEE;CN=Leo Zheng:mailto:leo@osyx.tech",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("parseInvite", () => {
  it("reads organizer, instants, method, uid and summary", () => {
    expect(parseInvite(ICS)).toEqual({
      method: "REQUEST",
      organizer: "jpeixoto@osyx.tech",
      start: "2026-10-01T13:00:00.000Z",
      end: "2026-10-01T14:00:00.000Z",
      uid: "abc123@google.com",
      summary: "NXP AGV Sync",
    });
  });

  it("converts a TZID wall time to its instant", () => {
    const ics = ICS.replace("DTSTART:20261001T130000Z", "DTSTART;TZID=Asia/Shanghai:20261001T210000");
    expect(parseInvite(ics)!.start).toBe("2026-10-01T13:00:00.000Z");
  });

  it("unfolds folded lines (RFC 5545)", () => {
    const ics = ICS.replace("ORGANIZER;CN=João Peixoto:mailto:jpeixoto@osyx.tech", "ORGANIZER;CN=João Peixoto:mailto:jpeixoto@os\r\n yx.tech");
    expect(parseInvite(ics)!.organizer).toBe("jpeixoto@osyx.tech");
  });

  it("refuses a floating time — no zone, no instant", () => {
    expect(parseInvite(ICS.replace("DTSTART:20261001T130000Z", "DTSTART:20261001T130000"))).toBeNull();
  });
});

const card = (over: Partial<ActionItem> & { params?: Record<string, unknown> } = {}): ActionItem =>
  ({
    id: "c1", source_message_id: "slack:D1:1", action_type: "calendar", status: "suggested",
    headline: "Call with João on RTOS motion-loop scope", reason: "", confidence: 1,
    created_at: "2026-10-01T06:26:00Z",
    params: { start: "2026-10-01T08:00:00.000Z", end: "2026-10-01T08:30:00.000Z", attendees: ["jpeixoto@osyx.tech"] },
    ...over,
  }) as ActionItem;

describe("cardForInvite — identity, never text", () => {
  const inv = parseInvite(ICS)!;

  it("finds the one open card that has the organizer as an attendee", () => {
    expect(cardForInvite([card()], inv)?.id).toBe("c1");
  });

  it("matches on the email even when the titles share nothing", () => {
    // "Call with João on RTOS motion-loop scope" vs "NXP AGV Sync" — the 10/1 case.
    expect(cardForInvite([card()], inv)).not.toBeNull();
  });

  it("touches nothing when two cards could be it", () => {
    expect(cardForInvite([card(), card({ id: "c2" })], inv)).toBeNull();
  });

  it("ignores a card whose attendees do not include the organizer", () => {
    expect(cardForInvite([card({ params: { start: "2026-10-01T08:00:00.000Z", attendees: ["someone@else.com"] } })], inv)).toBeNull();
  });

  it("ignores a meeting more than a week away, a closed card, and a CANCEL", () => {
    expect(cardForInvite([card({ params: { start: "2026-10-20T08:00:00.000Z", attendees: ["jpeixoto@osyx.tech"] } })], inv)).toBeNull();
    expect(cardForInvite([card({ status: "executed" })], inv)).toBeNull();
    expect(cardForInvite([card()], { ...inv, method: "CANCEL" })).toBeNull();
  });

  it("an already-settled card still takes a RESCHEDULE from the same organizer", () => {
    const settled = applyInvite(card(), inv);
    const moved = { ...inv, start: "2026-10-02T13:00:00.000Z", end: "2026-10-02T14:00:00.000Z" };
    expect(cardForInvite([settled], moved)?.id).toBe("c1");
  });
});

describe("applyInvite", () => {
  it("takes the invite's time and drops its own invite line", () => {
    const out = applyInvite(card(), parseInvite(ICS)!);
    expect(out.params).toMatchObject({
      start: "2026-10-01T13:00:00.000Z",
      end: "2026-10-01T14:00:00.000Z",
      attendees: [],
      invite_received_from: "jpeixoto@osyx.tech",
      rescheduled_from: "2026-10-01T08:00:00.000Z",
    });
    expect(out.headline).toBe("Call with João on RTOS motion-loop scope"); // the row keeps its key
  });
});
