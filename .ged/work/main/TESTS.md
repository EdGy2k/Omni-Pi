# Tests: Modernize GedPi runtime contracts

## Focused

- `npm test -- tests/runtime.test.ts tests/agent-settings.test.ts tests/commands.test.ts tests/orchestration.test.ts tests/brain.test.ts tests/docs.test.ts`
- `npm ls @earendil-works/pi-ai @earendil-works/pi-coding-agent @earendil-works/pi-tui pi-subagents pi-intercom`
- `npm audit --audit-level=high`

## Completion gates

- `npm run check`
- `npm run lint`
- `npm run verify`

## Packaging

- `npm pack --dry-run` contains no nested `node_modules`, lockfiles, or vendored
  dependency links.
