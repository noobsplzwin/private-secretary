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
