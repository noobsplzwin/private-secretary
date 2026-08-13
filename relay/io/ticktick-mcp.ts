// TickTick-specific mapping on top of the generic MCP transport (mcp-tool.ts),
// the same shape as relay/io/jira-mcp.ts: resolve the destination project NAME
// to TickTick's projectId once and cache it, then wrap our payload in
// create_task's `{task: …}` envelope.
//
// Two things learned from the live API and encoded here, because both fail
// SILENTLY otherwise:
//
//   1. create_task IGNORES `status: 2`. A task cannot be created completed —
//      it comes back status 0. Completion needs a second complete_task call,
//      which stamps completedTime as NOW (the original date is unrecoverable).
//      Nothing in the engine's path needs to create a completed task, so this
//      client does not offer one rather than pretending it can.
//   2. An unresolvable project would otherwise fall through to the Inbox,
//      which looks like a success and buries the to-do. resolveTickTickProject
//      is ASK-not-GUESS, and a miss THROWS so the cockpit shows the failure.

import { callMcpTool, callResultObject, callResultRows } from "./mcp-tool.js";
import { resolveTickTickProject, type TickTickProject } from "../core/ticktick.js";
import { TICKTICK_BATCH_MAX } from "../core/mstodo.js";
import type { TickTickWriter, TickTickReader } from "../proc/ticktick-sync.js";
import type { ToolRunner } from "../proc/execute.js";

const projectIdCache = new Map<string, string>();

// list_projects returns one JSON object PER PROJECT, not a single list — see
// callResultRows, which is where that shape is normalised.
async function listProjects(url: string, authService: string): Promise<TickTickProject[]> {
  const res = await callMcpTool(url, authService, "list_projects", {});
  const rows = callResultRows(res).filter(
    (r): r is TickTickProject =>
      typeof r === "object" && r !== null && typeof (r as TickTickProject).id === "string",
  );
  if (rows.length === 0) throw new Error("ticktick: list_projects returned no lists");
  return rows;
}

async function resolveProjectId(
  url: string,
  authService: string,
  name: string,
): Promise<string> {
  const cacheKey = `${url}::${name.trim().toLowerCase()}`;
  const cached = projectIdCache.get(cacheKey);
  if (cached) return cached;

  const projects = await listProjects(url, authService);
  const resolution = resolveTickTickProject(name, projects);
  if (resolution.status === "ambiguous") {
    throw new Error(
      `ticktick: more than one list named "${name}" — rename one, the destination is ambiguous`,
    );
  }
  if (resolution.status === "not_found") {
    const known = projects.map((p) => p.name).join(", ");
    throw new Error(`ticktick: no list named "${name}" (have: ${known})`);
  }
  projectIdCache.set(cacheKey, resolution.id);
  return resolution.id;
}

export interface TickTickToolOptions {
  url: string;
  authService: string;
  // Destination list NAME from the tool config. Applied when the card carries
  // no project of its own; unset → TickTick's Inbox.
  project?: string;
}

// Build the TickTick ToolRunner. `params` is the TickTickTaskPayload from
// core/ticktick.ts — field names are already TickTick's, so the only work here
// is swapping the project NAME for its id and wrapping the envelope.
export function createTickTickToolRunner(opts: TickTickToolOptions): ToolRunner {
  return {
    run: async (params: Record<string, unknown>) => {
      const { project, ...task } = params as { project?: string } & Record<string, unknown>;
      const listName = project ?? opts.project;
      const projectId = listName
        ? await resolveProjectId(opts.url, opts.authService, listName)
        : undefined;

      const res = await callMcpTool(opts.url, opts.authService, "create_task", {
        task: { ...task, ...(projectId ? { projectId } : {}) },
      });
      const created = callResultObject(res);
      const id = typeof created.id === "string" ? created.id : "";
      if (!id) throw new Error("ticktick: create_task returned no task id");
      return { ref: `ticktick:${id}` };
    },
  };
}

// Test seam: the project-id cache is process-wide, so a test that stubs
// list_projects must be able to clear it.
export function clearTickTickProjectCache(): void {
  projectIdCache.clear();
}

// ─── the sync writer ────────────────────────────────────────────────

// The TickTickWriter relay/proc/ticktick-sync.ts drives: the real calls behind
// its create / update / complete.
//
// itemIds are returned POSITIONALLY, in the order the checklist was sent, which
// is how the sync pass pairs each executable line back to the action it
// approves. TickTick echoes `items` in the order it received them; the pass
// records the pairing and specs/ticktick-migration.md §1 explains why a wrong
// pairing matters (a ticked item pointing at nothing, or at the wrong action).
/**
 * The project's ACTIVE tasks, for the completion read-back.
 *
 * ONE call: get_project_with_undone_tasks returns every undone task with its
 * checklist items and their per-item status, which is exactly what
 * core/ticktick-readback.ts needs. Fetching each tracked task by id would be
 * ~20 round trips per poll for the same answer.
 */
export function createTickTickReader(opts: TickTickToolOptions): TickTickReader {
  return {
    async listActive(project?: string) {
      const name = project ?? opts.project;
      const projectId = name ? await resolveProjectId(opts.url, opts.authService, name) : undefined;
      if (!projectId) throw new Error("ticktick: cannot read back without a project");
      const res = await callMcpTool(opts.url, opts.authService, "get_project_with_undone_tasks", {
        project_id: projectId,
      });
      const raw = callResultObject(res).tasks;
      if (!Array.isArray(raw)) return [];
      return raw.flatMap((t) => {
        const o = t as { id?: unknown; status?: unknown; items?: unknown };
        if (typeof o.id !== "string") return [];
        const items = Array.isArray(o.items)
          ? o.items.flatMap((i) => {
              const it = i as { id?: unknown; status?: unknown };
              return typeof it.id === "string"
                ? [{ id: it.id, status: typeof it.status === "number" ? it.status : 0 }]
                : [];
            })
          : [];
        return [{ id: o.id, status: typeof o.status === "number" ? o.status : 0, items }];
      });
    },
  };
}

export function createTickTickWriter(opts: TickTickToolOptions): TickTickWriter {
  const resolve = async (project?: string): Promise<string | undefined> => {
    const name = project ?? opts.project;
    return name ? await resolveProjectId(opts.url, opts.authService, name) : undefined;
  };

  const itemIdsOf = (task: Record<string, unknown>): string[] => {
    const items = task.items;
    if (!Array.isArray(items)) return [];
    return items.map((i) => {
      const id = (i as { id?: unknown }).id;
      return typeof id === "string" ? id : "";
    });
  };

  return {
    async createTask(payload) {
      const { project, ...task } = payload as unknown as { project?: string } & Record<string, unknown>;
      const projectId = await resolve(project);
      const res = await callMcpTool(opts.url, opts.authService, "create_task", {
        task: { ...task, ...(projectId ? { projectId } : {}) },
      });
      const created = callResultObject(res);
      const id = typeof created.id === "string" ? created.id : "";
      if (!id) throw new Error("ticktick: create_task returned no task id");
      return {
        id,
        // TickTick answers with the real projectId even when we sent none (the
        // Inbox), and the sync map needs it to update/complete later.
        projectId: typeof created.projectId === "string" ? created.projectId : (projectId ?? ""),
        itemIds: itemIdsOf(created),
      };
    },

    async updateTask(taskId, projectId, payload) {
      const { project: _p, ...task } = payload as unknown as { project?: string } & Record<string, unknown>;
      const res = await callMcpTool(opts.url, opts.authService, "update_task", {
        task_id: taskId,
        // projectId is REQUIRED on update; without it TickTick cannot locate the
        // task and the change is silently lost.
        task: { ...task, id: taskId, projectId },
      });
      return { itemIds: itemIdsOf(callResultObject(res)) };
    },

    async completeTasks(tasks) {
      if (tasks.length === 0) return;
      if (tasks.length > TICKTICK_BATCH_MAX) {
        // The caller chunks; this is the backstop, because exceeding the cap
        // TRUNCATES SILENTLY (see core/mstodo.ts) — the failure that lost 803
        // tasks in the Microsoft To Do migration.
        throw new Error(
          `ticktick: ${tasks.length} completions exceeds TICKTICK_BATCH_MAX=${TICKTICK_BATCH_MAX}`,
        );
      }
      const res = await callMcpTool(opts.url, opts.authService, "batch_update_tasks", {
        tasks: tasks.map((t) => ({ id: t.id, projectId: t.projectId, status: 2 })),
      });
      const errors = Object.keys(
        (callResultObject(res) as { id2error?: Record<string, string> }).id2error ?? {},
      );
      if (errors.length > 0) {
        throw new Error(`ticktick: ${errors.length} of ${tasks.length} completions failed`);
      }
    },
  };
}
