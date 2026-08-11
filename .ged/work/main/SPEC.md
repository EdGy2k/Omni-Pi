# Spec: Simplify durable memory and skill lifecycle (Plan 004)

## Goal

Keep only substantive, reusable project knowledge in durable memory while
preserving authoritative governance state, immutable work identity, and all
legacy user content through an idempotent migration.

## Clarification checkpoint

- `grill-me` skipped: the approved Plan 004 defines the target artifact model,
  migration stop rules, trust boundaries, and acceptance checks precisely.
- Users are developers initializing or continuing GedPi in existing projects.
- Existing substantive content must never be guessed away, silently merged into
  an ambiguous destination, or treated as runtime authority.

## Skill-fit checkpoint

- Use `ged-execution` for bounded implementation and `ged-verification` for the
  planned checks.
- No external or new project skill is warranted: the task is a one-time GedPi
  architecture migration already covered by repository knowledge and tests.

## Scope

- Make fresh initialization create only required machine metadata and an empty
  bootstrap work identity; create human artifacts only on substantive writes.
- Add an explicit artifact-owner/consumer/authority/lifecycle inventory.
- Scope task briefs, histories, recovery notes, and retry counts beneath the
  immutable work item so repeated task IDs cannot collide.
- Stop generating skills from task prose and stop deleting reusable project
  skills when a task closes; retain explicit reusable skill creation with
  provenance.
- Migrate legacy glossary/domain context to root `CONTEXT.md` and legacy
  decisions to sparse `docs/adr/` records with byte-exact backups, compatibility
  pointers, migration metadata, and idempotent reruns.
- Remove exact generated placeholders while preserving and reporting legacy
  content without an unambiguous destination.
- Separate trusted package workflow text and approved imported standards from
  durable project data and arbitrary repository/model-written data. Content
  blocks must be structurally injection-safe without rewriting ordinary text.
- Generate runtime Markdown projections only for explicit status/handoff needs;
  guards and prompt status continue to read `governance.json` directly.

## Non-goals

- Do not weaken task-scoped governance, content fingerprints, lifecycle gates,
  writer ownership, or adaptive staffing.
- Do not infer user intent from a legacy filename or auto-promote ordinary notes
  into approved standards.
- Do not delete or auto-rewrite a legacy generated skill unless unchanged
  generated provenance is cryptographically provable.
- Do not retain writable duplicate authorities for domain context or decisions.

## Acceptance

- Fresh init's exact `.ged` tree contains only version/ignore/import metadata,
  the session bootstrap pointer, and bootstrap `META.json`; no placeholder
  PROJECT, work plan, status, handoff, progress, plan index, or skill registry.
- Direct work creates one concise direct-change record; planned work creates
  SPEC/TASKS/TESTS; read-only reporting and PROJECT/CONTEXT/ADR/handoff helpers
  create files only for non-empty substantive content.
- Two work items may both use `T01` with isolated histories, modified paths, and
  recovery briefs.
- Unmatched or unavailable skills create no files; explicit reusable project
  skills persist after cleanup.
- Mixed legacy fixtures preserve substantive glossary and decisions exactly in
  their canonical destinations, back up originals, retain ambiguous data, and
  produce no changes on rerun.
- Adversarial headings, fake system/tool directives, and attempted closing
  delimiters remain inside labeled data blocks and cannot change prompt
  authority.
- Missing, stale, or corrupt Markdown projections never affect governance and
  explicit regeneration is deterministic.

## Migration boundary

The migration may remove only exact known placeholders or source content that
has a byte-exact backup and canonical destination. Substantive legacy files with
no unambiguous destination remain in place and are named in migration metadata.
