# Spec: Content-bound governance (Plan 002)

## Goal

Bind accepted plans, observed mutation, verification, and commits to canonical
repository content so stale or unrelated bytes cannot reuse governance evidence.

## Scope

- Add deterministic SHA-256 repository snapshots using argv-based Git calls,
  including HEAD, staged, unstaged, rename/delete/binary, and untracked content.
- Capture a baseline when work opens and structured changed-path bindings for
  every observed mutation-capable tool result.
- Store accepted plan digests and reject planned source mutation after plan-byte
  drift until re-acceptance.
- Treat bash and unknown tools as mutation-capable except a narrow audited
  read-only allowlist; compare pre/post snapshots regardless of process result.
- Execute declared verification commands in the runtime, persist bounded
  command evidence plus the resulting snapshot, and require current staged/full
  snapshot equality before commit.
- Reject staged paths outside observed work scope and commit commands that stage
  content or combine post-commit commands.
- Record a commit milestone only after proving HEAD advanced.

## Non-goals

- This is an evidence and accident-prevention boundary, not an OS sandbox.
- Do not parse free-form planner/verifier prose as semantic authority.
- Do not stage files automatically or include secret environment values.
- Do not implement adaptive staffing or durable-memory simplification yet.

## Acceptance

- Snapshot serialization is deterministic across ordering, spaces, binary
  content, deletes, renames, staged-only, unstaged-only, and untracked files.
- Plan-byte drift blocks planned mutation until a new accepted-plan transition.
- Shell/unknown tool mutation records exact changed paths and makes prior
  verification stale; no-op results do not append implementation evidence.
- Verification is runtime-executed and binds command results to the full current
  snapshot and work scope.
- Commit requires an already-staged digest exactly matching verified content and
  no unrelated staged path.
- Failed/masked/compound commits cannot record a milestone; proven HEAD advance
  records one milestone without closing work.

## Boundaries

- Large files use streaming full-content SHA-256 to bound memory without
  weakening content identity.
- External mutation between stable snapshot attempts is detected as drift but cannot be
  attributed to a process without OS-level tracing.
