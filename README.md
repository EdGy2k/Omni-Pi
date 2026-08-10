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
| `/grill-me` | Start an explicit one-question-at-a-time clarification session, or record why clarification is skipped as sufficient |
| `/rtk` | Install RTK and check Ged's automatic bash-side RTK routing (status, install) |
| `/ged-agents` | Open the interactive subagent setup menu in UI sessions; configure role models, thinking levels, ordered fallbacks, critique mode, intercom, and optional workers. Use `/ged-agents status` for text status. |
| `/ged-settings` | Configure workflow preferences, including accepted-plan review: no extra review, chat approval, or visual approval (Glimpse preferred, browser fallback) |

### Auto-Updater

GedPi checks for new versions on startup (cached, re-checks every 4 hours). When an update is available, it prompts to install and restart. Pi's own update notification is suppressed to avoid duplication.

## Ged Workflow

GedPi always runs the full Ged workflow. There is no toggle — the agent classifies tasks as trivial or non-trivial and adjusts its behavior automatically.

- On the first agent turn, Ged lazily initializes or migrates `.ged/`.
- Ged discovers standards from files like `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, Copilot instructions, Cursor rules, Windsurf rules, and Continue rules, then asks whether to keep those standards in Ged's durable memory.
- Ged maintains a runtime repo map in `.pi/repo-map/` so prompts include a compact ranked view of important files and symbols.
- In Git repos, Ged ensures `.pi/` is ignored because that directory is only runtime-local Pi state.
- Every planned or executed task resolves required skills: in subagent mode, `ged-explorer` performs read-only skill-fit reconnaissance; the main brain then auto-installs matching skills into `.ged/project-skills/`, creates a project skill when none exists, records task-to-skill dependencies, and removes project skills once no open task still needs them.

## Orchestration Models

GedPi runs in one of two orchestration modes, controlled by `/ged-agents on|off`.

### Single-Brain Mode (default)

The agent does everything inline — classification, clarification (grill-me), skill-fit, planning, implementation, and verification — all in one brain.

```
┌─────────────────────────────────────────────────────┐
│                   GEDPI BRAIN                        │
│                                                      │
│  1. classify  2. clarify  3. skill-fit  4. plan     │
│  5. implement  6. verify  7. commit  8. record      │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ .ged/    │  │ source   │  │ .ged/runtime/     │  │
│  │ PROJECT  │  │ files    │  │ STATE.md          │  │
│  │ STANDARDS│  │          │  │ SESSION-SUMMARY   │  │
│  │ work/    │  │          │  │ checkpoints.json  │  │
│  │ SPEC.md  │  │          │  │                   │  │
│  │ TASKS.md │  │          │  │                   │  │
│  │ TESTS.md │  │          │  │                   │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### Subagent Mode (`/ged-agents on`)

The main brain delegates intelligence-gathering to read-only subagents. It remains the sole writer, synthesizer, and decision owner. Structural guards enforce the workflow.

```
                        ┌─────────────────────────┐
                        │     GEDPI BRAIN          │
                        │   (single writer)        │
                        │                          │
                        │  classify · clarify      │
                        │  synthesize · adjudicate │
                        │  implement · commit      │
                        └─────┬──────────┬────────┘
                              │          │
              ┌───────────────┘          └───────────────┐
              ▼                                          ▼
┌──────────────────────────┐              ┌──────────────────────────┐
│   ged-explorer           │              │   ged-planner            │
│   (read-only, cheap)     │              │   (read-only)            │
│                          │              │                          │
│  • skill-fit recon       │              │  • critique plan          │
│  • scout codebase        │              │  • identify edge cases    │
│  • map structure         │              │  • spot missing context   │
│  • report with evidence  │              │  • judge semantic         │
│                          │              │    sufficiency            │
└──────────────────────────┘              └──────────────────────────┘

              ┌──────────────────────────┐
              │   ged-verifier           │
              │   (read-only)            │
              │                          │
              │  • review diff & tests   │
              │  • report blockers       │
              │  • suggest fixes         │
              │  • clean-context review  │
              └──────────────────────────┘

┌───────────────────────────────────────────────────────────────┐
│                      STRUCTURAL GUARDS                         │
│                                                                │
│  ✗ No source inspection before explorer                        │
│  ✗ No edits without trusted planner + explorer + planAcceptance│
│  ✗ No commit without trusted verifier checkpoint               │
│  ✗ No planner without clarification evidence                   │
│  ✗ Planner consumed after every commit                         │
│  ✗ Only .md and .ged/ reads allowed pre-explorer               │
└───────────────────────────────────────────────────────────────┘
```

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

Scoped per-branch under `.ged/work/<work-id>/`. The work-id is the sanitized git branch name, or `root` when no branch exists. Each branch gets its own isolated planning namespace.

```
.ged/work/<work-id>/
├── SPEC.md             current work-item contract
├── TASKS.md            bounded implementation slices
├── TESTS.md            verification plan and evidence
├── NOTES.md            handoff notes local to this work
└── META.json           machine-readable work metadata
```

### Runtime — session state

Per-branch, ephemeral. Tracks current phase, session handoff, and checkpoint state. The checkpoint file enforces the subagent workflow.

```
.ged/runtime/<work-id>/
├── STATE.md            current phase, active task, blockers, next step
├── SESSION-SUMMARY.md  cross-session handoff notes
└── checkpoints.json    workflow checkpoint state (schema v3)
```

### Checkpoint Schema (v3)

The checkpoint file records checkpoint provenance. Structural guards trust auto-recorded checkpoints written from completed `subagent` results, plus explicit `source: "fallback"` checkpoints with reasons when a role is disabled and the main agent performed that responsibility. Unproven hand-written entries are rejected.

```json
{
  "schemaVersion": 3,
  "lifecycleStatus": "active",
  "classification": "non-trivial",
  "classificationReason": "Feature implementation",
  "clarification": {
    "status": "completed",
    "source": "manual",
    "evidence": { "goal": "...", "users": "...", "scope": "...", "constraints": "..." }
  },
  "planCheckpoints": {
    "ged-explorer": { "source": "auto", "status": "completed", ... },
    "ged-planner":  { "source": "auto", "status": "completed", ... }
  },
  "planAcceptance": {
    "status": "accepted",
    "source": "manual",
    "timestamp": "...",
    "planPaths": [".ged/work/<work-id>/SPEC.md", ".ged/work/<work-id>/TASKS.md", ".ged/work/<work-id>/TESTS.md"]
  },
  "taskCheckpoints": {
    "T01": {
      "ged-verifier": { "source": "auto", "status": "completed", ... }
    }
  },
  "workerRuns": [
    { "agent": "ged-worker", "source": "auto", "status": "completed", "runId": "...", "sliceId": "T01a", "sourceMode": "foreground" }
  ]
}
```

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
