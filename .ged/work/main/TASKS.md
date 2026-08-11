# Tasks: Simplify durable memory and skill lifecycle (Plan 004)

## Slice 1 — Artifact model and lazy initialization

- [x] Add the durable artifact inventory and versioned, idempotent migration
  contract.
- [x] Reduce fresh initialization/bootstrap work to exact machine metadata.
- [x] Add create-on-substance helpers for PROJECT, reports, direct/planned work,
  root CONTEXT, ADRs, and handoff projections.

## Slice 2 — Work-scoped task evidence and durable skills

- [x] Move task brief/history/recovery consumers beneath
  `.ged/work/<work-id>/tasks/<task-id>/` and prove repeated IDs are isolated.
- [x] Remove task-paraphrase generation and automatic skill deletion.
- [x] Add explicit reusable project-skill creation with durable provenance and
  conservative legacy handling.

## Slice 3 — Domain migration and prompt trust

- [x] Migrate glossary/context and decisions non-destructively with canonical
  destinations, byte-exact backups, pointers, retained-content diagnostics, and
  idempotent reruns.
- [x] Separate approved instructions from durable/arbitrary data in prompts and
  make data delimiters injection-safe.

## Slice 4 — Projection authority, docs, and completion

- [x] Stop eager STATE/session/progress/global-plan projections and synthesize
  status from authoritative governance state.
- [x] Update README, AGENTS, bundled skills/prompts, architecture/context map,
  decisions/ADR, changelog, and Plan 004 status.
- [x] Run focused/full verification, independent review, adjudicate findings,
  and commit.
