# Spec: Task-scoped governance kernel — slice 6

## Goal

Finish Plan 001 with explicit, auditable lifecycle transitions that are
independent of commits and staffing.

## Scope

- Add append-only lifecycle transition records with runtime-owned ID/timestamp,
  coordinator reason, and `from`/`to` states.
- Support explicit `pause`, `resume`, `complete`, `abandon`, and `supersede`
  actions through a dedicated runtime tool targeting an exact work ID.
- Allow `active -> paused|completed|abandoned|superseded` and
  `paused -> active|completed|abandoned|superseded`; terminal states cannot
  transition again.
- Require no pending mutation for any lifecycle transition and require current
  commit-grade verification before `complete`.
- Keep commits as milestones only; lifecycle changes occur exclusively through
  the explicit transition API.
- Update prompts, projections, public docs, and tests for the lifecycle API.

## Non-goals

- Do not add content/Git fingerprints, broad mutation-tool detection, or staged
  diff verification; those belong to plan 002.
- Do not implement adaptive model/profile selection from plan 003.
- Do not reopen terminal work or infer lifecycle from commits, task Markdown,
  subagent completion, or legacy checkpoints.
- Do not add successor-work linking to `superseded`; reason and history are
  sufficient for this slice.

## Acceptance

- Pause blocks mutation and can be resumed explicitly by exact work ID.
- Completed, abandoned, and superseded work remain terminal and cannot
  authorize `continue`, mutation, commit, or another lifecycle transition.
- Completion fails without fresh verification and succeeds after verification
  newer than the latest implementation evidence.
- Pending writes block lifecycle transitions.
- Every accepted transition increments revision once, appends one immutable
  transition record, and regenerates the Markdown projection.
- Solo/staffed settings, subagent events, commits, and legacy checkpoint data
  never trigger lifecycle transitions.
