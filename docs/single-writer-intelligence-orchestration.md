# Main-Owned Intelligence Orchestration

## Purpose

GedPi uses `pi-subagents` and `pi-intercom` to delegate context gathering, planning drafts, critique, verification, and optional implementation slices while keeping the main GedPi brain as the user-facing decision owner.

The rule to preserve is:

> Context and implementation slices can be delegated. Scope decisions, final `.ged` artifacts, verification adjudication, commits, pushes, and PR decisions stay with the primary Ged brain.

## Current decisions

- GedPi bundles `pi-subagents` and `pi-intercom` instead of the legacy `@tintinweb/pi-subagents` package.
- Generic/default agents bundled by `pi-subagents` are hidden by default via `subagents.disableBuiltins: true`; Ged exposes its own roles.
- Main agent clarifies requirements and owns user-facing decisions.
- `ged-explorer` performs read-only code/context and skill-fit reconnaissance.
- `ged-planner` authors draft `SPEC.md`, `TASKS.md`, and `TESTS.md` content from clarified requirements and explorer findings.
- Main agent accepts, edits, or rejects planner drafts and writes final `.ged` artifacts.
- `ged-plan-reviewer` provides optional/risk-based critique after the main agent has accepted/written the draft plan.
- `ged-verifier` performs clean-context review of diffs and verification evidence before commits.
- `ged-worker` is optional and disabled by default. When enabled, it may implement bounded approved slices, including parallel disjoint slices, only after the main agent performs a worker-suitability check. It must not commit, push, rebase, merge, make product decisions, or replace verifier/main acceptance.
- Intern/ops agent remains deferred/absent.
- `contact_supervisor` is for blocked decisions or progress-changing discoveries,
  not routine completion handoffs. pi-subagents owns the native spawned-child
  channel; external pi-intercom remains available for independent sessions.

## Settings model

Agent settings live outside `.ged/` because `.ged/` is durable workflow memory, not runtime/model configuration.

Use:

- global settings: `~/.gedoc/settings.json`;
- project override: `.gedoc/settings.json`, gitignored;
- runtime Pi suppression: `.pi/settings.json` with `subagents.disableBuiltins: true`.

Representative shape:

```json
{
  "agents": {
    "enabled": true,
    "intercomBridge": true,
    "critiqueMode": "risk-based",
    "defaultModel": {
      "model": "provider/model",
      "thinking": "medium",
      "fallback": ["provider/fallback"]
    },
    "roles": {
      "ged-explorer": { "enabled": true },
      "ged-planner": { "enabled": true, "thinking": "high" },
      "ged-plan-reviewer": { "enabled": true },
      "ged-verifier": { "enabled": true },
      "ged-worker": {
        "enabled": false,
        "maxParallel": 2,
        "preferWorktreeIsolation": false
      }
    }
  }
}
```

Compatibility requirements:

- `agents.enabled` defaults to `false`.
- Missing model settings inherit the invoking/orchestrator model.
- Existing legacy `agents.models` string/object entries remain readable and are merged into role settings.
- Project settings override global settings.
- Unknown roles are ignored/cleaned; `ged-worker` is now a valid optional role.
- Generated `pi-subagents` frontmatter uses the current package contract: required `name`/`description`, plus `fallbackModels`, `systemPromptMode`, `inheritProjectContext`, `inheritSkills`, and `completionGuard`.

## Runtime roles

### `ged-explorer`

Read-only repo and skill-fit discovery. It may read/search files, inspect docs/tests/standards/skills, run safe discovery commands, and report evidence. It must not edit, install skills, write `.ged` plans, commit, push, or make scope decisions.

### `ged-planner`

Planning author. It drafts plan artifacts from clarified requirements and explorer findings. It must refuse with `outcome: refused-needs-clarification` when the dispatch lacks enough goal, audience, scope, constraints, risks, or acceptance criteria. The main brain writes final `.ged` files.

### `ged-plan-reviewer`

Risk reviewer for accepted planner drafts. It separates blockers from non-blocking suggestions, flags worker-safety risks, and does not implement or rewrite scope on its own.

### `ged-verifier`

Clean-context review and verification support. It reports findings with evidence, confidence, suggested fix, and commit-blocking status. The main brain adjudicates, fixes accepted findings directly by default, and reruns verification.
Verifier dispatches must use a strict structured output schema with an `outcome`
of `clean` or `findings` and a `findings` array. Only `clean` with an empty array
is auto-recorded as a satisfied verifier checkpoint; process success or an
incomplete/rejected acceptance ledger is not enough.

### `ged-worker`

Optional implementation worker, disabled by default and generated only when enabled. Use it only for approved, bounded, low-ambiguity, low-risk, disjoint slices with a clear verification path. Before delegating, the main agent checks whether the slice is mechanically implementable and unlikely to require product, security, architecture, migration, API, or UX judgment. If a slice is too difficult, ambiguous, risky, coupled, hard to verify, or judgment-heavy, the main agent implements it directly. It may edit implementation files but must not run git commit/push/rebase/merge or make product/scope decisions. Parallel workers should target separate slices or file areas; optional worktree isolation may be preferred for safer parallelism.

## Workflow integration

When Ged mode is active:

1. Classify the task.
2. Clarify with the user unless the request is already concrete.
3. Use `ged-explorer` when enabled; otherwise the main brain performs and records fallback discovery.
4. Main brain adjudicates skill findings and performs any mutating project-skill install/create actions.
5. Use `ged-planner` to draft the implementation plan when enabled; otherwise main authors it.
6. Main brain accepts/edits/rejects the draft, writes final `.ged` plan artifacts, and records `planAcceptance` with accepted plan paths.
7. Run configured human/Glimpse plan review on the written draft.
8. Run `ged-plan-reviewer` according to critique mode: `off`, `risk-based`, or `always`.
9. Implement one bounded slice at a time. When `ged-worker` is enabled, perform a worker-suitability check before each delegation and keep unsuitable slices in the main agent.
10. Run planned checks.
11. Use `ged-verifier` when enabled, or explicit main-agent fallback verification when disabled.
12. Main brain adjudicates findings, fixes accepted issues directly by default, reruns verification, records progress, and commits. Do not re-invoke `ged-worker` for verifier fixes unless the fix is a rare new isolated mechanical slice with a clear verification path.

## Mandatory checkpoints

For non-trivial changes with agents enabled:

- classification and clarification/sufficiency are required before planning;
- `ged-explorer` or a role-disabled fallback is required before source inspection/planning;
- `ged-planner` draft plus main accepted/written plan recorded as `planAcceptance`, or planner-disabled fallback plan plus `planAcceptance`, is required before source edits;
- `ged-verifier` or verifier-disabled fallback verification is required before meaningful commits;
- worker completion never satisfies verifier/commit requirements;
- main-agent direct fixes after verifier findings still require rerunning verification before commit.

Worker completions are retained as non-authorizing `workerRuns` audit metadata so multiple disjoint worker slices can be reconciled without overwriting one checkpoint slot.

Checkpoint recording should use successful `subagent` foreground results and `subagent:async-complete` events. Launch alone does not complete a checkpoint.

## `/ged-agents` setup command

In interactive Pi sessions, bare `/ged-agents` opens the comprehensive status/configuration menu. `/ged-agents status` remains the text-only status view, and `/ged-agents setup` / `/ged-agents setup advanced` are compatibility aliases for the same menu. In non-UI sessions, `/ged-agents` keeps returning text status and `/ged-agents setup` returns copy/paste setup commands.

The setup/status UI should show:

- effective `agents.enabled` state;
- global and project settings paths;
- intercom bridge state;
- critique mode;
- per-role enabled state, model, thinking level, and fallback models, including fallback ordering in headless command mode;
- worker `maxParallel` and worktree preference;
- default builtin suppression state.

Guided setup should use Pi's runtime model registry for primary and fallback model selection and avoid invented model IDs. Setting a model should also prompt for the role/default thinking level and then offer to add one or more ordered fallback models. Fallbacks remain a flat ordered model list and use the role/default thinking setting rather than unsupported per-fallback thinking.

## Tests to keep current

- Dependency/package tests: `pi-subagents` and `pi-intercom` are pinned; legacy `@tintinweb/pi-subagents` is absent.
- Runtime path tests: configured extension/skill paths exist.
- Default suppression tests: `subagents.disableBuiltins: true` is written/preserved and generic builtins are hidden.
- Settings merge/migration tests: global/project, legacy `models`, role settings, fallback models, thinking levels, critique mode, intercom bridge, and worker settings.
- Agent generation tests: current `pi-subagents` frontmatter names are emitted and worker is absent until enabled.
- Orchestration tests: planner-authored draft flow, disabled-role fallback, intercom guidance, worker guardrails, and verifier/commit behavior.

## Success criteria

- GedPi exposes Ged-specific roles by default, not generic bundled subagents.
- Planner intelligence authors draft plans while the main brain owns final artifacts.
- Optional worker parallelism is available only when explicitly enabled and documented.
- Subagent/worker results improve throughput without weakening main-agent acceptance, verification, or commit ownership.

## Worker acceptance contracts

When `ged-worker` is explicitly enabled and a slice passes worker-suitability, the main brain should prefer a structured pi-subagents `acceptance` contract instead of placing all done-criteria in prose. Keep contracts lightweight and scoped to the assigned slice; they help the worker self-review and report evidence, but they do not replace main-agent acceptance or `ged-verifier` review.

Example worker handoff shape:

```ts
subagent({
  workflowScript: `return runs.run("T03", {
    agent: "ged-worker",
    task: "Implement only approved slice T03 from .ged/work/<work-id>/TASKS.md.",
    acceptance: {
      level: "verified",
      criteria: [
        { id: "slice", must: "Implement only the assigned T03 scope" },
        { id: "tests", must: "Run the focused verification listed for T03" }
      ],
      evidence: ["changed-files", "commands-run", "diff-summary", "residual-risks"],
      verify: [
        { id: "focused", command: "npm test -- tests/foo.test.ts", timeoutMs: 120000 }
      ],
      stopRules: [
        "Stop if scope expands beyond T03",
        "Stop if product/API/security judgment is needed"
      ]
    }
  })`,
  async: false,
  turnBudget: { maxTurns: 8, graceTurns: 2 },
  timeoutMs: 600000
})
```

The current public execution surface is `workflowScript` with stable-key
`runs.run`/`runs.all` calls. Acceptance supports `level`, `criteria`, `evidence`,
`verify`, optional `review`, and `stopRules`. Turn limits belong in the separate
top-level `turnBudget`; wall-clock limits use `timeoutMs`/`maxRuntimeMs`.
Top-level workflows now start asynchronously by default. Mandatory checkpoint
runs should pass `async: false`, or the coordinator must call `subagent_wait` and
consume terminal `details.completions` before continuing.

## Deferred orchestration roadmap from Pi 0.78 / pi-subagents 0.28

These are design targets, not implemented runtime behavior yet. Keep checkpoint compatibility in mind before changing `.ged` schemas.

### Structured verifier and checkpoint evidence

Future verifier and worker records can store compact metadata such as `findingCount`, `blocksCommit`, `acceptanceStatus`, `acceptanceReportPath`, `timedOut`, `resourceLimitExceeded`, and completed explorer scopes. Full reports should stay in `.pi/` artifacts; `.ged/runtime/*/checkpoints.json` should store only durable audit pointers and guard-relevant facts.

### Structured planner and explorer outputs

`pi-subagents` supports `outputSchema` and named outputs. GedPi should start with structured `ged-planner` drafts because SPEC/TASKS/TESTS naturally map to schema fields. Structured explorer output should follow once multi-explorer merging is designed.

### Parallel explorer agents and dynamic fanout

Exploration is read-only and often parallelizable. A safe first phase is static parallel explorers with disjoint prompts, for example UI/runtime, checkpoint/schema, and docs/tests scopes. The main brain must synthesize all findings before planning. Later phases can add scoped explorer checkpoint metadata and eventually dynamic fanout (`expand`/`parallel`/`collect`) from a structured scope-planning step. Do not let one completed explorer clear source-inspection safety for scopes that were not explored.

### Prompt-context dedupe

Pi 0.78 exposes `ctx.getSystemPromptOptions()` for extension command contexts. Before relying on it in agent lifecycle hooks, verify API availability in the relevant context. The goal is to reduce duplicated Ged/Pi context and tailor prompt suffixes to active tools, skills, and context files without weakening mandatory workflow instructions.
