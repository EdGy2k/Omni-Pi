# Tests: Content-bound governance (Plan 002)

## Focused

- `npm test -- tests/content-fingerprint.test.ts tests/governance-store.test.ts tests/work-runtime.test.ts tests/brain.test.ts`
- `npm run check`
- `npm run lint`

## Completion gates

- `npm run format`
- `npm run verify`
- `npm audit --audit-level=high`
- `git diff --check`

## Scenario acceptance

- Canonical snapshots cover empty, staged, unstaged, binary, untracked, rename,
  deletion, spaces, linked worktree, and large-file repositories.
- Exact plan-byte edits invalidate accepted-plan authority.
- `sed -i`, redirection, formatter/script, and unknown mutators are detected by
  pre/post snapshots; no-op and modify-restore final equality remain clean.
- Verification failures/malformed commands are non-authorizing.
- Verified staged bytes commit; drift, auto-stage flags, unrelated staged paths,
  failed hooks, compound commands, and unchanged HEAD do not record milestones.
- Amend and multiple verified commits work while lifecycle remains active.
