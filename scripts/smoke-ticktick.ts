// Smoke test for the TickTick connection (SETUP.md §5): reads the `ticktick`
// tool config, connects, and lists the server's tools + your lists. Creates
// nothing.
//
// The FIRST run opens a browser for OAuth (TickTick supports dynamic client
// registration, so there is no app to pre-register); later runs reuse the
// Keychain token. Note that TickTick's authorisation server advertises
// `authorization_code` ONLY — with no refresh_token grant, an expired token
// cannot be renewed silently and this script is how you re-authorise.
//
//   npx tsx scripts/smoke-ticktick.ts

import { callMcpTool, callResultRows, listMcpTools, mcpAuthServiceFor } from "../relay/io/mcp-tool.js";
import { effectiveToolSpecs } from "../relay/io/tools.js";

const statePath = process.argv.includes("--state")
  ? process.argv[process.argv.indexOf("--state") + 1]!
  : "state/loop-state.json";

const spec = effectiveToolSpecs(statePath).ticktick;
const cfg = spec?.config ?? {};
if (cfg.type !== "mcp" || !cfg.url) {
  console.error("ticktick is not configured — see SETUP.md §5 (config/tools.json)");
  process.exit(1);
}
const authService = mcpAuthServiceFor("ticktick", cfg.authService);
console.log(`url          ${cfg.url}`);
console.log(`authService  ${authService}`);
console.log(`project      ${cfg.project ?? "(Inbox)"}`);

const tools = await listMcpTools(cfg.url, authService);
console.log(`\n${tools.length} tools available`);
for (const t of ["create_task", "batch_add_tasks", "batch_update_tasks", "list_projects"]) {
  console.log(`  ${tools.includes(t) ? "✓" : "✗"} ${t}`);
}

const res = await callMcpTool(cfg.url, authService, "list_projects", {});
// One JSON object per project, not a single list — callResultRows normalises it.
const projects = callResultRows(res).filter(
  (r): r is { id: string; name: string } =>
    typeof r === "object" && r !== null && typeof (r as { id?: unknown }).id === "string",
);
console.log(`\n${projects.length} lists:`);
for (const p of projects) console.log(`  ${p.name}  (${p.id})`);

// The configured destination must resolve, or every approved task card fails
// at execute time instead of here.
if (cfg.project) {
  const hit = projects.some((p) => p.name.trim().toLowerCase() === cfg.project!.trim().toLowerCase());
  console.log(`\ndestination "${cfg.project}" ${hit ? "resolves ✓" : "DOES NOT RESOLVE ✗"}`);
  if (!hit) process.exit(1);
}
