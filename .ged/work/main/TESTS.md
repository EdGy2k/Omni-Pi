# Tests: Adaptive staffing and model profiles (Plan 003)

## Focused

- `npm test -- tests/staffing.test.ts tests/writer-lease.test.ts tests/agent-settings.test.ts tests/commands.test.ts tests/orchestration.test.ts tests/work-runtime.test.ts tests/runtime.test.ts`
- `npm run check`
- `npm run lint`

## Completion gates

- `npm run format`
- `npm run verify`
- `npm audit --audit-level=high`
- `git diff --check`

## Scenario acceptance

- Adaptive profile table selects proportional staffing independently of work
  mode.
- `maximum`/legacy effort normalizes to `max`; Luna/max Worker and Sol/high
  Smart Worker frontmatter survive runtime discovery and public preflight.
- Profile setup rejects missing live model IDs without changing settings; role
  overrides and fallback order survive profile enablement.
- Two same-checkout writer lanes block, parallel scouts pass, managed isolated
  writers pass, and dynamic possibly-writing parallel lanes fail closed.
- Normal Worker has no subagent tool; Smart Worker has depth one and inherited
  capability ceiling permits only read-only Ged child agents.
- Supervisor and peer communication prompts/settings remain distinct; peer
  messaging defaults off and can only send verified dependency facts.
