// @vitest-environment jsdom
// QueueScreen against a stubbed /api/state: tier grouping + task cards +
// detail selection, j/k keyboard movement, the typed-skip flow (reason click
// completes the skip with its existence key), the edit-then-approve POST
// order (the load-bearing legacy doAction sequence), and the history drawer
// with restore. Drag-to-re-tier is NOT covered — jsdom's drag support is
// too poor; it is verified manually in the browser.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../lib/api", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

import { apiGet, apiPost } from "../lib/api";
import QueueScreen from "./QueueScreen";

const mockApiGet = vi.mocked(apiGet);
const mockApiPost = vi.mocked(apiPost);

// ─── fixtures ────────────────────────────────────────────────────────

function makeAction(over: Record<string, unknown> = {}) {
  return {
    id: "a1",
    action_type: "reply",
    status: "suggested",
    headline: "Reply to Bob",
    reason: "Bob asked a question",
    summary: "Bob wants the numbers by Friday.",
    draft: "Hi Bob, sending them tomorrow.",
    target: { platform: "slack", personaKey: "bob" },
    context: { original_message: "can I get the numbers?", sender_handle: "bob", sent_at: "2026-07-30T10:00:00.000Z" },
    sender_name: "Bob",
    recipient_name: "Bob",
    missing_info: [],
    params: {},
    created_at: "2026-07-30T10:00:00.000Z",
    ...over,
  };
}

// Two tasks: t1 (tier A, a slack reply with a draft) and t2 (tier B, a
// Me-reminder task). Plus one done + one skipped row for the drawer.
function makeState() {
  return {
    clusters: [
      {
        task_id: "t1",
        unit_key: "t1",
        title: "Numbers for Bob",
        actions: [makeAction()],
        plan: { tier: "A", rank: 0, why: "Bob is blocked" },
        done: 0,
        total: 1,
      },
      {
        task_id: "t2",
        unit_key: "t2",
        title: "Water the plants",
        actions: [
          makeAction({
            id: "a2",
            action_type: "task",
            headline: "Water the plants",
            draft: null,
            summary: "",
            created_at: "2026-07-29T09:00:00.000Z",
          }),
        ],
        plan: { tier: "B", rank: 1, why: "" },
        done: 0,
        total: 1,
      },
    ],
    suggested: [],
    awaitingManual: [],
    done: [
      makeAction({
        id: "d1",
        action_type: "task",
        status: "executed",
        headline: "Old auto task",
        draft: null,
        params: { execution_receipt: { kind: "local", at: "2026-07-28T08:00:00.000Z" } },
      }),
    ],
    skipped: [makeAction({ id: "k1", status: "rejected", headline: "Skipped thing", draft: null })],
    sourceErrors: {},
    gate: {},
    counts: { pending: 2, tasks: 2, awaitingManual: 0 },
  };
}

function renderQueue() {
  return render(
    <MemoryRouter>
      <QueueScreen />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockApiGet.mockResolvedValue(makeState());
  mockApiPost.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  mockApiGet.mockReset();
  mockApiPost.mockReset();
});

describe("QueueScreen", () => {
  it("(a) renders tier sections, task cards, and the detail of the first task; clicking a card selects its task", async () => {
    const { container } = renderQueue();

    // Tier sections (all four render, even empty, as drop targets).
    await screen.findByText("A · Do first");
    for (const label of ["B · Today", "C · This week", "D · Later"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }

    // Task cards in the master list.
    expect(container.querySelectorAll(".task-card")).toHaveLength(2);

    // Detail falls back to the first live cluster.
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Numbers for Bob"));
    expect(screen.getByText("Resolution Plan")).toBeTruthy();
    // "why" shows on both the master-list card and the detail header.
    expect(screen.getAllByText("Bob is blocked").length).toBeGreaterThan(0);

    // Click the second card → its task shows in the detail pane.
    fireEvent.click(container.querySelector('.task-card[data-task="t2"]')!);
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Water the plants"));
  });

  it("(b) j/k move the selection across tasks at the task level", async () => {
    renderQueue();
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Numbers for Bob"));

    fireEvent.keyDown(document, { key: "j" }); // no selection → first task
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Numbers for Bob"));
    fireEvent.keyDown(document, { key: "j" }); // → second task
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Water the plants"));
    fireEvent.keyDown(document, { key: "j" }); // clamped at the end
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Water the plants"));
    fireEvent.keyDown(document, { key: "k" }); // back up
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Numbers for Bob"));
  });

  it("(c) skip opens the reason panel; one reason click POSTs skip with the existence key", async () => {
    renderQueue();
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Numbers for Bob"));

    // Footer Skip targets the task's skipTarget (a1). The sub-action row has
    // its own per-row Skip; the footer's is the LAST "Skip" button in the DOM.
    const skipButtons = screen.getAllByRole("button", { name: "Skip" });
    fireEvent.click(skipButtons[skipButtons.length - 1]!);
    expect(await screen.findByText(/Why are you skipping/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Not a thing" }));
    await waitFor(() => {
      const skipCall = mockApiPost.mock.calls.find(([p]) => p === "/api/actions/a1/skip");
      expect(skipCall).toBeTruthy();
      expect(skipCall![1]).toEqual({ existence: "not_a_thing", field_errors: [] });
    });
  });

  // REGRESSION: the only free-text field used to live in the skip panel, so
  // leaving feedback rejected the card — and revising a note meant restore →
  // re-skip. Commenting must be its own action.
  it("(h) Comment posts feedback WITHOUT skipping the card", async () => {
    renderQueue();
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Numbers for Bob"));
    const commentButtons = screen.getAllByRole("button", { name: "Comment" });
    fireEvent.click(commentButtons[commentButtons.length - 1]!);
    expect(await screen.findByTestId("comment-panel")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/What is wrong, or right/i), {
      target: { value: "  good card, wrong date  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    await waitFor(() => {
      const call = mockApiPost.mock.calls.find(([p]) => p === "/api/actions/a1/comment");
      expect(call![1]).toEqual({ text: "good card, wrong date" });
    });
    // and nothing was skipped
    expect(mockApiPost.mock.calls.find(([p]) => p === "/api/actions/a1/skip")).toBeUndefined();
  });
  it("(i) Add comment stays disabled until something is typed", async () => {
    renderQueue();
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Numbers for Bob"));
    const commentButtons = screen.getAllByRole("button", { name: "Comment" });
    fireEvent.click(commentButtons[commentButtons.length - 1]!);
    const submit = await screen.findByRole("button", { name: "Add comment" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/What is wrong, or right/i), { target: { value: "x" } });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it("(e) a typed note rides along with the reason button that is clicked", async () => {
    renderQueue();
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Numbers for Bob"));
    const skipButtons = screen.getAllByRole("button", { name: "Skip" });
    fireEvent.click(skipButtons[skipButtons.length - 1]!);
    const input = await screen.findByPlaceholderText(/In your own words/i);

    fireEvent.change(input, { target: { value: "  he answered this by phone yesterday  " } });
    fireEvent.click(screen.getByRole("button", { name: "Already handled" }));

    await waitFor(() => {
      const skipCall = mockApiPost.mock.calls.find(([p]) => p === "/api/actions/a1/skip");
      expect(skipCall![1]).toEqual({
        existence: "already_handled",
        field_errors: [],
        note: "he answered this by phone yesterday", // trimmed
      });
    });
  });

  // The one-click path must send exactly what it always did — an optional field
  // that quietly changes every request would be a regression in itself.
  it("(f) sends no note key at all when nothing was typed", async () => {
    renderQueue();
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Numbers for Bob"));
    const skipButtons = screen.getAllByRole("button", { name: "Skip" });
    fireEvent.click(skipButtons[skipButtons.length - 1]!);
    expect(await screen.findByText(/Why are you skipping/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Not a thing" }));

    await waitFor(() => {
      const skipCall = mockApiPost.mock.calls.find(([p]) => p === "/api/actions/a1/skip");
      expect(Object.keys(skipCall![1] as object)).not.toContain("note");
    });
  });

  // Enter is the "none of the six fit" path: prose survives instead of being
  // lost because no button matched it.
  it("(g) Enter files a prose-only reason as Other, carrying the text", async () => {
    renderQueue();
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Numbers for Bob"));
    const skipButtons = screen.getAllByRole("button", { name: "Skip" });
    fireEvent.click(skipButtons[skipButtons.length - 1]!);
    const input = await screen.findByPlaceholderText(/In your own words/i);

    fireEvent.change(input, { target: { value: "this one is really for Zack" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      const skipCall = mockApiPost.mock.calls.find(([p]) => p === "/api/actions/a1/skip");
      expect(skipCall![1]).toEqual({
        existence: "other",
        field_errors: [],
        note: "this one is really for Zack",
      });
    });
  });

  it("(d) approving while editing POSTs the draft edit BEFORE the approve", async () => {

    renderQueue();
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Numbers for Bob"));

    // Drill into the single-card editor via the footer's Edit (the row has
    // its own Edit too; the footer's is the last one in the DOM).
    const editButtons = screen.getAllByRole("button", { name: "Edit" });
    fireEvent.click(editButtons[editButtons.length - 1]!);
    const ta = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "Edited draft text" } });

    fireEvent.click(screen.getByRole("button", { name: /Approve & Send/ }));
    await waitFor(() => {
      const paths = mockApiPost.mock.calls.map(([p]) => p);
      const editIdx = paths.indexOf("/api/actions/a1/edit");
      const approveIdx = paths.indexOf("/api/actions/a1/approve");
      expect(editIdx).toBeGreaterThanOrEqual(0);
      expect(approveIdx).toBeGreaterThan(editIdx);
    });
    expect(mockApiPost.mock.calls.find(([p]) => p === "/api/actions/a1/edit")![1]).toEqual({
      draft: "Edited draft text",
    });
  });

  it("(e-ungrouped) clicking one same-conversation ungrouped card highlights ONLY it (regression: shared unit_key)", async () => {
    // Three cards drafted from the SAME sender+channel in one batch, each its
    // own ungrouped cluster. The backend assigns DISTINCT unit_keys
    // (__ungrouped_<actionId>); before the fix all three shared the
    // conversation key, so clicking one highlighted all three.
    const clusters = ["u1", "u2", "u3"].map((id) => ({
      task_id: null,
      unit_key: `__ungrouped_${id}`,
      title: `Card ${id}`,
      actions: [makeAction({ id, headline: `Card ${id}`, sender_name: "Bob" })],
      plan: { tier: "C", rank: 9, why: "" },
      done: 0,
      total: 1,
    }));
    mockApiGet.mockResolvedValue({ ...makeState(), clusters, suggested: [] });
    const { container } = renderQueue();
    await waitFor(() => expect(container.querySelectorAll(".task-card")).toHaveLength(3));

    expect(container.querySelectorAll(".task-card.bg-primary\\/10")).toHaveLength(0);
    fireEvent.click(container.querySelector('.task-card[data-task="__ungrouped_u2"]')!);
    const selected = container.querySelectorAll(".task-card.bg-primary\\/10");
    expect(selected).toHaveLength(1);
    expect(selected[0]!.getAttribute("data-task")).toBe("__ungrouped_u2");
    // detail follows the clicked card
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Card u2"));
  });

  it("(e) the drawer lists done + skipped rows and Restore POSTs restore", async () => {
    renderQueue();
    await screen.findByText("A · Do first");

    expect(screen.getByText(/Completed \(1\) · Skipped \(1\)/)).toBeTruthy();
    expect(screen.getByText("Old auto task")).toBeTruthy();
    expect(screen.getByText("Skipped thing")).toBeTruthy();

    const restoreButtons = screen.getAllByRole("button", { name: "Restore" });
    expect(restoreButtons).toHaveLength(2);
    fireEvent.click(restoreButtons[0]!);
    await waitFor(() => {
      expect(mockApiPost.mock.calls.some(([p]) => p === "/api/actions/d1/restore")).toBe(true);
    });
  });

  it("(f-cal) a calendar card shows its proposed time on the master-list + detail, and the conflict badge", async () => {
    const calCluster = {
      task_id: "cal1",
      unit_key: "cal1",
      title: "Q3预算评审会",
      actions: [
        makeAction({
          id: "cal1",
          action_type: "calendar",
          headline: "Q3预算评审会",
          draft: null,
          summary: "",
          target: { platform: "calendar", personaKey: null },
          params: {
            title: "Q3预算评审（望京SOHO T3）",
            start: "2026-08-05T15:00:00+08:00",
            end: "2026-08-05T16:00:00+08:00",
            location: "望京SOHO T3",
          },
        }),
      ],
      plan: { tier: "A", rank: 0, why: "" },
      done: 0,
      total: 1,
    };
    mockApiGet.mockImplementation((path: string) => {
      if (path.startsWith("/api/actions/cal1/calendar-conflicts")) {
        return Promise.resolve({ conflicts: [{ event: { summary: "Existing standup" } }] });
      }
      return Promise.resolve({ ...makeState(), clusters: [calCluster], suggested: [] });
    });
    const { container } = renderQueue();
    await waitFor(() => expect(container.querySelectorAll(".task-card")).toHaveLength(1));

    // The time line is timezone-robust: build the expected local rendering the
    // same way the component does, then assert it appears on card + detail.
    const s = new Date("2026-08-05T15:00:00+08:00");
    const pad = (n: number) => String(n).padStart(2, "0");
    const expectedTime = `${s.getMonth() + 1}/${s.getDate()} ${pad(s.getHours())}:${pad(s.getMinutes())}`;
    expect(screen.getAllByText(new RegExp(expectedTime)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/望京SOHO T3/).length).toBeGreaterThan(0);

    // The selected calendar card's conflict pre-check resolves → badge shows.
    await screen.findByText(/Conflicts: Existing standup/);
    expect(screen.queryByText("No conflict")).toBeNull();
  });

  it("(f-done) mark-done circle is a cursor-pointer button; non-task circles are muted glyphs", async () => {
    const { container } = renderQueue();
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Numbers for Bob"));

    // t2 is a Me·reminder task → its row circle is the clickable "Mark done" button.
    fireEvent.click(container.querySelector('.task-card[data-task="t2"]')!);
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Water the plants"));
    const doneBtn = screen.getByTitle("Mark done");
    expect(doneBtn.className).toContain("cursor-pointer");

    // t1 is a suggested slack reply → NOT done-able: no Mark-done button, the
    // circle is a muted glyph (opacity), so a click does nothing meaningful.
    fireEvent.click(container.querySelector('.task-card[data-task="t1"]')!);
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Numbers for Bob"));
    expect(screen.queryByTitle("Mark done")).toBeNull();
    // A suggested reply row shows a muted REPLY icon, not a circle/button.
    const muted = container.querySelector("span.opacity-40 svg.lucide-reply");
    expect(muted).toBeTruthy();
  });

  it("(f-retime) the calendar card's 改时间 editor POSTs the instruction to re-time", async () => {
    const calCluster = {
      task_id: "cal1",
      unit_key: "cal1",
      title: "Q3预算评审会",
      actions: [
        makeAction({
          id: "cal1",
          action_type: "calendar",
          headline: "Q3预算评审会",
          draft: null,
          summary: "",
          target: { platform: "calendar", personaKey: null },
          params: {
            title: "Q3预算评审（望京SOHO T3）",
            start: "2026-08-05T15:00:00+08:00",
            end: "2026-08-05T16:00:00+08:00",
            location: "望京SOHO T3",
          },
        }),
      ],
      plan: { tier: "A", rank: 0, why: "" },
      done: 0,
      total: 1,
    };
    mockApiGet.mockResolvedValue({ ...makeState(), clusters: [calCluster], suggested: [] });
    mockApiPost.mockResolvedValue({ ok: true });
    const { container } = renderQueue();
    await waitFor(() => expect(container.querySelectorAll(".task-card")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Re-time" }));
    const input = screen.getByLabelText("re-time instruction") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "extend by 30 min" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      const call = mockApiPost.mock.calls.find(([p]) => p === "/api/actions/cal1/re-time");
      expect(call).toBeTruthy();
      expect(call![1]).toEqual({ instruction: "extend by 30 min" });
    });
  });

  it("(f-tool) a tool card shows its tool/project/assignee line, a picker, and a Create ticket button", async () => {
    const toolCluster = {
      task_id: "j1",
      unit_key: "j1",
      title: "Homepage breaks on iOS",
      actions: [
        makeAction({
          id: "j1",
          action_type: "tool",
          headline: "Homepage breaks on iOS",
          draft: null,
          summary: "",
          target: { platform: "jira", personaKey: null },
          params: {
            tool: "jira",
            project: "BKO",
            summary: "Homepage breaks on iOS",
            description: "Repro in the 2.4 build",
            assignee: "leo",
          },
        }),
      ],
      plan: { tier: "B", rank: 1, why: "" },
      done: 0,
      total: 1,
    };
    mockApiGet.mockResolvedValue({ ...makeState(), clusters: [toolCluster], suggested: [] });
    const { container } = renderQueue();
    await waitFor(() => expect(container.querySelectorAll(".task-card")).toHaveLength(1));

    expect(screen.getByText(/jira · BKO · → leo/)).toBeTruthy();
    // the processing-tool picker is present and defaults to the card's tool
    expect((screen.getByLabelText("processing tool") as HTMLSelectElement).value).toBe("jira");
    expect(screen.getAllByRole("button", { name: /Create ticket/ }).length).toBeGreaterThan(0);
  });
});

describe("Show original", () => {
  function stateWithContext(context: Record<string, unknown>) {
    const st = makeState();
    st.clusters[0]!.actions = [makeAction({ context })];
    return st;
  }

  it("names the speaker and stamps the time instead of printing a raw user id", async () => {
    const at = Date.UTC(2026, 7, 9, 14, 5);
    mockApiGet.mockResolvedValue(
      stateWithContext({
        original_message: "U07VD53V7M3: Thursday 3pm",
        original_transcript: [{ speaker: "Sandro Pinto", self: false, at, text: "Thursday 3pm" }],
      }),
    );
    renderQueue();

    // Both Show-original blocks live in the DOM (collapsed != unrendered), so
    // scope to the one under test.
    const d = (await screen.findAllByText("Show original"))[0]!.closest("details")!;
    fireEvent.click(screen.getAllByText("Show original")[0]!);
    expect(within(d).getByText("Sandro Pinto")).toBeTruthy();
    expect(within(d).getByText("Thursday 3pm")).toBeTruthy();
    expect(d.querySelector("time")?.getAttribute("datetime")).toBe(new Date(at).toISOString());
    // The raw line must not be dumped alongside it.
    // Both "Show original" blocks (summary and per-action) use the structured
    // form, so the raw id never reaches the screen.
    expect(screen.queryByText(/U07VD53V7M3/)).toBeNull();
  });

  // Slack's grouping rule. Without it a burst of one-line messages reads as
  // that many separate speakers, which is what the old plain-text view did.
  it("collapses the header for consecutive messages from one speaker", async () => {
    const t0 = Date.UTC(2026, 7, 9, 14, 0);
    mockApiGet.mockResolvedValue(
      stateWithContext({
        original_transcript: [
          { speaker: "Leo", self: true, at: t0, text: "one" },
          { speaker: "Leo", self: true, at: t0 + 30_000, text: "two" },
          { speaker: "Sandro", self: false, at: t0 + 60_000, text: "three" },
        ],
      }),
    );
    renderQueue();

    const d = (await screen.findAllByText("Show original"))[0]!.closest("details")!;
    fireEvent.click(screen.getAllByText("Show original")[0]!);
    expect(within(d).getAllByText("Leo")).toHaveLength(1);
    expect(within(d).getByText("two")).toBeTruthy();
    expect(within(d).getAllByText("Sandro")).toHaveLength(1);
  });

  // Cards written before the reader carried structure keep working.
  it("falls back to the raw text when there is no transcript", async () => {
    mockApiGet.mockResolvedValue(stateWithContext({ original_message: "me: hi\nU07: yo" }));
    renderQueue();

    fireEvent.click((await screen.findAllByText("Show original"))[0]!);
    expect(screen.getAllByText(/U07: yo/).length).toBeGreaterThan(0);
  });
});
