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
- Date: 2026-08-11
  - Decision: Lifecycle changes are explicit role-neutral transitions recorded
    in authoritative governance history, never inferred from commits or agent
    completion.
  - Why: Multi-commit work must stay active, paused work needs an auditable
    recovery path, and terminal work must never regain authority implicitly.
  - Impact: Active work may pause or become terminal; paused work may resume or
    become terminal; terminal states never transition. Completion additionally
    requires current commit-grade verification, and all transitions reject
    pending mutations.
- Date: 2026-08-11
  - Decision: Bind plan acceptance, mutation evidence, verification, and commit
    milestones to versioned canonical SHA-256 repository snapshots.
  - Why: Tool/process success and timestamps cannot prove that accepted or
    verified bytes still match a commit, and unrelated staged changes must not
    be swept into governed work.
  - Impact: Work opening records a baseline; mutation-capable tools use durable
    pre/post snapshots; verification commands run through the runtime; commits
    require exact staged/full snapshot equality and observed work scope.

- Date: 2026-08-11
  - Decision: Represent execution staffing as typed capabilities plus separate
    model bindings, with a pure adaptive profile recommendation that never
    consults or changes governance mode.
  - Why: Decomposability, context spread, difficulty, and budget determine
    useful capacity; mutation intent, ambiguity, and risk determine authority.
  - Impact: The coordinator owns the selected solo/assisted/coordinated/high-
    stakes profile. The validated adaptive binding uses GPT-5.6 Sol/low Scout,
    Luna/max Worker, and Sol/high Smart Worker while preserving explicit role
    overrides and fallback order.

- Date: 2026-08-11
  - Decision: Enforce one current-checkout writer at dispatch and restrict
    Smart Worker nesting through pi-subagents' public inherited capability
    ceiling.
  - Why: Prompt-only writer advice and role names cannot prevent concurrent
    edits or a nested writer from escaping the approved slice.
  - Impact: Parallel/dynamic writers require managed worktrees; helper/static
    launch ambiguity fails closed; a durable checkout lease coordinates
    processes and terminal-status restart recovery; async writers retain
    pending content evidence until completion; top-level read-only roles omit
    mutation tools; normal Workers are leaves; Smart Worker may launch only
    depth-one read-only Ged children without bash/edit/write.

- Date: 2026-08-11
  - Decision: Keep native supervisor coordination and external peer messaging
    as distinct settings and authority paths.
  - Why: Spawned-child decisions have an exact native parent route, while
    independent-session messaging has broader reach and trust implications.
  - Impact: `contact_supervisor` owns child decisions/progress. Peer messaging
    defaults off and, when enabled, only sends verified facts/dependency updates
    to an exact user-directed target; no peer message authorizes scope or edits.
