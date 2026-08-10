# Spec: Task-scoped governance kernel — slice 3

## Goal

Add one authoritative, versioned structured governance record per generated
work item with process-local serialization, monotonic revisions, stale-write
rejection, lossless concurrent evidence appends, and deterministic Markdown
projection regeneration.

## Scope

- Define the canonical work-state, approval, and role-neutral evidence types.
- Store authoritative state at `.ged/runtime/<work-id>/governance.json`.
- Add strict parsing, initialization, compare-and-swap update, and serialized
  evidence append operations.
- Write structured state before projections and allow deterministic projection
  regeneration after interruption.
- Keep existing checkpoint guards and legacy migration unchanged in this slice.

## Non-goals

- Do not import legacy checkpoint records, authorize mutation from the new
  state, or remove checkpoint compatibility yet.
- Do not add cross-process lock stealing or content/Git snapshot digests.
- Do not make Markdown authoritative.

## Acceptance

- Revisions start at zero and increase exactly once per accepted mutation.
- Stale expected revisions are rejected without changing state.
- Concurrent evidence appends retain every unique record.
- Corrupt or unknown schemas fail closed.
- Projection loss does not affect structured state and can be regenerated.
