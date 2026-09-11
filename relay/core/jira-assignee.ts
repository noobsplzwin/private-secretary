// Pure decision: which Jira account (if any) a free-text assignee query
// resolves to. Mirrors recipient-resolver.ts's ASK-not-GUESS rule — resolve
// ONLY on an exact, unambiguous match against real (human) accounts;
// anything else is unresolved and the caller must not guess.

export interface JiraAccountCandidate {
  accountId: string;
  displayName: string;
  accountType: string; // "atlassian" = human; "app" = bot/integration
}

export type JiraAssigneeResolution =
  | { status: "resolved"; accountId: string }
  | { status: "unresolved"; reason: "no-match" | "ambiguous" };

function norm(s: string): string {
  return s.trim().toLowerCase();
}

export function resolveJiraAssignee(
  query: string,
  candidates: JiraAccountCandidate[],
): JiraAssigneeResolution {
  const q = norm(query);
  const humans = candidates.filter((c) => c.accountType === "atlassian");
  const matched = humans.filter((c) => norm(c.displayName) === q);
  if (matched.length === 1) return { status: "resolved", accountId: matched[0]!.accountId };
  return { status: "unresolved", reason: matched.length === 0 ? "no-match" : "ambiguous" };
}

/**
 * Turn a persona KEY into the display name Jira actually matches on.
 *
 * The drafter wrote `ihor-kachura` on 2026-09-11. That is the persona key,
 * which is the identifier it sees all over its own context, and it is exactly
 * what resolveJiraAssignee below cannot resolve: Jira matches human accounts by
 * display name, so the ticket would have gone out unassigned with no error.
 *
 * This is a LOOKUP, not a guess. Only an exact key match converts; a name the
 * roster does not hold passes through untouched, so ASK-not-GUESS still decides
 * whether it resolves. Nothing here does fuzzy matching on people — that is the
 * Echo mis-binding, and it stays forbidden.
 */
export function displayNameForKey(
  query: string,
  personas: ReadonlyArray<{ key: string; displayName: string }>,
): string {
  const q = query.trim();
  if (q === "") return q;
  const k = q.toLowerCase();
  return personas.find((p) => p.key.toLowerCase() === k)?.displayName ?? q;
}
