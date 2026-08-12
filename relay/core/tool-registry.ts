// The task-processing MCP tools. A "tool" action carries `params.tool` = a key
// in the effective registry; the executor dispatches to that tool's runner
// (stubbed until each MCP client lands). Jira ships built-in; users ADD more
// tools in the cockpit Settings → Tools tab, which writes config/tools.json
// (relay/io/tools.ts). The EFFECTIVE registry = these defaults merged with the
// user's config overrides (mergeToolSpecs). Pure core: no I/O.

export interface ToolSpec {
  key: string;
  label: string; // display name in the cockpit picker
  requiredParams: string[]; // params a card must carry before it can approve
  config?: Record<string, string>; // per-tool settings (e.g. jira project key)
}

// Built-in defaults. A tool with no real MCP client yet still has a spec so
// the LLM can draft cards for it and the user can see it as a (stub) option.
export const DEFAULT_TOOL_SPECS: Record<string, ToolSpec> = {
  jira: {
    key: "jira",
    label: "Jira",
    requiredParams: ["project", "summary", "description"],
  },
  // TickTick is the to-do destination: `task` cards route to it through
  // ExecuteDeps.ticktick (relay/proc/execute.ts), not through the `tool`
  // action type. It lives in the registry so Settings → Tools can hold its
  // url / authService / destination list, and so an explicit `tool` card
  // naming it still works. config.project = the destination list NAME.
  ticktick: {
    key: "ticktick",
    label: "TickTick",
    requiredParams: ["title"],
  },
};

// Merge user-configured tools over the defaults. Overrides REPLACE per-key
// (so a user can tweak jira's requiredParams); unknown keys are added. Pure.
export function mergeToolSpecs(
  defaults: Record<string, ToolSpec>,
  overrides: Record<string, ToolSpec>,
): Record<string, ToolSpec> {
  const merged: Record<string, ToolSpec> = {};
  for (const [key, spec] of Object.entries(defaults)) merged[key] = spec;
  for (const [key, spec] of Object.entries(overrides)) merged[key] = { ...spec, key };
  return merged;
}

export const DEFAULT_TOOL_KEYS: readonly string[] = Object.keys(DEFAULT_TOOL_SPECS);
