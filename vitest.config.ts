import { defineConfig } from "vitest/config";

// Keep vitest scoped to this working tree's source. .claude/worktrees/* are
// git worktrees on parallel branches — their tests live in their own checkout
// and shouldn't run here.
export default defineConfig({
  test: {
    include: ["relay/**/*.test.ts"],
    exclude: ["node_modules/**", ".claude/worktrees/**"],
  },
});
