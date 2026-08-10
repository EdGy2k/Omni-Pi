# Spec: Task-scoped governance kernel — slice 1

## Goal

Introduce the canonical pure governance vocabulary and resolver that selects
`read-only`, `direct-change`, or `planned-change` from normalized user mutation
intent, ambiguity, risk, change qualities, and optional coordinator escalation.

## Scope

- Add `src/governance.ts` as the canonical source for work mode, ambiguity,
  risk, lifecycle, and execution-profile types.
- Add a pure resolver with explicit precedence and a non-authorizing result.
- Table-test the scenarios required by plan 001 plus explicit user constraints
  and coordinator escalation.

## Non-goals

- Do not change paths, persisted checkpoint state, guards, prompts, lifecycle
  transitions, or legacy migration in this slice.
- Do not infer risk from file count or task prose.
- Do not make a planned-change classification authorize mutation.

## Acceptance

- No mutation intent always resolves read-only.
- Direct change requires sufficient ambiguity, non-high risk, clear bounded
  reversible scope, and deterministic verification.
- High risk, unresolved ambiguity, an explicit requested plan, or coordinator
  escalation resolves planned-change.
- A user read-only constraint cannot be overridden.
