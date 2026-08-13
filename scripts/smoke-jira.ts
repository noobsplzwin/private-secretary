// Smoke test for the Jira connection (SETUP.md §6): reads the `jira` tool
// config, connects, lists the server's tools and the projects you may create
// in. Creates NOTHING.
//
// The FIRST run opens a browser for OAuth. Atlassian's MCP server supports
// dynamic client registration and PKCE S256, so there is no app to pre-register
// — relay/io/mcp-tool.ts handles the whole flow. It also grants a refresh_token
// (unlike TickTick), so the daemon keeps working past token expiry.
//
//   npx tsx scripts/smoke-jira.ts
//
// Until this passes, an approved `tool` card runs through the STUB runner: it
// logs JIRA-STUB-… and creates no ticket.

import { callMcpTool, callResultText, listMcpTools, mcpAuthServiceFor } from "../relay/io/mcp-tool.js";
import { effectiveToolSpecs } from "../relay/io/tools.js";

const statePath = process.argv.includes("--state")
  ? process.argv[process.argv.indexOf("--state") + 1]!
  : "state/loop-state.json";

const cfg = effectiveToolSpecs(statePath).jira?.config ?? {};
if (cfg.type !== "mcp" || !cfg.url) {
  console.error("jira is not configured — see SETUP.md §6 (config/tools.json)");
  process.exit(1);
}
const authService = mcpAuthServiceFor("jira", cfg.authService);
console.log(`url          ${cfg.url}`);
console.log(`authService  ${authService}`);

const tools = await listMcpTools(cfg.url, authService);
console.log(`\n${tools.length} tools available`);
for (const t of ["getAccessibleAtlassianResources", "createJiraIssue", "lookupJiraAccountId"]) {
  console.log(`  ${tools.includes(t) ? "✓" : "✗"} ${t}`);
}

// The runner resolves cloudId itself and REFUSES to guess when a token can see
// more than one site (relay/io/jira-mcp.ts), so surface that here rather than
// at approve time.
const sites = JSON.parse(
  callResultText(await callMcpTool(cfg.url, authService, "getAccessibleAtlassianResources", {})),
) as Array<{ id: string; name?: string; url?: string }>;
console.log(`\n${sites.length} Atlassian site(s):`);
for (const s of sites) console.log(`  ${s.name ?? "?"}  ${s.url ?? ""}  (${s.id})`);
if (sites.length !== 1) {
  console.error(
    sites.length === 0
      ? "\nno accessible site — the runner will throw at approve time"
      : "\nMORE THAN ONE site: cloudId is ambiguous and the runner refuses to guess. Connect a single-site account.",
  );
  process.exit(1);
}

const projects = JSON.parse(
  callResultText(
    await callMcpTool(cfg.url, authService, "getVisibleJiraProjects", {
      cloudId: sites[0]!.id,
      action: "create",
      expandIssueTypes: false,
    }),
  ),
) as { values?: Array<{ key: string; name: string; projectTypeKey?: string }> };
console.log(`\nprojects you may CREATE in (params.project takes one of these keys):`);
for (const p of projects.values ?? []) {
  console.log(`  ${p.key.padEnd(6)} ${p.name}  [${p.projectTypeKey}]`);
}
