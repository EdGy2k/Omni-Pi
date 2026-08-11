# Tasks: Content-bound governance (Plan 002)

## Slice 1 — Canonical repository snapshots

- [x] Add versioned canonical hash/record helpers and Git snapshot contracts.
- [x] Cover staged, unstaged, untracked, binary, rename, deletion, spaces,
  worktrees, no-Git, and large-file behavior.
- [x] Store the opening baseline in authoritative governance state.

## Slice 2 — Plan and mutation binding

- [x] Bind accepted plan evidence to exact SPEC/TASKS/TESTS bytes and paths.
- [x] Recompute plan binding before planned source mutation.
- [x] Guard mutation-capable bash/unknown tools with durable pre/post snapshots.
- [x] Persist observed changed paths and leave no-op/failed-no-change calls clean.

## Slice 3 — Verification and commit binding

- [x] Execute structured verification commands and persist bounded results.
- [x] Bind verification to the full snapshot, staged digest, and observed scope.
- [x] Reject drift, unrelated staged paths, auto-staging, and compound commits.
- [x] Record commit milestones only after proven HEAD/tree advancement.

## Slice 4 — Integration, docs, and completion

- [x] Cover staffing/process-result non-authority and multi-commit behavior.
- [x] Update prompts, docs, changelog, architecture, and Plan 002 status.
- [x] Run focused/full verification, independent review, and commit.
