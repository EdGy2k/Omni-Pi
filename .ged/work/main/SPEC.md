# Spec: Task-scoped governance kernel — slice 2

## Goal

Replace branch-derived work selection with immutable generated work IDs,
session-scoped ignored active pointers, and explicit per-request `open` or
`continue` transitions before mutation.

## Scope

- Generate readable, time-sortable work IDs with cryptographic entropy.
- Resolve active paths from `.ged/runtime/active-work/<session-key>.json`.
- Add atomic `open`, `continue`, bootstrap-selection, and binding-validation
  operations without importing legacy branch/root state.
- Register a `ged_work` tool that binds the current Pi session plus a fresh
  Ged request nonce to one work item.
- Block write/edit and commit calls when the current request has not explicitly
  selected work, regardless of subagent settings.
- Keep branch name and HEAD as display/metadata only.

## Non-goals

- Do not migrate legacy v2/v3 state, add the authoritative governance record,
  implement lifecycle transitions, or close shell mutation bypasses here.
- Do not silently select branch/root artifacts when no pointer exists.
- Do not add cross-process stale-lock recovery or compatibility shims.

## Acceptance

- Two tasks on one branch have distinct paths.
- Branch rename, detached HEAD, and non-Git operation do not change/collide IDs.
- Independent Pi sessions use independent pointers.
- Every new agent request receives a fresh binding; stale prior-request
  selection cannot authorize write/edit/commit.
- `continue` validates an existing generated work item before selection.
- Missing, corrupt, unknown-version, or traversal pointers fail closed.
