# Tests: Task-scoped governance kernel — slice 6

## Focused

- `npm test -- tests/work-runtime.test.ts tests/brain.test.ts tests/governance-store.test.ts`
- `npm run check`
- `npm run lint`

## Completion gates

- `npm run format`
- `npm run verify`
- `npm audit --audit-level=high`
- `git diff --check`

## Scenario acceptance

- Active work can pause; paused work blocks mutation and resumes only through an
  explicit exact-work transition.
- Complete requires current verification after the latest implementation.
- Completed, abandoned, and superseded work reject continue and all later
  lifecycle transitions.
- Any durable pending mutation blocks lifecycle transition.
- Accepted transitions append one immutable reason/timestamp record and advance
  revision exactly once under concurrent callers.
- Multiple successful commits leave work active until explicit completion.
- Staffing settings, legacy checkpoints, and subagent results do not affect
  lifecycle.
