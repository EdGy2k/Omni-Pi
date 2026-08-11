# Governance-First Adaptive Orchestration

Status: approved target; governance foundation implemented through Plan 001
slice 5. Content-bound enforcement and adaptive staffing remain ordered follow-up
work in Plans 002 and 003.

## Purpose

GedPi should scale ceremony and staffing independently. A request's risk decides
what evidence must exist; available assistants decide only how the work is
performed. The coordinator remains the only user-facing brain and final decision
owner in every configuration.

## Invariants

1. Governance works identically with optional agents enabled or disabled.
2. A role name, launch, completion event, disabled-role fallback, Markdown file,
   branch name, or successful process is never authorization.
3. Every mutating request explicitly opens or continues one immutable work ID.
4. `.ged/runtime/<work-id>/governance.json` is the sole machine authority.
5. The coordinator owns scope, risk, plan acceptance, evidence adjudication,
   commits, pushes, and lifecycle transitions.
6. One writer owns a checkout/worktree. Parallel writers require intentionally
   isolated worktrees.
7. Publication is user-owned. GedPi never pushes without an explicit request.

## Governance plane

### Work modes

- **read-only**: inspection, explanation, research, or reporting. It opens no
  mutating work and authorizes no repository mutation.
- **direct-change**: mutation is requested, ambiguity is resolved, risk is not
  high, and the change is clear, bounded, reversible, and deterministically
  checkable.
- **planned-change**: the user requests planning, risk is high, a user-owned
  decision is unresolved, the coordinator escalates, or any direct-change
  condition is missing.

The resolver applies precedence rather than a heuristic score:

1. no mutation intent → read-only;
2. unresolved user decision → planned-change with mutation still blocked;
3. explicit planned minimum, high risk, or coordinator escalation →
   planned-change;
4. every direct-change eligibility fact true → direct-change;
5. otherwise → planned-change.

File count and staffing are not mode authority.

### Task-scoped identity

Work IDs are generated and immutable. Branch and HEAD are diagnostic metadata
only. Session-scoped pointers live under
`.ged/runtime/active-work/<session-key>.json` and bind a work ID to one fresh
agent-request nonce. Every new mutating request must call `ged_work open`, or
`ged_work continue` when the user is explicitly continuing the exact work ID.

Open receives structured minimum mode, ambiguity, risk, direct-change facts,
and an optional execution profile. Governance is initialized before the new
work item is bound to the request. Continue fails closed for absent, malformed,
read-only, unresolved, paused, blocked, completed, cancelled, or imported
non-selectable state.

### Authoritative state

`governance.json` stores schema version, work identity, revision, lifecycle,
mode decision, execution profile, append-only evidence, approvals, and optional
current slice. Accepted changes use serialized compare-and-swap semantics.
Markdown status and handoff files are regenerable projections only.

Legacy `checkpoints.json` files remain parser/migration inputs while
compatibility is needed. Migration preserves byte-exact ignored backups and may
import one unambiguous candidate as paused review data. Legacy role evidence is
never copied into authorizing fields or selected as current work.

### Role-neutral transitions

`ged_governance accept-plan` appends satisfied plan evidence after the
coordinator accepts the canonical planned artifacts and any configured human
review is complete. Planned-change source mutation requires the latest plan
evidence to be satisfied.

`ged_governance record-verification` appends satisfied verification evidence
after checks pass and findings are adjudicated. A commit requires satisfied
verification evidence later in append order than the latest successful
implementation evidence. A later failed plan or verification record supersedes
an earlier satisfied record of the same kind.

Successful Pi `write`/`edit` calls append runtime-owned implementation evidence
after tool completion. Calls enter authoritative durable pending state before
execution; failed results clear it, while a pending call blocks commit even
after runtime restart. Assistant results can inform the coordinator but never
write these transitions automatically.

A successful commit is a milestone. It does not consume plan evidence or close
current or legacy work.

### Explicit lifecycle

`ged_lifecycle` changes one exact work ID with a coordinator-owned reason and a
runtime timestamp. Active work can pause or become completed, abandoned, or
superseded. Paused work can resume or become terminal. Terminal work never
transitions again and cannot authorize a later request.

Every accepted lifecycle change appends immutable `from`/`to` history and
advances governance revision once. Any durable pending mutation blocks a
transition. Completion additionally requires the same current plan and
verification evidence required for commit. Commits, staffing changes, subagent
events, Markdown edits, and legacy checkpoints never change lifecycle.

### Protected Ged paths

The runtime resolves existing targets and their nearest existing ancestors,
including symlinks, rather than trusting a `.ged` substring:

- current `SPEC.md`, `TASKS.md`, `TESTS.md`, `NOTES.md`, durable root memory,
  and project skills are metadata mutations;
- governance state, session pointers, migration records, `META.json`, other
  work items, and unknown `.ged` paths are runtime-owned and protected;
- paths outside `.ged` are source mutations for the current guard boundary.

## Current enforcement boundary

The current runtime intercepts Pi `write`, `edit`, and detected `git commit`
commands. This is an accident-prevention and evidence boundary, not an OS
sandbox. Plan 002 adds conservative mutation detection for broader shell and
unknown tools, canonical content fingerprints, staged-diff verification, and
approval invalidation when governed bytes change.

## Execution staffing plane

Staffing is capacity, not governance. Plan 003 will select among:

- **solo**: coordinator executes directly;
- **assisted**: one focused scout, reviewer, or verifier;
- **coordinated**: several disjoint evidence producers and/or isolated workers;
- **high-stakes**: stronger independent review and stricter acceptance.

Signals include decomposability, context spread, difficulty, uncertainty,
parallelism value, review value, and budget. Staffing can escalate or shrink
without changing work mode. A planned-change can remain solo; a read-only
request can use several scouts.

Optional assistants may inspect, draft, critique, implement bounded isolated
slices, or verify. The coordinator validates their outputs and records accepted
evidence. Native child-supervisor messaging handles parent/child coordination.
`pi-intercom` is reserved for explicit dependencies between independent
sessions, not routine completion handoffs.

## Durable memory

- Root `.ged/*.md` files contain compact current project truth.
- `.ged/work/<work-id>/` contains current task artifacts.
- `.ged/runtime/<work-id>/governance.json` contains authoritative machine state.
- Runtime Markdown is projection/handoff material.
- `.pi/` contains ignored acceleration caches such as the repo map.

Current-state documents should be edited in place. Historical narrative belongs
in Git history, release notes, archived plans, or explicit decision records.
