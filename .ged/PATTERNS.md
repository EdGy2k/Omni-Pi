# Patterns

## Workflow implementation

- Keep governance types and transitions in one pure domain module; adapters and
  prompts consume that contract rather than redeclaring it.
- Bind approval and verification to canonical content digests and explicit work
  IDs, repository/worktree identity, and state revision.
- Treat subagent results as evidence; the coordinator adjudicates outcomes.
- Keep one writer per worktree. Parallelize read-only discovery/review by
  default; isolate intentional parallel writers in managed Git worktrees.
- Prefer native pi-subagents child-supervisor coordination. External intercom is
  for explicit independent-session dependencies, not routine child handoffs.

## Repository work

- Use focused Vitest files during slices, then `npm run check`, `npm run lint`,
  and `npm run verify` before completion.
- Keep aligned Pi package versions and npm aliases synchronized.
- Add user-facing or dependency changes under `CHANGELOG.md` → `Unreleased`.
- Preserve substantive legacy `.ged` content during migrations and make
  migrations idempotent.
