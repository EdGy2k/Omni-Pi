# Spec: Task-scoped governance kernel — slice 4

## Goal

Quarantine legacy branch/root checkpoint state and, only when activity is
unambiguous, import one record as paused, non-selectable task-scoped work.

## Scope

- Discover legacy v2/v3 root and branch checkpoint layouts without following
  symlinks or treating Markdown as state.
- Publish a strict immutable migration plan, byte-exact backup, and monotonic
  phase markers under ignored runtime storage.
- Import only one clearly active candidate; never import ambiguous, corrupt,
  unsupported, or inactive candidates.
- Make imported work non-selectable and initialize paused authoritative state
  with non-authorizing `migration-required` evidence.
- Run migration before bootstrap work selection and current-version checks.

## Non-goals

- Do not migrate legacy approvals, role checkpoints, or branch identity as
  authority.
- Do not delete or rewrite legacy source files.
- Do not add stale-lock recovery, select imported work, or migrate the
  remaining legacy guards in this slice.

## Acceptance

- Every discovered safe source is backed up byte-for-byte before any import.
- Only one valid active v2/v3 candidate can be imported, and only when every
  other candidate is valid and inactive.
- Imported work is paused, non-selectable, and contains failed
  `migration-required` evidence rather than legacy authorization.
- Repeated and interrupted runs converge on one backup, work ID, and evidence
  ID without overwriting conflicting artifacts.
- Corrupt journals and unsafe layouts fail closed before bootstrap selection.
