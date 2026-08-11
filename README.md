# GedPi

A batteries-included [Pi](https://github.com/badlogic/pi-mono) package with an always-on workflow for clarifying, documenting the spec, and implementing work in bounded slices.

Requires Node.js 22 or newer.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/gedpi.svg)](https://www.npmjs.com/package/gedpi)
[![CI](https://github.com/edgyarmati/gedpi/actions/workflows/ci.yml/badge.svg)](https://github.com/edgyarmati/gedpi/actions/workflows/ci.yml)

## What It Does

- Starts with the full Ged workflow always active — the agent clarifies, runs skill-fit, plans, implements, and verifies in bounded slices.
- Keeps durable standards and project context in `.ged/`.
- Writes specs, tasks, and progress into `.ged/` and tracks workflow state across sessions.
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
- `skill-creator` — creating project-specific skills when nothing suitable exists
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
| **@plannotator/pi-extension** | Plan/code review UI; GedPi draft-plan approval prefers native Glimpse when available and falls back to Plannotator's browser UI |
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
| `/ged-agents` | Open the interactive subagent setup menu in UI sessions; configure role models, thinking levels, ordered fallbacks, critique mode, intercom, and optional workers. Use `/ged-agents status` for text status. |
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

Planned-change work may write its active `SPEC.md`, `TASKS.md`, and `TESTS.md`
before acceptance. Source mutation requires role-neutral accepted-plan evidence
recorded with `ged_governance`; commits require satisfied verification evidence
newer than the latest successful write/edit evidence. Successful commits are
milestones and do not close work automatically. `ged_lifecycle` explicitly
pauses, resumes, completes, abandons, or supersedes an exact work ID with an
auditable reason and timestamp; terminal work never reopens.

On the first agent turn GedPi also:

- lazily initializes or migrates `.ged/`;
- preserves legacy branch/root checkpoint data in ignored byte-exact backups,
  never as authorization;
- discovers external project standards and asks whether to retain them;
- maintains a compact runtime repo map under ignored `.pi/` state;
- runs skill-fit and installs/creates project skills only for real reusable
  capability gaps.

## Execution Staffing

`/ged-agents on|off` changes available capacity, not governance. With staffing
disabled, the coordinator performs the work directly. With staffing enabled,
focused assistants may inspect, draft, critique, implement isolated slices, or
verify. Their results are evidence proposals only: no role name, launch,
completion, or disabled-role fallback authorizes mutation. The coordinator
owns scope, decisions, final artifacts, evidence acceptance, commits, pushes,
and lifecycle.

Keep one writer per checkout/worktree. Use isolated worktrees only for
intentionally parallel writers. Native child-supervisor communication handles
spawned children; `pi-intercom` remains limited to explicit independent-session
dependencies.

### Current guard boundary

GedPi's runtime guards are an accident-prevention and evidence boundary, not an
OS sandbox. They currently enforce request binding and authoritative governance
for Pi `write`, `edit`, and detected `git commit` calls, protect runtime-owned
`.ged` paths through resolved symlinks, durably mark writes/edits pending before
execution, and record implementation evidence after successful completion.
Plan 002 broadens mutation-tool detection and binds approvals/verification to
content and staged Git bytes.

## Durable Memory

GedPi uses a three-tier memory architecture under `.ged/`. All memory is project-scoped and human-readable markdown.

### Root — durable project context

These files describe the project as it is now. They evolve slowly and persist across branches.

```
.ged/
├── PROJECT.md          goal, users, constraints, success criteria
├── ARCHITECTURE.md     component boundaries and system shape
├── PATTERNS.md         implementation conventions
├── GLOSSARY.md         project/domain vocabulary
├── DECISIONS.md        durable decisions and rationale
├── STANDARDS.md        imported repo-wide agent standards
├── SKILLS.md           skill inventory and recommendations
├── CONFIG.md           Ged configuration
└── VERSION             memory schema version
```

### Work — active implementation contracts

Scoped per work item under `.ged/work/<work-id>/`. Work IDs combine a readable
summary slug, sortable timestamp, and cryptographic entropy; Git branch names
are metadata only. Each Pi session keeps an ignored active-work pointer, and
each new agent request must explicitly open or continue work before mutation.

```
.ged/work/<work-id>/
├── SPEC.md             current work-item contract
├── TASKS.md            bounded implementation slices
├── TESTS.md            verification plan and evidence
├── NOTES.md            handoff notes local to this work
└── META.json           machine-readable work metadata
```

### Runtime — authoritative machine state

Per work item, runtime state is ignored and machine-owned. Markdown files are
projections/handoff notes only; guards read `governance.json`.

```
.ged/runtime/<work-id>/
├── governance.json     authoritative decision, lifecycle, evidence, revision
├── STATE.md            regenerable human-readable projection
└── SESSION-SUMMARY.md  optional handoff notes
```

Session-scoped selection pointers live under
`.ged/runtime/active-work/<session-key>.json`. Legacy `checkpoints.json` records
are discovered only by the migration compatibility path, copied to an immutable
ignored backup, and never selected or trusted as current authority.

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
