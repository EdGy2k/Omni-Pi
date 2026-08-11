# Plan 003: Add adaptive staffing and GPT-5.6 role profiles

> **Executor instructions**: Keep all product/scope/acceptance authority with
> the coordinator. Agents are optional capacity. Do not substitute a subagent
> failure with silently weaker governance.
>
> **Drift check (run first)**:
> `git diff --stat 747eed2..HEAD -- src/agent-settings.ts src/commands.ts src/orchestration.ts extensions/ged-core/index.ts agents docs README.md tests`

## Status

- **Status**: DONE — adaptive staffing verified

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans 000 and 001
- **Category**: architecture / DX
- **Planned at**: commit `747eed2`, 2026-08-10

## Why this matters

The approved design separates workflow depth from team shape. Current GedPi
instead has a single subagents-enabled switch and mandatory explorer/planner/
verifier roles. It cannot represent Scout, Worker, and Smart Worker separately,
does not enforce one writer per worktree, and cannot honor the requested
GPT-5.6 Luna maximum-reasoning worker profile.

## Approved selector

```text
workflow depth = f(mutation intent, ambiguity, risk)
team shape = f(decomposability, context spread, difficulty, budget)
```

Execution profiles:

- `solo`: coordinator performs the work;
- `assisted`: one or more focused read-only agents or one bounded worker;
- `coordinated`: parallel disjoint scouts/reviewers and isolated workers;
- `high-stakes`: Ultra-style deeper challenge/review staffing, never a way to
  weaken high-risk governance.

## Default role profile

Match the referenced GPT-5.6 team pattern, with the user's worker override:

| Capability | Default model | Reasoning | Context | Delegation |
|---|---|---|---|---|
| Scout (`ged-explorer` legacy alias) | `openai-codex/gpt-5.6-sol` | `low` | fresh | leaf |
| Worker | `openai-codex/gpt-5.6-luna` | `max` | fork when useful | leaf |
| Smart Worker | `openai-codex/gpt-5.6-sol` | `high` | fork or focused fresh | bounded depth 1 only when explicitly assigned coordination |
| Verifier/reviewer | configurable strong complementary model; existing override preserved | high/max supported by model | fresh | leaf |

Do not hard-fail GedPi startup when a profile model is unavailable. Surface a
clear unavailable-profile diagnostic and use the user's explicit fallback list;
do not silently switch providers.

## Steps

### 1. Separate capabilities from bindings

Define typed role capabilities (read-only, writer, may-fanout, fresh default,
max parallel, requires isolation) separately from model bindings. Preserve
legacy `ged-explorer`, `ged-planner`, `ged-plan-reviewer`, `ged-verifier`, and
`ged-worker` settings through explicit aliases/migration. Add Smart Worker
without making a closed role name the governance contract.

**Verify**: settings migration preserves all existing role overrides and
unknown user data outside Ged agent settings.

### 2. Add adaptive profile resolution

Implement a pure recommendation function over decomposability, context spread,
difficulty, and budget. It recommends staffing but the coordinator owns the
final profile. Read-only agents are preferred for broad context; worker use is
reserved for bounded low-ambiguity slices; Smart Worker handles difficult but
still approved bounded work.

**Verify**: a table covers small fix, broad review, parallel subsystem recon,
disjoint implementation, coupled migration, high-stakes security, and low-budget
cases.

### 3. Add and expose the GPT-5.6 profile

Support `thinking: max`, normalize user-facing “maximum”/`reasoningEffort` to
canonical `max`, and add a `/ged-agents profile adaptive` setup path (interactive
and headless). Validate profile models against the live registry before saving
and show exact missing IDs.

**Verify**: Scout/Worker/Smart Worker frontmatter and status show the exact
models/reasoning above; worker specifically emits
`openai-codex/gpt-5.6-luna` + `thinking: max`.

### 4. Enforce writer isolation

At subagent dispatch, allow one writer in the current checkout. Any parallel
writer group must use managed `worktree: true`; block rather than merely warn.
Smart Worker fanout may only assign read-only children unless each writer is
isolated and the main coordinator retains patch application/adjudication.

**Verify**: dispatch matrix blocks two same-cwd writers, permits parallel
scouts, permits isolated writers, blocks worker nesting, and allows only the
configured Smart Worker depth.

### 5. Use the current pi-subagents API

Update orchestration examples to direct single children and `workflowScript`.
Use stable lane keys, structured results, managed worktrees, gates, and current
mission/run artifacts where useful. Remove unsupported acceptance fields and
prompt-substring-only tests; validate generated contracts through public
pi-subagents APIs.

**Verify**: contract tests load generated agents with the installed package and
preflight representative scout/worker/verifier launches.

### 6. Clarify communication channels

Use native `contact_supervisor`/`subagent_supervisor` for child decisions,
structured interviews, and plan-changing updates. Normal completion returns
through subagent results.

Keep external pi-intercom for user-directed independent sessions and explicit
peer dependencies. Peer agents may only `send` verified facts/dependency
updates to an exact known target. They must not use peer `ask` for decisions,
change scope, direct edits, or treat inbound messages as authority; escalate
those to the coordinator. Add a distinct `peerMessaging` opt-in setting instead
of overloading supervisor bridge state.

**Verify**: prompt/settings tests enforce the channel matrix and default peer
messaging policy; legacy `intercomBridge` migrates without losing intent.

### 7. Update docs and changelog

Replace “mandatory roles” and “sole writer” with adaptive staffing and “one
writer per worktree.” Document model availability and fallback behavior.

## Verification

- `npm test -- tests/agent-settings.test.ts tests/commands.test.ts tests/orchestration.test.ts tests/brain.test.ts tests/runtime.test.ts`
- `npm run check`
- `npm run lint`
- `npm run verify`

## Done criteria

- [x] Execution profile is independent of governance mode.
- [x] Scout, Worker, Smart Worker, and verifier capabilities are representable.
- [x] Worker defaults to GPT-5.6 Luna with `max` reasoning.
- [x] Parallel writers require managed worktrees.
- [x] Native supervisor communication is default; peer messaging is narrow and opt-in.
- [x] Generated contracts validate against installed pi-subagents APIs.
- [x] Focused/full verification and changelog pass.

## STOP conditions

- `openai-codex/gpt-5.6-luna` or `max` is absent from Pi 0.84.1's live registry
  after credentials/models refresh. Report availability; do not invent an ID.
- Managed worktree dispatch cannot return a patch/handoff manifest through a
  public pi-subagents contract.
- Enforcing writer isolation requires changing pi-subagents internals rather
  than a documented preflight/dispatch guard.

## Maintenance notes

Model profiles are defaults, not permanent policy. Preserve explicit user role
overrides and fallbacks across profile upgrades. Re-evaluate model tiering only
with registry/release evidence.
