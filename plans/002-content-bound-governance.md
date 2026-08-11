# Plan 002: Bind mutation, approval, verification, and commits to content

> **Executor instructions**: Treat extension interception as an accident-
> prevention and evidence boundary, not an OS sandbox. Fail closed when current
> content cannot be fingerprinted. Never stage unrelated user changes.
>
> **Drift check (run first)**:
> `git diff --stat 747eed2..HEAD -- extensions/ged-core/index.ts src/orchestration.ts src/git.ts src/atomic.ts src/vendor tests`

## Status

- **Status**: DONE — content-bound governance verified
- **Priority**: P0
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/001-task-scoped-governance-kernel.md`
- **Category**: correctness / security
- **Planned at**: commit `747eed2`, 2026-08-10

## Why this matters

Today, accepted plan paths can change without invalidating approval, successful
verifier prose can authorize a commit, shell edits bypass invalidation, and the
commit guard does not prove that staged bytes equal verified bytes. The hard
property should be simple: **planned/high-risk mutation has current accepted
scope, and a commit contains only content verified for this work item**.

## Current state

- `src/vendor/shared-checkpoints.js:299-345` validates path strings and
  timestamps but no content.
- `extensions/ged-core/index.ts:567-639` validates/invalidate only `write` and
  `edit` tools.
- `extensions/ged-core/index.ts:641-669` parses bash only for commit commands.
- `extensions/ged-core/index.ts:52-102` treats subagent process success as
  semantic verifier success and stores it under task `auto`.
- `src/orchestration.ts:360-380` can detect recent commits but closure does not
  compare pre/post HEAD.

## Target evidence

Use SHA-256 over canonical, length-delimited records. At minimum persist:

- accepted plan digest and exact plan paths;
- base HEAD and repository/worktree identity;
- scoped baseline diff digest;
- current index/staged diff digest;
- scoped working-tree/untracked digest;
- verification commands, exits, selected bounded output, timestamp, and
  environment-relevant keys;
- verifier structured outcome/findings when an independent verifier is used;
- residual risks and adjudication;
- evidence revision/work ID.

Never include secret values or full environment dumps in durable state.

## Steps

### 1. Implement canonical fingerprints

Add a focused Git/content module using argv-based `execFile`, never shell string
assembly. Include tracked staged/unstaged changes and scoped untracked file
content, with size/mtime fallback only above a documented safe threshold. Keep
path ordering and serialization deterministic across platforms.

**Verify**: unit fixtures cover empty repo, staged-only, unstaged-only, binary,
untracked, rename, deletion, spaces, worktree, and large file cases.

### 2. Bind plan acceptance

The runtime transition that accepts a plan must read canonical plan files and
store their digest. Planned-change mutation recomputes it; any material edit
invalidates approval. Machine critique happens before optional human approval;
human approval is last and also content-bound.

**Verify**: changing SPEC/TASKS/TESTS blocks planned mutation until re-accepted;
format-only byte changes also invalidate unless a documented canonicalization
explicitly makes them equivalent.

### 3. Guard mutation-capable tools conservatively

Define an allowlist of known read-only tools. Treat `write`, `edit`, bash, and
unknown extension tools as mutation-capable for pre-call authorization. In
read-only mode, block mutation-capable calls except explicit audited read-only
bash forms. In direct/planned mode, require current scope before call.

Capture a pre-call fingerprint and compare after every tool result. Any changed
repo content invalidates matching verification regardless of tool name. Do not
claim this is an OS security sandbox.

**Verify**: integration tests cover `sed -i`, `cat >`, formatter writes,
arbitrary scripts, apply-patch-like extension tools, no-op commands, and commands
that modify then restore content.

### 4. Require structured semantic outcomes

Parse current pi-subagents result details/output schemas. Planner refusal,
verifier blockers, malformed/missing outcome, timeout, partial completion, and
acceptance failure are non-authorizing. Map evidence to the explicit work and
slice ID; never use a generic `auto` task.

**Verify**: real event fixtures cover planned/refused planner, clean/blocking
verifier, malformed result, async completion, duplicate result, and late result
after branch/work switch.

### 5. Bind verification and commit

Record verification only after runtime-owned commands run against a captured
snapshot. Before commit, require staged digest equality with verified scope and
reject unrelated staged paths. Preserve unrelated dirty changes unstaged.

Capture HEAD/index/worktree before `git commit`; after tool result, record a
milestone only if HEAD advanced and no post-commit unverified mutation remains.
Compound commands that mask commit failure must not transition state.

**Verify**: temporary Git integration tests cover successful commit, failed
hooks, `cmd1 || true`, commit plus post-mutation, amend, unrelated staged file,
and multiple verified milestone commits.

### 6. Update docs and changelog

Document exact guarantees and limitations. Remove claims that narrow tool-name
interception “cannot be bypassed.”

## Verification

- `npm test -- tests/orchestration.test.ts tests/brain.test.ts tests/runtime.test.ts`
- new focused Git/evidence integration test file
- `npm run check`
- `npm run lint`
- `npm run verify`

## Done criteria

- [x] Plan approval is content-bound.
- [x] Any observed repo mutation invalidates affected verification.
- [x] Verifier/process success alone never authorizes commit.
- [x] Verification matches the staged content exactly.
- [x] Unrelated dirty/staged changes are rejected or preserved outside scope.
- [x] Commit milestone requires proven HEAD and tree change.
- [x] Full verification passes and docs/changelog state honest guarantees.

## STOP conditions

- The Pi tool lifecycle does not expose a correlation key sufficient to pair
  pre-call and post-result snapshots safely.
- Correct fingerprinting would require reading files above the threshold with no
  reliable metadata fallback.
- A public provider emits no structured terminal outcome and no documented API
  can retrieve it. Do not parse free-form prose as authorization.

## Maintenance notes

Any new mutation-capable tool should work automatically through pre/post repo
snapshots; avoid growing a command-parser security boundary. Evidence formats
must be versioned and ignore unknown future fields when safe.
