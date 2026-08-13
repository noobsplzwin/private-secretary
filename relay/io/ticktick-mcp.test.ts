import { beforeEach, describe, expect, it, vi } from "vitest";

const callMcpTool = vi.fn();

vi.mock("./mcp-tool.js", async (importOriginal) => {
  // callResultRows / callResultObject stay REAL — their shape handling (one JSON
  // object per text block) is exactly what this client depends on, so stubbing
  // them would test nothing. Only the transport is faked.
  const real = await importOriginal<typeof import("./mcp-tool.js")>();
  return { ...real, callMcpTool: (...args: unknown[]) => callMcpTool(...args) };
});

const { createTickTickWriter, clearTickTickProjectCache } = await import("./ticktick-mcp.js");
const { TICKTICK_BATCH_MAX } = await import("../core/mstodo.js");

const textResult = (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
const PROJECTS = [
  { id: "p-work", name: "💼Work" },
  { id: "p-life", name: "🏡Life" },
];

const payload = { title: "香港出差", kind: "CHECKLIST" as const, priority: 5 as const };

describe("createTickTickWriter", () => {
  beforeEach(() => {
    callMcpTool.mockReset();
    clearTickTickProjectCache();
  });

  it("resolves the destination list by NAME and creates the task there", async () => {
    callMcpTool.mockImplementation(async (_u, _a, tool) => {
      if (tool === "list_projects") return textResult({ result: PROJECTS });
      if (tool === "create_task") return textResult({ id: "tt1", projectId: "p-work", items: [] });
      throw new Error(`unexpected ${tool}`);
    });
    const w = createTickTickWriter({ url: "u", authService: "s", project: "💼Work" });
    const out = await w.createTask(payload);
    expect(out).toEqual({ id: "tt1", projectId: "p-work", itemIds: [] });
    const call = callMcpTool.mock.calls.find((c) => c[2] === "create_task")!;
    expect(call[3].task.projectId).toBe("p-work");
    expect(call[3].task.project).toBeUndefined(); // the NAME never goes to the API
  });

  // The pass pairs each executable checklist line to its action by POSITION, so
  // the ids must come back in the order the items were sent.
  it("returns checklist item ids in order", async () => {
    callMcpTool.mockImplementation(async (_u, _a, tool) => {
      if (tool === "list_projects") return textResult({ result: PROJECTS });
      if (tool === "create_task")
        return textResult({ id: "tt1", projectId: "p-work", items: [{ id: "i0" }, { id: "i1" }] });
      throw new Error(`unexpected ${tool}`);
    });
    const w = createTickTickWriter({ url: "u", authService: "s", project: "💼Work" });
    expect((await w.createTask(payload)).itemIds).toEqual(["i0", "i1"]);
  });

  // ASK-not-GUESS: a name that does not resolve must NOT fall through to the
  // Inbox, which looks like success and buries the to-do.
  it("throws when the list name does not resolve", async () => {
    callMcpTool.mockImplementation(async (_u, _a, tool) => {
      if (tool === "list_projects") return textResult({ result: PROJECTS });
      throw new Error(`unexpected ${tool}`);
    });
    const w = createTickTickWriter({ url: "u", authService: "s", project: "Typo List" });
    await expect(w.createTask(payload)).rejects.toThrow(/no list named/);
  });

  it("takes TickTick's own projectId back when none was sent (the Inbox)", async () => {
    callMcpTool.mockImplementation(async (_u, _a, tool) => {
      if (tool === "create_task") return textResult({ id: "tt1", projectId: "inbox123", items: [] });
      throw new Error(`unexpected ${tool}`);
    });
    const w = createTickTickWriter({ url: "u", authService: "s" });
    // and no list_projects call at all when there is nothing to resolve
    expect((await w.createTask(payload)).projectId).toBe("inbox123");
    expect(callMcpTool.mock.calls.some((c) => c[2] === "list_projects")).toBe(false);
  });

  it("create without an id is a failure, not a silent success", async () => {
    callMcpTool.mockImplementation(async () => textResult({ projectId: "p-work" }));
    const w = createTickTickWriter({ url: "u", authService: "s" });
    await expect(w.createTask(payload)).rejects.toThrow(/no task id/);
  });

  // projectId is REQUIRED on update; without it TickTick cannot locate the task
  // and the change is lost with no error.
  it("update sends task_id, id AND projectId", async () => {
    callMcpTool.mockImplementation(async () => textResult({ id: "tt1", items: [{ id: "i9" }] }));
    const w = createTickTickWriter({ url: "u", authService: "s" });
    const out = await w.updateTask("tt1", "p-work", payload);
    expect(out.itemIds).toEqual(["i9"]);
    const args = callMcpTool.mock.calls[0]![3];
    expect(args.task_id).toBe("tt1");
    expect(args.task.id).toBe("tt1");
    expect(args.task.projectId).toBe("p-work");
  });

  it("completes a batch with status 2", async () => {
    callMcpTool.mockImplementation(async () => textResult({ id2etag: { a: "e" }, id2error: {} }));
    const w = createTickTickWriter({ url: "u", authService: "s" });
    await w.completeTasks([{ id: "t1", projectId: "p" }, { id: "t2", projectId: "p" }]);
    const args = callMcpTool.mock.calls[0]![3];
    expect(args.tasks).toEqual([
      { id: "t1", projectId: "p", status: 2 },
      { id: "t2", projectId: "p", status: 2 },
    ]);
  });

  it("a completion error is surfaced, not swallowed", async () => {
    callMcpTool.mockImplementation(async () => textResult({ id2etag: {}, id2error: { t1: "nope" } }));
    const w = createTickTickWriter({ url: "u", authService: "s" });
    await expect(w.completeTasks([{ id: "t1", projectId: "p" }])).rejects.toThrow(/completions failed/);
  });

  it("makes no call at all for an empty completion batch", async () => {
    const w = createTickTickWriter({ url: "u", authService: "s" });
    await w.completeTasks([]);
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  // Over the cap TickTick truncates SILENTLY — the failure that lost 803 tasks
  // in the Microsoft To Do migration. The caller chunks; this is the backstop.
  it("refuses a batch over TICKTICK_BATCH_MAX instead of truncating", async () => {
    const w = createTickTickWriter({ url: "u", authService: "s" });
    const many = Array.from({ length: TICKTICK_BATCH_MAX + 1 }, (_, i) => ({ id: `t${i}`, projectId: "p" }));
    await expect(w.completeTasks(many)).rejects.toThrow(/exceeds TICKTICK_BATCH_MAX/);
    expect(callMcpTool).not.toHaveBeenCalled();
  });
});
