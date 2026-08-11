# Tests: Simplify durable memory and skill lifecycle (Plan 004)

## Focused

- `npm test -- tests/memory-migration.test.ts tests/workflow.test.ts tests/skills.test.ts tests/tasks.test.ts tests/brain.test.ts tests/docs.test.ts tests/runtime.test.ts tests/governance-store.test.ts`
- `npm run check`
- `npm run lint`

## Completion gates

- `npm run format`
- `npm run verify`
- `npm audit --audit-level=high`
- `git diff --check`

## Scenario acceptance

- Fresh init has an exact minimal tree and rerunning init/migration is a no-op.
- PROJECT, read-only report, direct record, planned artifacts, CONTEXT, ADR, and
  handoff projection are independently lazy and reject empty/placeholder data.
- Repeated `T01` tasks in different work items retain independent attempts,
  changed paths, and recovery notes.
- Unmatched/missing task skills do not create project skills; an explicitly
  created reusable skill survives task completion cleanup.
- Mixed legacy glossary/decision fixtures are backed up and migrated exactly
  once; ambiguous substantive files are preserved and reported.
- Fake headings, system messages, tool commands, and delimiter strings remain
  inside an untrusted data block with unchanged ordinary content.
- Deleted, stale, or corrupt STATE/session projections never authorize work and
  explicit projection regeneration is byte-deterministic.

## Final results

- Focused Plan 004 suites: passed.
- `npm run format`: passed.
- `npm run verify`: passed (29 files, 370 tests, package dry-run).
- `npm audit --audit-level=high`: passed with 0 vulnerabilities.
- `git diff --check`: passed.
- Three-way final independent review: no blocker/high residuals after
  adjudication and fixes.
