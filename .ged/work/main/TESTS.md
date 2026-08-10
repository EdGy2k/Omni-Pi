# Tests: Task-scoped governance kernel — slice 2

## Focused

- `npm test -- tests/ged-paths.test.ts tests/work-runtime.test.ts tests/workflow.test.ts tests/orchestration.test.ts tests/brain.test.ts tests/runtime.test.ts`
- `npm run check`
- `npm run lint`

## Completion gates

- `npm run format`
- `git diff --check`

## Scenario acceptance

- Generated IDs remain distinct for concurrent opens and sanitizer collisions.
- Active paths are pointer-selected, not branch-selected.
- Session A selection does not alter session B selection.
- Branch rename, detached HEAD, and non-Git projects retain immutable IDs.
- Corrupt/traversal pointers and missing continue targets fail closed.
- A new `before_agent_start` request cannot use the previous request binding.
- `ged_work` must run in a separate tool batch before write/edit/commit is
  accepted.
