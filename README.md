# GedPi

A batteries-included [Pi](https://github.com/badlogic/pi-mono) package with an always-on workflow for clarifying, documenting the spec, and implementing work in bounded slices.

Requires Node.js 22 or newer.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/gedpi.svg)](https://www.npmjs.com/package/gedpi)
[![CI](https://github.com/edgyarmati/gedpi/actions/workflows/ci.yml/badge.svg)](https://github.com/edgyarmati/gedpi/actions/workflows/ci.yml)

## What It Does

- Starts with the full Ged workflow always active — the agent clarifies, runs skill-fit, plans, implements, and verifies in bounded slices.
- Keeps approved standards and concise project facts durable without generating
  placeholder documents.
- Scopes specs, tasks, verification, attempt history, and recovery evidence by
  immutable work ID while authoritative runtime state stays machine-readable.
- Adds a repo map that indexes supported source files, ranks them by structure plus recent activity, and injects a compact codebase-awareness block into Ged prompts.
- Bundles web search, native micro-UI via Glimpse, native git diff review, prompt-template-powered workflow commands, and automatic updates out of the box.
- Documents a [main-owned intelligence orchestration](docs/single-writer-intelligence-orchestration.md) model: keep the Ged brain as decision owner while using explorer, planner, reviewer, verifier, and optional worker subagents for additional throughput.

## Install

```bash
npm install -g gedpi
```

Then run it in any project:

```bash
cd your-project
gedpi
```

## Features

### Bundled Skills

GedPi ships skills that power the Ged workflow and skill-discovery stack:

- `ged-init` — first-turn `.ged/` initialization and migration
- `ged-planning` — spec writing and task decomposition into bounded slices
- `ged-execution` — implementation of individual task slices
- `ged-verification` — post-implementation checks and state updates
- `ged-escalation` — automatic escalation when a slice repeatedly fails
- `find-skills` — discovering relevant skills from registries and repos
- `skill-creator` — creating reusable project-specific skills only when a real
  capability gap warrants durable knowledge
- `brainstorming` — structured planning and task creation flows

### Repo Map

GedPi now includes a SoulForge-style repo map for codebase awareness.

The first shipped version includes:

- incremental indexing of supported repo files while respecting `.gitignore`
- symbol/import extraction for TypeScript/JavaScript-family files with graceful fallback for partial/unsupported cases
- graph-aware ranking blended with current-turn boosts from recent reads, edits, writes, and prompt mentions
- budget-aware prompt rendering so Ged gets a compact ranked view of important files and exported symbols
- runtime cache storage under `.pi/repo-map/` rather than durable `.ged/` memory

Current deferred roadmap items remain intentional and visible in docs rather than hidden in code:

- semantic symbol summaries
- git co-change ranking
- richer analysis views such as dead-code or clone-detection signals
- broader parser/language coverage as needed

### Bundled Extensions

| Extension | What it does |
|-----------|-------------|
| **ged-core** | Brain workflow, `.ged/` durable memory bootstrap, header, session init, shortcuts, updater, and system prompt injection |
| **glimpseui** | Native micro-UI windows and the optional floating companion widget |
| **pi-web-access** | Web search and fetch tools for the agent |
| **pi-subagents** | `workflowScript` subagent runtime for Ged explorer/planner/plan-reviewer/verifier roles, native child-supervisor coordination, and optional settings-gated workers; generic builtins are hidden by default |
| **pi-intercom** | Optional messaging between independent Pi sessions; spawned-child decisions use pi-subagents' native supervisor channel |
| **pi-diff-review** | Native git diff review window that inserts structured review feedback into the editor |
| **pi-prompt-template-model** | Prompt templates can set thinking/model behavior and back commands like `/commit` and `/push` |
| **@plannotator/pi-extension** | Plan/code review UI; GedPi planned-work approval prefers native Glimpse, falls back to Plannotator's browser UI, and binds approval to the exact current plan artifacts |
| **~/.gedoc/settings.json** | GedPi workflow preferences (commit behavior, draft-plan review) via `/ged-settings` command |
| **native Pi UI** | GedPi uses Pi's native input, footer, working indicator, command palette, user-message, tool, and read rendering |

### Native Micro-UI

GedPi bundles [Glimpse](https://github.com/HazAT/glimpse) for native micro-UI windows. The bundled `glimpse` skill lets the agent open native dialogs, forms, previews, and other rich UI when a task benefits from it.

### Commands

| Command | Description |
|---------|-------------|
| `/diff-review` | Open a native git diff review window and insert feedback into the editor |
| `/commit` | Review local changes and create a descriptive conventional commit |
| `/push` | Push the current branch, with automatic recovery flow if the first push fails |
| `/settings` | Open Pi settings, including native Pi theme selection |
| `/update` | Check for GedPi updates |
| `/grill-me` | Ask one concise question at a time when a genuine user-owned decision is unresolved |
| `/rtk` | Install RTK and check Ged's automatic bash-side RTK routing (status, install) |
| `/ged-agents` | Configure adaptive/role-specific staffing, models, canonical thinking levels, ordered fallbacks, critique, native supervisor coordination, opt-in peer messaging, and writer capacity. Use `/ged-agents profile adaptive` for the validated GPT-5.6 profile and `/ged-agents status` for diagnostics. |
| `/ged-settings` | Configure workflow preferences, including accepted-plan review: no extra review, chat approval, or visual approval (Glimpse preferred, browser fallback) |

### Auto-Updater

GedPi checks for new versions on startup (cached, re-checks every 4 hours). When an update is available, it prompts to install and restart. Pi's own update notification is suppressed to avoid duplication.

## Ged Workflow

GedPi uses three governance modes, independent of optional execution staffing:

- **read-only** — inspect, explain, research, or report without repository mutation;
- **direct-change** — clear, bounded, reversible work with a deterministic check;
- **planned-change** — ambiguous, high-risk, explicitly planned, or otherwise
  direct-change-ineligible work.

For mutation, the brain opens task-scoped work with `ged_work`. The runtime
resolves mode from structured ambiguity, risk, minimum-mode, and direct-change
evidence, then stores the authoritative decision in
`.ged/runtime/<work-id>/governance.json`. A fresh request must explicitly open or
continue the exact work item before mutation.

The governed `ged_memory` tool creates substantive PROJECT summaries,
read-only reports, root CONTEXT, ADRs, and explicit handoff projections only
when needed. `ged_skill` separately creates reusable Pi-native project skills
with durable reason and content-hash provenance; neither tool turns Markdown
into authority.

Planned-change work may write its active `SPEC.md`, `TASKS.md`, and `TESTS.md`
before acceptance. With visual review selected, the final artifacts are shown
through `gedpi_plan_review`; approval is bound to their exact current bytes
before `ged_governance accept-plan`, so changed or stale plans require another
review. Source mutation then requires role-neutral accepted-plan evidence bound
to those exact bytes. Codex and other models use Pi's native `read`, `bash`,
`write`, and `edit` tools; GedPi does not install compatibility aliases. The
runtime snapshots known and unknown mutation-capable tools, executes declared
verification commands, and requires
the already-staged work scope to exactly match the verified repository snapshot
before commit. Proven HEAD advances become milestones and do not close work
automatically. `ged_lifecycle` explicitly
pauses, resumes, completes, abandons, or supersedes an exact work ID with an
auditable reason and timestamp; terminal work never reopens.

On the first agent turn GedPi also:

- initializes only required machine metadata and lazily creates substantive
  human artifacts;
- preserves legacy branch/root checkpoint data in ignored byte-exact backups,
  never as authorization;
- migrates substantive legacy glossary and decision content to root
  `CONTEXT.md` and sparse `docs/adr/` records while retaining ambiguous data;
- discovers external project standards and asks whether to retain them;
- maintains a compact runtime repo map under ignored `.pi/` state;
- runs skill-fit and installs/creates project skills only for real reusable
  capability gaps.

## Execution Staffing

`/ged-agents on|off` changes available capacity, not governance. GedPi
recommends `solo`, `assisted`, `coordinated`, or `high-stakes` staffing from
decomposability, context spread, difficulty, and budget; the coordinator owns
the final profile. Scout, planner/reviewer, verifier, Worker, and Smart Worker
capabilities are distinct from their model bindings. Their results are evidence
proposals only: no role name, launch, completion, or fallback authorizes
mutation.

`/ged-agents profile adaptive` validates the live registry before saving. Its
defaults are GPT-5.6 Sol/low for Scout, Luna/max for Worker, and Sol/high for
Smart Worker, with explicit same-provider fallbacks; existing role overrides
win. Missing configured chains produce diagnostics without silently switching
providers or preventing startup. `maximum` and legacy `reasoningEffort` migrate
to Pi's canonical `max`.

GedPi permits one writer in the current checkout at a time. Parallel writers
must use pi-subagents managed `worktree: true`; dynamic or aliased workflow
launches fail closed when isolation cannot be proven. Ordinary Workers are
leaf agents. Read-only role contracts omit bash/edit/write. Smart Worker has depth-one fanout, and an inherited public
pi-subagents capability ceiling limits nested children to read-only Ged agents
and non-mutating tools. Native `contact_supervisor`/`subagent_supervisor`
handles child decisions and plan-changing discoveries; routine completion uses
normal results. External `pi-intercom` peer messaging is separately opt-in and
may only send verified facts/dependency updates to an exact user-directed
independent-session target.

### Current guard boundary

GedPi's runtime guards are an accident-prevention and evidence boundary, not an
OS sandbox. They currently enforce request binding and authoritative governance
for known mutation-capable tools, mutating bash, and unknown extension tools;
audited, shell-free inspection forms such as `pwd`, `uname`, and bounded Git
status/revision/diff/log/show/current-branch commands remain available without
mutating work. Chaining, redirection, substitution, helper/output flags, npm
scripts, and ambiguous Bash stay governed and snapshot-observed. The runtime
protects runtime-owned `.ged` paths through resolved symlinks, durably records
pending operations, binds plans and verification to canonical SHA-256
snapshots, rejects unrelated staged paths, and records commit milestones only
after HEAD advances to the exact verified index tree. Commit pairing survives
restart and stable snapshots reject continuously changing repositories.
Async current-checkout workers retain a durable checkout-scoped writer lease
and pending mutation until their exact completion event records pre/post
content. Independent Pi processes see the same lease; restart recovery only
reclaims it after pi-subagents status proves the run terminal. External processes
outside Pi remain outside this boundary.

## Durable Memory

GedPi's memory is lazy and current-state oriented. Fresh initialization creates
only `.ged/VERSION`, `.ged/.gitignore`, standards-import metadata, an ignored
session pointer, and bootstrap `META.json`. It does **not** create placeholder
project, planning, progress, status, handoff, or skill files.

Substantive project knowledge has one canonical destination:

- `.ged/PROJECT.md` — concise agent-oriented goal, users, constraints, and
  success criteria, created on the first real write;
- root `CONTEXT.md` — canonical project/domain vocabulary;
- `docs/adr/*.md` — sparse decisions for meaningful trade-offs;
- `.ged/STANDARDS.md` — explicitly approved, content-hash-bound repository
  instructions;
- `.agents/skills/<name>/SKILL.md` — explicit reusable project skills using
  Pi's native trusted-project discovery. Ged records provenance lazily in
  `.ged/SKILLS-STATE.json` and never deletes a skill because a task closed.

Work artifacts are proportional to mode and scoped by immutable work ID:

```text
.ged/work/<work-id>/
├── META.json                  immutable machine identity (all mutating work)
├── DIRECT.md                  concise scope/check record (direct-change only)
├── SPEC.md                    ┐
├── TASKS.md                   ├ planned-change only
├── TESTS.md                   ┘
└── tasks/<task-id>/
    ├── BRIEF.md
    ├── HISTORY.json
    └── RECOVERY.md
```

Repeated task IDs such as `T01` cannot collide across work items. Read-only work
opens no mutating work; an optional report is created only when there is
substantive report content.

`.ged/runtime/<work-id>/governance.json` remains the sole machine authority.
`STATE.md` and `SESSION-SUMMARY.md` are optional, explicit status/handoff
projections and are never parsed back into guards. Session pointers live under
`.ged/runtime/active-work/`; legacy checkpoints and v2 memory receive byte-exact
ignored backups plus idempotent migration metadata. See
[the artifact contract](docs/durable-memory-artifacts.md) for every producer,
consumer, authority level, lifecycle, and migration rule.

## Development

```bash
git clone https://github.com/edgyarmati/gedpi.git
cd gedpi
npm install
npm run chat    # launch locally in dev mode
```

| Command | Purpose |
|---------|---------|
| `npm run chat` | Launch the local `gedpi` executable |
| `npm test` | Run the test suite (Vitest) |
| `npm run check` | TypeScript type-check |
| `npm run lint` | Biome lint + format check |
| `npm run verify` | Full local/CI gate: type-check, lint, test, and package dry-run |
| `npm run format` | Auto-fix lint and formatting |
| `npm install -g .` | Install globally from local checkout |

## CI/CD

- Pull requests and pushes to `main` run `npm run verify`.
- The docs are part of the test contract.
- Pushing a `gedpi-v*` tag runs the release workflow, verifies the repo again, publishes to npm through GitHub Actions trusted publishing with provenance, and then creates the GitHub release.
- Trusted publishing still requires npm-side setup for this repository/workflow in the npm package settings.

## Attribution

GedPi builds on the Pi ecosystem. See [CREDITS.md](CREDITS.md).

## License

MIT. See [LICENSE](LICENSE).
