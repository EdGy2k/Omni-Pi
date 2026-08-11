# Tests: Task-scoped governance kernel — slice 5

## Focused

- `npm test -- tests/work-runtime.test.ts tests/brain.test.ts tests/orchestration.test.ts tests/governance-store.test.ts`
- `npm run check`
- `npm run lint`

## Completion gates

- `npm run format`
- `npm run verify`
- `npm audit --audit-level=high`
- `git diff --check`

## Scenario acceptance

- Open resolves the same governance state regardless of subagent settings.
- Missing, read-only, unresolved, paused, terminal, and migration-required
  governance blocks mutation.
- Direct change permits bound source writes without role evidence.
- Planned change permits planning-artifact writes but blocks source writes until
  satisfied plan evidence exists.
- Source writes make prior verification stale; only later satisfied
  verification permits commit.
- Pending writes are durable across restart, failed writes clear pending state,
  and symlink aliases cannot reach runtime-owned `.ged` paths.
- Legacy checkpoint files and subagent completion do not authorize writes or
  commits, and successful commits do not close work.
- Workflow prompts use work modes and optional staffing without mandatory role
  checkpoints or exact visible clarification declarations.
