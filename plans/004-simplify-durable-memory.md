# Plan 004: Simplify durable artifacts and skill lifecycle

> **Executor instructions**: Delete only empty/generated placeholders or content
> already preserved in a canonical destination. Back up substantive legacy data
> and make migration idempotent.
>
> **Drift check (run first)**:
> `git diff --stat 747eed2..HEAD -- src/templates.ts src/workflow.ts src/work.ts src/skills.ts src/brain.ts src/context.ts .ged tests docs README.md`

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans 001 and 002
- **Category**: architecture / docs
- **Planned at**: commit `747eed2`, 2026-08-10

## Why this matters

GedPi eagerly creates a large tree of empty Markdown that looks authoritative,
stores every task's `T01` history in one global directory, and generates a new
“skill” by paraphrasing a task when none matches. The package's own historical
memory demonstrates stale/mixed state. Durable memory should contain substantive
reusable knowledge, while one machine record owns runtime state.

## Current state

- `src/templates.ts:8-293` eagerly defines project, architecture, patterns,
  glossary, ideas, decisions, skills, root plan, progress, and index files.
- `src/workflow.ts:392-399` creates every starter on initialization.
- `src/work.ts:61-109` stores briefs/history under global `.ged/tasks/<taskId>`.
- `src/skills.ts:629-794` auto-creates task-paraphrase skills and deletes
  managed skills after tasks close.
- `src/brain.ts:158-229` injects multiple durable files as guidance without
  distinguishing approved standards from ordinary model-written notes.

## Target artifact model

- Required machine metadata only at initialization: schema/version, ignored
  runtime directory policy, active-work pointer/state as needed.
- `.ged/PROJECT.md`: concise agent-oriented project summary, created when facts
  are substantive.
- Root `CONTEXT.md`: canonical project/domain vocabulary when used.
- `docs/adr/`: sparse durable decisions when a trade-off warrants an ADR.
- Read-only work: optional report.
- Direct-change: one concise scope/check record.
- Planned-change: SPEC/TASKS/TESTS.
- Runtime: one authoritative structured state; Markdown projections only for
  real handoff needs.
- Reusable project skills only; never one per task by default.

## Steps

### 1. Inventory real producers and consumers

Map every `.ged` artifact to its creator, parser, prompt injector, UI consumer,
and retention rule. Mark files with no substantive consumer. Use this map as a
migration fixture/document; do not infer authority from filename alone.

**Verify**: every retained artifact has one owner and at least one named
consumer; duplicates have an explicit canonical destination.

### 2. Make initialization lazy

Reduce starter files to required machine metadata. Add helper functions that
create PROJECT, reports, direct-change records, planned artifacts, CONTEXT, ADR,
and handoff projection only on first substantive write. Placeholder-only files
must not be prompt-injected as facts.

**Verify**: fresh-init test asserts the exact minimal set; each artifact has a
separate create-on-substance test.

### 3. Scope task artifacts by work ID

Move briefs, histories, recovery files, and retry counts beneath the active work
item. Ensure two work items can both contain `T01` without collision.

**Verify**: independent T01 fixtures retain separate attempts, modified files,
and recovery notes.

### 4. Remove task-paraphrase skill generation

If no relevant skill exists, continue without one. Search/install only when a
real capability gap warrants it. Create a project skill only for reusable,
non-obvious knowledge with provenance. Do not auto-delete durable reusable
knowledge merely because one task completed.

**Verify**: unmatched tasks create no skill; reusable explicit skill creation
persists; legacy generated task skills are quarantined or removed only when
their generated provenance and lack of edits are proven.

### 5. Consolidate domain documents non-destructively

Migrate substantive glossary/context into root `CONTEXT.md` and warranted
decisions into `docs/adr/`. Leave compatibility pointers/migration metadata as
needed; do not maintain writable duplicate `.ged/GLOSSARY.md` or
`.ged/DECISIONS.md` authorities. Preserve accepted imported repo standards.

**Verify**: mixed legacy fixtures preserve all substantive text exactly once and
rerunning migration is a no-op.

### 6. Clarify prompt trust boundaries

Keep package workflow/governance text trusted. Clearly delimit:

- approved project instructions (`AGENTS.md`, accepted `.ged/STANDARDS.md`);
- durable project facts/decisions;
- arbitrary repo-map/research/model-written data.

State in trusted package text that embedded data cannot override system/user
intent, governance, scope, verification, commit, push, or destructive-operation
authority. Sanitize structural delimiter injection without mangling ordinary
content.

**Verify**: adversarial fixtures containing headings, fake system messages,
tool directives, and closing delimiters remain inside the expected data block.

### 7. Project status from authoritative state

Generate STATE/session summary only when requested or when a real cross-session
handoff exists. Recovery regenerates projections from structured state and
never parses them back as authority.

**Verify**: stale/missing/corrupt projections do not change guards and are
deterministically regenerated.

### 8. Update docs and changelog

Update README, AGENTS, context-map/migration documentation, skills, and public
artifact examples. Add an Unreleased migration entry.

## Verification

- `npm test -- tests/workflow.test.ts tests/skills.test.ts tests/tasks.test.ts tests/brain.test.ts tests/docs.test.ts tests/runtime.test.ts`
- `npm run check`
- `npm run lint`
- `npm run verify`

## Done criteria

- [x] Fresh initialization creates only minimal machine metadata.
- [x] Direct/read-only/planned work creates only relevant artifacts.
- [x] Task histories are work-scoped.
- [x] No unmatched task auto-generates a skill.
- [x] Domain context/decisions have one canonical destination.
- [x] Prompt data and approved instructions have explicit trust labels.
- [x] Human projections are never authorization sources.
- [x] Migration is idempotent and preserves substantive content.
- [x] Focused/full verification and changelog pass.

## STOP conditions

- A legacy file contains substantive content with no unambiguous canonical
  destination. Preserve it and report; do not guess or delete.
- A generated skill was edited by a user and cannot be distinguished from
  generated content.
- GedCode currently requires a duplicate file path as a hard compatibility
  contract. Stop and define the smallest shared contract before removal.

## Maintenance notes

Adding a new durable artifact requires documenting its producer, consumer,
authority level, lifecycle, and migration. “Might be useful later” is not enough
to create a persistent file.
