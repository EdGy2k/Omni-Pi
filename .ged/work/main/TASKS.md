# Tasks: Task-scoped governance kernel

## Completed slices

- [x] Slice 1 — Pure governance resolver.
- [x] Slice 2 — Task identity and per-request selection.

## Slice 3 — Authoritative governance state

- [x] Add canonical work-state, approval, and evidence contracts.
- [x] Add strict structured-state parsing and initialization.
- [x] Add serialized CAS updates and lossless evidence appends.
- [x] Add deterministic projection and regeneration.
- [x] Run focused/full checks, independent review, and commit.

## Slice 4 — Fail-closed legacy migration

- [x] Add conservative legacy discovery and classification.
- [x] Add immutable migration plan, exact backup, and phase journal.
- [x] Add paused, non-selectable import with migration evidence.
- [x] Run migration before bootstrap selection and current-version checks.
- [x] Cover ambiguity, corruption, unsupported schemas, interruption,
  idempotence, and concurrent callers.
- [x] Run focused/full checks, independent review, and commit.

## Slice 5 — Staffing-independent governance guards

- [x] Initialize governance from structured `ged_work open` evidence.
- [x] Add role-neutral plan/verification evidence transitions.
- [x] Enforce mode, plan, lifecycle, and fresh verification from authoritative
  state with subagents enabled or disabled.
- [x] Remove legacy role guards, completion authority, and commit auto-close.
- [x] Migrate workflow prompts and injected status to governance vocabulary.
- [x] Cover durable pending writes, protected paths, the solo/staffed governance
  matrix, regressions, and commit.

## Slice 6 — Explicit lifecycle transitions

- [x] Add strict lifecycle transition contracts and serialized store mutation.
- [x] Register exact-work `ged_lifecycle` pause/resume/complete/abandon/
  supersede actions.
- [x] Enforce transition graph, pending-write exclusion, and verified
  completion.
- [x] Update projections, prompts, docs, changelog, and Plan 001 status.
- [x] Cover recovery, terminal rejection, multi-commit behavior, and staffing/
  legacy non-authority.
- [x] Run focused/full checks, independent review, and commit.
