# Plan 001: Introduce the task-scoped governance kernel

> **Executor instructions**: Implement the policy as a pure domain model plus
> one runtime-owned state store. Roles are optional evidence producers; never
> encode role invocation as authorization. Preserve substantive legacy content.
>
> **Drift check (run first)**:
> `git diff --stat 747eed2..HEAD -- src/contracts.ts src/ged-paths.ts src/brain.ts src/workflow.ts src/orchestration.ts src/vendor extensions/ged-core tests`

## Status

- **Status**: IN PROGRESS — slice 1 complete; slice 2 next
- **Priority**: P0
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/000-modernize-runtime-contracts.md`
- **Category**: architecture / correctness
- **Planned at**: commit `747eed2`, 2026-08-10

## Why this matters

GedPi currently equates optional subagents with governance, maps every branch to
one authorization namespace, and offers only `trivial`/`non-trivial`. This
allows stale branch state to authorize unrelated work and makes a clear small
fix pay for mandatory explorer/planner/verifier ceremony. The approved policy
separates **governance depth** from **execution staffing** and requires explicit
task lifecycle independent of commits.

## Target domain model

Create one canonical TypeScript model (new `src/governance.ts` or equivalent):

```ts
type WorkMode = "read-only" | "direct-change" | "planned-change";
type Ambiguity = "sufficient" | "decision-needed";
type Risk = "low" | "normal" | "high";
type WorkLifecycle =
  | "active" | "paused" | "completed" | "abandoned" | "superseded";
type ExecutionProfile = "solo" | "assisted" | "coordinated" | "high-stakes";
```

The state must include a collision-resistant `workId`, request summary/digest,
repository/worktree identity, branch and base HEAD as metadata, timestamps,
current slice, governance decision/reason, execution profile, approval/evidence
slots, lifecycle, and a monotonic revision.

## Current state

- `src/ged-paths.ts:22-47` derives `workId` solely from branch slug.
- `src/vendor/shared-checkpoints.js:17-122` defines binary classification and
  role-named checkpoints.
- `extensions/ged-core/index.ts:503-517` disables all guards when subagents are
  disabled.
- `extensions/ged-core/index.ts:680-693` closes the task after any apparently
  successful commit.
- `src/contracts.ts:165-205` duplicates and contradicts the runtime checkpoint
  declarations.

## Scope

**In scope**:
- canonical governance/state types and resolver
- task-scoped path selection and active-work pointer
- runtime-owned workflow transition tool/command
- schema migration/quarantine from branch-scoped v2/v3 state
- prompt, status, and guard migration to work modes
- focused governance/path/workflow/orchestration tests and docs

**Out of scope**:
- content digests and Git snapshots (plan 002)
- role model/profile selection (plan 003)
- lazy artifact deletion/consolidation (plan 004)

## Steps

### 1. Add a pure governance resolver

Implement and table-test rules:

- no mutation intent → `read-only` regardless of breadth;
- clear, bounded, reversible, deterministic check, no high-risk dimension →
  `direct-change`;
- high risk or unresolved product/security/API/data decision →
  `planned-change`;
- ambiguity `decision-needed` blocks mutation until resolved;
- file count is only supporting evidence.

The user owns mutation intent. The coordinator may escalate direct to planned
but cannot downgrade a requested plan or mutate read-only work.

**Verify**: a table-driven test covers explanation, architecture audit, one-file
bug, two-file mechanical fix, auth config, migration, ambiguous UI, and release
operation scenarios.

### 2. Add task-scoped identity and paths

Generate work IDs from a readable slug plus random/time-sortable suffix. Store
an active pointer under ignored runtime state; branch is metadata. Resolve
`.ged/work/<work-id>/` and `.ged/runtime/<work-id>/` from the active pointer,
not current branch.

Provide explicit `open`, `continue`, and lifecycle transition operations. Bind
each agent turn to an explicit open/continue transition so a stale active task
cannot silently authorize a new request.

**Verify**: two tasks on one branch remain isolated; one task survives a branch
rename; detached/non-Git work does not collide; stale prior state cannot satisfy
current-turn mutation.

### 3. Create one authoritative structured state

Replace role-centric checkpoint authorization with one versioned state record.
Keep human-readable STATE/session files as projections only. Serialize updates
per work item with a process-local queue and monotonic revision; reject stale
compare-and-swap writes.

**Verify**: concurrent completion updates retain both records; an interrupted
projection can be regenerated from structured state.

### 4. Migrate legacy state safely

On first access, classify old branch/root v2/v3 runtime records as legacy,
copy them to a timestamped quarantine/backup, and import at most one clearly
active record as `paused` with `migration-required` evidence. Never let legacy
state authorize mutation. Migration must be idempotent and journaled.

**Verify**: fixtures cover v2, v3, corrupt JSON, mixed root/branch layouts,
newer unknown schema, duplicate branch slugs, and interrupted migration.

### 5. Decouple governance from subagents

Run governance in solo and subagent configurations. Subagent settings only
select optional staffing/evidence producers. Main-agent evidence is valid when
it satisfies the same contract; no reason-only fallback checkpoint exists.

**Verify**: the full governance matrix passes with agents enabled and disabled.

### 6. Fix lifecycle semantics

A commit records a milestone but does not close work. Add explicit completed,
paused, abandoned, and superseded transitions with reason/timestamp. Keep work
active while incomplete slices remain.

**Verify**: multi-commit work remains active; each lifecycle transition is
recoverable; a terminal item cannot authorize a later request.

### 7. Update prompts, docs, and changelog

Remove mandatory visible `grill-me:` declarations and binary vocabulary. Ask
one concise question only when a real user-owned decision remains; otherwise
summarize naturally. Document governance versus execution as orthogonal planes.

## Verification

- `npm test -- tests/orchestration.test.ts tests/brain.test.ts tests/workflow.test.ts tests/runtime.test.ts`
- `npm run check`
- `npm run lint`
- `npm run verify`

## Done criteria

- [ ] Work mode, ambiguity, risk, execution profile, and lifecycle are typed once.
- [ ] Every work item has a unique ID independent of branch.
- [ ] Legacy state is non-authorizing and recoverable.
- [ ] Governance remains active when subagents are off.
- [ ] Commits do not implicitly close work.
- [ ] No exact visible `grill-me:` syntax is required.
- [ ] Focused and full verification pass; changelog is updated.

## STOP conditions

- Pi's extension API cannot expose a stable session/turn identity needed for
  current-turn binding. Stop and document the exact missing API; do not fall
  back to branch-only authorization.
- Migration would overwrite substantive user-authored `.ged` content.
- Active-work serialization requires a cross-process lock that cannot prove
  stale-owner recovery safely.

## Maintenance notes

Keep branch names display-only. Any future lifecycle state must have one writer,
one parser, and deterministic projection; do not reintroduce independent
Markdown authority.
