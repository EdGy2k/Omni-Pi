# Decisions

## Entries

- Date: 2026-08-10
  - Decision: Replace binary trivial/non-trivial workflow ceremony with three
    work modes: read-only, direct-change, and planned-change.
  - Why: Mutation intent, ambiguity, and risk determine necessary safeguards;
    role invocation and file count do not.
  - Impact: Governance must be enforceable in solo mode and may escalate but not
    silently downgrade user-requested planning or mutate read-only work.

- Date: 2026-08-10
  - Decision: Keep governance depth and adaptive execution staffing as separate
    selectors.
  - Why: Scouts, workers, smart workers, and verifiers provide capacity; they
    must not become mandatory authorization gates.
  - Impact: The main brain owns scope, risk, product decisions, acceptance,
    commits, pushes, and lifecycle. One writer is allowed per worktree.

- Date: 2026-08-10
  - Decision: Use native pi-subagents supervisor communication for child
    decisions; keep pi-intercom only for explicit independent-session or peer
    dependencies under a narrow trust policy.
  - Why: Native child routing already scopes messages to the spawning parent;
    external peer messaging is broader and must not become an authority path.
  - Impact: Peer agents may exchange verified facts/dependency updates, while
    scope and decisions return to the coordinator.

- Date: 2026-08-10
  - Decision: Modernize to Pi 0.84.1, pi-subagents 0.45.1, and pi-intercom
    0.10.0 before implementing the redesign.
  - Why: These versions provide GPT-5.6 plus maximum reasoning and the current
    orchestration/coordination contracts; designing against older APIs would
    create immediate migration work.
  - Impact: The dependency slice must reconcile documented API drift and clear
    reachable high-severity npm advisories before governance work proceeds.

- Date: 2026-08-10
  - Decision: Select immutable work IDs through ignored, session-scoped active
    pointers and bind mutation to a Ged-generated request nonce created at
    Pi's public `before_agent_start` boundary.
  - Why: Pi exposes a stable session ID and request lifecycle but no globally
    unique request ID. Session-scoped pointers prevent independent sessions
    from stealing each other's selection, while a fresh request nonce makes
    stale prior-turn evidence non-authorizing.
  - Impact: Branch and HEAD are metadata only. Legacy branch/root state is not
    selected implicitly; it remains untouched until explicit migration.

- Date: 2026-08-10
  - Decision: Migrate legacy v2/v3 checkpoint layouts through an ignored,
    immutable phase journal and byte-exact backup before importing at most one
    unambiguously active candidate.
  - Why: Legacy branch/root identity is lossy and legacy role records must not
    become current authorization. Exclusive phase publication gives
    cross-process crash recovery without stale-lock stealing.
  - Impact: Supported imports are generated as non-selectable paused work with
    failed `migration-required` evidence. Ambiguous, corrupt, unsupported, or
    inactive records are backed up but never imported; sources are never
    moved, rewritten, or trusted as approval.

- Date: 2026-08-11
  - Decision: Resolve mutation governance when `ged_work` opens a task and
    record accepted plan and verification evidence through a role-neutral
    runtime transition.
  - Why: Optional subagents may produce evidence but cannot own authorization;
    solo and staffed execution must satisfy the same state contract.
  - Impact: Hard guards read only authoritative governance plus current-request
    work binding. Legacy role checkpoints no longer gate reads, writes, or
    commits, and subagent completion alone cannot authorize mutation. Writes
    enter durable pending state before execution, so failed evidence persistence
    or runtime restart cannot revive stale verification.
