# Spec: Adaptive staffing and model profiles (Plan 003)

## Goal

Make optional execution staffing proportional to decomposition, context spread,
difficulty, and budget while keeping work governance unchanged and coordinator
authority explicit.

## Scope

- Represent Scout, planner/reviewer, Worker, Smart Worker, and verifier as typed
  capabilities independent of model bindings and legacy role aliases.
- Add a pure adaptive execution-profile recommender for `solo`, `assisted`,
  `coordinated`, and `high-stakes` staffing.
- Add an adaptive GPT-5.6 profile: Scout uses Sol/low, Worker uses Luna/max,
  Smart Worker uses Sol/high, and strong read-only roles retain explicit user
  overrides with same-provider fallbacks.
- Normalize `maximum` and legacy `reasoningEffort` to Pi's canonical `max`.
- Add `/ged-agents profile adaptive` for UI/headless sessions, validate exact
  required model IDs against the live registry before saving, and report
  unavailable configured profile chains without blocking startup.
- Enforce one writer in the current checkout. Parallel writer lanes require
  managed `worktree: true`; ordinary workers cannot fan out, and Smart Worker
  gets depth-one, read-only-only nested capability through public Pi and
  pi-subagents APIs.
- Make native supervisor coordination the child decision/progress channel.
  Keep external peer messaging separate, disabled by default, and limited to
  verified fact/dependency sends to an exact user-directed target.
- Generate and preflight role contracts through public `pi-subagents/preflight`.

## Non-goals

- Staffing never changes governance mode, accepted evidence, lifecycle, commit,
  push, product, architecture, migration, security, or UX authority.
- Do not silently select an unconfigured provider when a profile model is
  unavailable.
- Do not implement durable-memory simplification from Plan 004.
- Do not modify pi-subagents internals or claim writer isolation outside Ged's
  intercepted coordinator dispatch path.

## Acceptance

- Recommendation table covers small fixes, broad review, parallel recon,
  disjoint implementation, coupled migration, high-stakes security, and low
  budget without consulting governance state.
- Generated Scout, Worker, Smart Worker, and verifier contracts expose exact
  capability, context, model, thinking, tool, and fanout restrictions.
- Adaptive profile setup fails before writing and names missing Luna/Sol IDs
  when the live registry lacks them; configured startup degrades with a visible
  diagnostic and preserves explicit fallback chains.
- Parallel same-checkout writers are blocked; parallel scouts and managed
  isolated writers pass; nested normal workers cannot dispatch; Smart Worker
  can dispatch only read-only Ged agents at depth one.
- Child decisions use `contact_supervisor`; routine completion uses results;
  external peer messaging is opt-in and non-authorizing.

## Boundaries

- WorkflowScript writer enforcement accepts statically analyzable public
  `runs.run`/`runs.all` launch objects and fails closed for dynamic parallel
  lanes that could contain unisolated writers.
- Live credential-backed model execution is environment-dependent; registry
  presence and generated/preflight contracts are the deterministic gates.
