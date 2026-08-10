# Tests: Task-scoped governance kernel — slice 1

## Focused

- `npm test -- tests/governance.test.ts`
- `npm run check`
- `npm run lint`

## Completion gates

- `npm run format`
- `git diff --check`

## Scenario acceptance

- Read-only intent wins regardless of breadth or risk.
- Clear bounded reversible changes with deterministic verification resolve
  direct-change even when two files are involved.
- High-risk auth, migration, and release changes resolve planned-change.
- Unresolved UI decisions block mutation under planned-change.
- Explicit read-only/planned user constraints are preserved.
- Coordinator escalation may raise direct-change to planned-change.
