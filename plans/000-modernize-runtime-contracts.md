# Plan 000: Modernize Pi, subagent, and intercom contracts

> **Executor instructions**: Follow each step in order. Do not combine this
> dependency migration with governance behavior changes. Stop at any listed
> STOP condition instead of inventing a compatibility shim.
>
> **Drift check (run first)**:
> `git diff --stat 747eed2..HEAD -- package.json package-lock.json src/agent-settings.ts src/orchestration.ts extensions/ged-core/index.ts tests`

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security / migration
- **Planned at**: commit `747eed2`, 2026-08-10

## Why this matters

The checked-in runtime cannot represent the user-requested
`openai-codex/gpt-5.6-luna:max` worker profile because Pi 0.82.1 predates the
`max` reasoning level and full GPT-5.6 metadata. The current pi-subagents 0.37.2
also predates its current `workflowScript`-only orchestration contract, while
GedPi's generated worker example already contains an unsupported acceptance
field. `npm audit --audit-level=high` currently reports four high-severity
transitive paths. Updating the substrate before redesigning orchestration avoids
building against an API that has already been replaced.

## Current state

- `package.json:103-120` pins Pi `0.82.1`, pi-subagents `0.37.2`, and
  pi-intercom `0.6.0`.
- `src/agent-settings.ts:29-36` recognizes thinking only through `xhigh`.
- `src/agent-settings.ts:681-704` recommends
  `acceptance.maxFinalizationTurns`, but pi-subagents 0.37.2 and 0.45.1 accept
  only `level`, `criteria`, `evidence`, `verify`, `review`, `stopRules`, and
  `reason`.
- pi-subagents 0.45.1 removed the public `tasks[]`/`chain[]` authoring surface
  in favor of direct single-child calls and `workflowScript`; update prompt and
  event parsing to the installed contract rather than preserving stale examples.
- Pi 0.84.1 supports GPT-5.6 Luna/Terra/Sol under `openai-codex` and exposes
  `max` reasoning.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Baseline | `npm run verify` | exit 0 |
| Audit | `npm audit --audit-level=high` | exit 0 after update |
| Focused tests | `npm test -- tests/package-config.test.ts tests/runtime.test.ts tests/agent-settings.test.ts tests/orchestration.test.ts tests/brain.test.ts` | all pass |
| Full gate | `npm run verify` | exit 0 |

## Scope

**In scope**:
- `package.json`, `package-lock.json`
- compatibility edits in `src/agent-settings.ts`, `src/orchestration.ts`,
  `extensions/ged-core/index.ts`
- related focused tests, `README.md`, `AGENTS.md`, orchestration docs,
  `CHANGELOG.md`

**Out of scope**:
- schema-v4/task identity work from plan 001
- new governance modes or adaptive staffing selection
- unrelated dependency majors unless required to clear a remaining reachable
  high advisory

## Steps

### 1. Establish the baseline

Run the focused tests and `npm run verify` before changing dependencies. Save
the exact `npm audit --audit-level=high --json` package names/count without
copying any credential or environment value.

**Verify**: baseline checks either pass or any pre-existing failure is recorded
before continuing.

### 2. Update the runtime set atomically

Update aligned Pi packages and aliases to `0.84.1`, pi-subagents to `0.45.1`,
and pi-intercom to `0.10.0`. Use targeted `npm install` arguments; do not run a
broad `npm update`. Inspect peer dependencies and lockfile churn.

**Verify**: `npm ls @earendil-works/pi-ai @earendil-works/pi-coding-agent @earendil-works/pi-tui pi-subagents pi-intercom` shows exactly the requested versions and no invalid peers.

### 3. Reconcile API drift

Update generated role frontmatter and orchestration guidance to current
pi-subagents fields. Remove `maxFinalizationTurns`; use top-level runtime/turn
budgets only where actually supported. Update foreground and async completion
parsing to consume current structured result details and keep missing semantic
outcomes non-authorizing. Do not add fallback behavior for a removed API.

**Verify**: focused runtime/agent/orchestration tests pass.

### 4. Add GPT-5.6 and maximum-reasoning compatibility

Accept `max` as a canonical thinking level. Preserve legacy `xhigh`. Ensure
model availability checks strip both suffixes and generated frontmatter emits
`thinking: max` unchanged.

**Verify**: focused tests cover `openai-codex/gpt-5.6-luna:max` round-trip,
display, fallback handling, availability lookup, and generated frontmatter.

### 5. Clear security and packaging gates

Run the audit and full verification. If a high advisory remains, identify its
exact dependency path. Apply only a compatible targeted override/update with a
focused test, or stop under the conditions below.

**Verify**: `npm audit --audit-level=high` and `npm run verify` exit 0; package
dry-run contains no nested vendored `node_modules` or lockfiles.

### 6. Document and commit

Add an Unreleased dependency/security entry and note the orchestration API
compatibility change. Commit with a conventional dependency/migration message.

## Done criteria

- [ ] Pi packages/aliases are `0.84.1`.
- [ ] pi-subagents is `0.45.1`; pi-intercom is `0.10.0`.
- [ ] `max` reasoning round-trips and emits correctly.
- [ ] No generated example contains `maxFinalizationTurns`.
- [ ] High-severity npm audit is clear.
- [ ] Focused tests and `npm run verify` pass.
- [ ] Changelog and runtime docs match the installed APIs.

## STOP conditions

- A required package has incompatible peer requirements that need an unrelated
  runtime major or a fallback extension path.
- Clearing a high advisory requires downgrading a direct runtime package.
- pi-subagents 0.45.1 removed an event/result contract GedPi cannot replace via
  its documented public API.
- Verification fails twice for an API incompatibility outside the in-scope
  files.

## Maintenance notes

Keep Pi packages and `@mariozechner` aliases aligned. Future orchestration plans
must cite the installed pi-subagents docs, not historical prompt examples.

