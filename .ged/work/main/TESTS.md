# Tests: Task-scoped governance kernel — slice 4

## Focused

- `npm test -- tests/legacy-migration.test.ts tests/work-runtime.test.ts tests/governance-store.test.ts tests/ged-paths.test.ts`
- `npm run check`
- `npm run lint`

## Completion gates

- `npm run format`
- `npm run verify`
- `npm audit --audit-level=high`
- `git diff --check`

## Scenario acceptance

- Valid active v2/v3 imports once as paused non-selectable generated work.
- Inactive, corrupt, newer, duplicate, or ambiguous layouts back up without
  import; unsafe layouts stop initialization.
- Legacy source and backup bytes remain identical and are never overwritten.
- Recovery resumes each phase without duplicate backup, work, or evidence.
- Concurrent callers converge on one immutable plan and import.
- Imported work cannot be continued and a forged pointer cannot authorize it.
