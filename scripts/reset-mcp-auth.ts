// Reset one MCP tool's stored OAuth state so the next connect starts clean.
//
// WHEN YOU NEED THIS: you opened the browser consent and closed it without
// finishing. The dynamically-registered client is saved but no token is, and the
// server can leave that half-finished client in a state where it answers every
// /authorize with a 500 — so every retry reads the same dead client_id out of
// Keychain and fails the same way, with no path out. That is not a
// misconfiguration and no amount of retrying fixes it.
//
//   npx tsx scripts/reset-mcp-auth.ts jira
//   npx tsx scripts/reset-mcp-auth.ts ticktick
//
// Then re-run the tool's smoke script and COMPLETE the browser consent.

import { mcpAuthServiceFor, resetMcpAuth } from "../relay/io/mcp-tool.js";
import { effectiveToolSpecs } from "../relay/io/tools.js";

const [tool] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const statePath = process.argv.includes("--state")
  ? process.argv[process.argv.indexOf("--state") + 1]!
  : "state/loop-state.json";

if (!tool) {
  console.error("usage: npx tsx scripts/reset-mcp-auth.ts <tool>   (e.g. jira, ticktick)");
  process.exit(1);
}

const specs = effectiveToolSpecs(statePath);
const spec = specs[tool];
if (!spec) {
  console.error(`unknown tool "${tool}" — configured: ${Object.keys(specs).join(", ")}`);
  process.exit(1);
}
const cfg = spec.config ?? {};
if (cfg.type !== "mcp" || !cfg.url) {
  console.error(`"${tool}" is not an MCP tool (no config.url) — nothing to reset`);
  process.exit(1);
}

const authService = mcpAuthServiceFor(tool, cfg.authService);
await resetMcpAuth(cfg.url, authService);
console.log(`reset ${tool}: dropped tokens (${authService}) + client registration (${authService}-client)`);
console.log(`next connect re-registers and re-authorises — FINISH the browser consent this time.`);
