# Imported Standards

These standards were imported from other harness-specific instruction files and approved for Ged use.

## AGENTS.md

```md
# AGENTS.md

This file provides guidance to Codex and other AI agents when working with code in this repository.

`AGENTS.md` is the canonical agent guidance for this repository. Keep harness-specific files such as `CLAUDE.md` as thin pointers to this file instead of duplicating the full instructions; if guidance changes, update this file first.

## Commands

- `npm test` — run the test suite (Vitest)
- `npm run check` — TypeScript type-check
- `npm run lint` — Biome lint + format check (use `npm run format` to auto-fix)
- `node ./bin/gedpi.js` — launch locally in dev mode

## Architecture

GedPi is a batteries-included Pi package built around a single conversational brain.

**Agent flow**: GedPi's single brain selects `read-only`, `direct-change`, or
`planned-change` governance from mutation intent, ambiguity, risk, and bounded
change evidence. Mutating requests explicitly open/continue task-scoped work;
authoritative governance state, not role invocation, controls mutation.

Execution staffing is orthogonal: keep the primary brain as user-facing decision
owner, use optional assistants only when useful, keep one writer per
checkout/worktree, and use `pi-intercom` only for explicit independent-session
dependencies. Assistant completion is evidence proposal, never authorization.

**Memory**: `.ged/` files hold durable project standards, context, and Ged workflow state — not source code. `.pi/` is Pi-runtime-local state and should stay out of Git.

**Extensions**: Pi loads extensions listed in `package.json` under `pi.extensions`. Custom entrypoints live in `extensions/`. Third-party extensions are referenced via `./node_modules/` paths.

**Bundled extensions and extension packages**:
- `ged-core` — brain workflow, header, shortcuts, updater, and `.ged/` durable memory bootstrap
- `glimpseui` — native micro-UI windows and floating companion widget
- `pi-web-access` — web search and fetch tools
- `pi-subagents` — `workflowScript` subagent runtime, native child-supervisor coordination, Ged-specific roles, and optional settings-gated worker support
- `pi-intercom` — optional communication between independent Pi sessions; it is not the authority path for spawned-child decisions
- `pi-diff-review` — diff review surface
- `pi-prompt-template-model` — prompt template / model wiring
- `@plannotator/pi-extension` — visual plan/code review UI used by the `plannotator` draft-plan review preference
- `agent-settings.ts` — preferences persistence in `~/.gedoc/settings.json`
- GedPi uses Pi's native input, footer, working indicator, command palette, user-message, tool, and read rendering; keep custom UI overrides out unless intentionally reintroduced.

**Skills**: Bundled workflow skills live in `skills/`. Pi discovers them via `pi.skills` in `package.json`.
Bundled defaults now include `find-skills`, `skill-creator`, and `brainstorming`, so Ged can discover, create, and use planning-oriented skills without external installation.

## Workflow

Always document plans and progress. Before making changes, state what you intend to do. After completing tasks, summarize what was done.

### Updating workflow prompts and agent contracts

When changing Ged's workflow, update the durable documentation and generated prompt sources together so new sessions inherit the same rules:

- `src/brain.ts` controls the text appended to the main agent system prompt.
- `src/orchestration.ts` controls the detailed subagent orchestration contract and guard messages.
- `src/agent-settings.ts` controls the bundled Ged runtime agent prompts generated into `.pi/agents/`: `ged-explorer`, `ged-planner`, `ged-plan-reviewer`, `ged-verifier`, and optional `ged-worker`.
- `src/commit-settings.ts` controls user-configurable workflow preferences that are also appended to the system prompt.
- `AGENTS.md` documents the intended workflow for future coding sessions.
- Keep `.ged/` memory schema changes deliberate and backward-compatible; GedPi is now the canonical implementation.

Ask one concise question only when a user-owned decision remains unresolved;
otherwise summarize naturally. Read-only work does not open mutating work.
Mutating work calls `ged_work open` with structured governance evidence.
Planned-change work writes bounded SPEC/TASKS/TESTS artifacts and records
accepted-plan evidence with `ged_governance` before source mutation.
Direct-change work skips plan ceremony. After checks and finding adjudication,
stage only observed work-scope paths, then let `ged_governance` execute checks
and bind verification to the exact snapshot before commit. Optional assistants can
inspect, draft, critique, implement isolated slices, or verify, but the main
brain accepts evidence and retains all scope/publication authority.
Lifecycle is explicit: use `ged_lifecycle` with an exact work ID and reason;
commits and assistant events never pause, resume, complete, abandon, or
supersede work.

The Ged workflow is always active:
- lazily initialize or migrate `.ged/` on the first real agent turn
- discover external standards files such as `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`, `.cursor/rules/**/*.mdc`, `.cursorrules`, `.windsurf/rules/**`, and `.continue/rules/**`
- ask the user whether to keep repo-wide standards in Ged's durable config
- run skill-fit for planned work and install/create project skills only for a
  real reusable capability gap
- ensure `.pi/` is ignored in `.gitignore` when the project is a Git repo

**Commits**: After completing any task — including individual implementation slices, bug fixes, refactors, or cleanup — create a git commit to snapshot the work. Commit every change you make unless the user explicitly asks not to. Before committing, run the relevant verification for the touched area and fix any failures. Use conventional commit format (`feat:`, `fix:`, `refactor:`, `chore:`, etc.). Never leave completed work uncommitted. Check `git status` after each task; if there are staged or unstaged changes, commit them.

**Changelog**: Every committed change that is user-facing (features, fixes, behavior changes, dependency bumps, deprecations) must add an entry under `## Unreleased` in `CHANGELOG.md`. Group entries by category (`### Features`, `### Fixes`, `### Documentation`, `### Dependencies`, etc.). Keep the changelog current during each slice — don't batch it at release time. On release, `## Unreleased` is renamed to `## X.Y.Z - YYYY-MM-DD` and a fresh `## Unreleased` header is added.

## Releases

GedPi is published to npm as `gedpi`.

### How to release

1. Ensure `CHANGELOG.md` has all changes under `## Unreleased`.
2. Bump `version` in `package.json` to the new version.
3. Rename `## Unreleased` to `## X.Y.Z - YYYY-MM-DD` and add a new `## Unreleased` section at the top.
4. Commit: `chore: release gedpi X.Y.Z`.
5. Tag: `git tag gedpi-vX.Y.Z`.
6. Push: `git push origin main --tags`.
7. The `release-gedpi.yml` workflow will: verify → npm pack → npm publish with provenance → create GitHub release.

### Tag format

- GedPi releases use `gedpi-v*` tags (e.g., `gedpi-v0.13.0`).

### Packaging guardrails

- Do not add published `file:` dependencies that point at vendored directories already included in `files` or loaded through `pi.extensions`. Npm may install nested `node_modules` inside those vendored directories, which can break global upgrades with stale `ENOTEMPTY` removal errors.
- For vendored extension code, include the source directory through `files`, load it via the `pi.extensions` path, and use peer dependencies for host-provided packages such as `glimpseui` and Pi APIs.
- Before releasing packaging changes, run `npm pack --dry-run` and confirm the tarball does not include nested `node_modules`, package lockfiles from vendored directories, or dependency links to vendored packages.

### Deprecation note

The previous npm package `omni-pi` is deprecated. `gedpi` is the active package.

## TypeScript

- ES modules only — NodeNext module resolution, `import.meta.url` for paths. No CommonJS in `src/` or `extensions/`.
- Strict mode enabled. `npm run check` must pass before committing.
- `bin/gedpi.js` is plain JS (not TypeScript) — the launcher has no compile step.

## Testing

Tests live in `tests/`. Vitest covers the durable planning/implementation workflow and extension wiring.

## Model API Keys

The Pi runtime manages model credentials externally. No API key setup is required in this repo.
```

## CLAUDE.md

```md
# CLAUDE.md

This repository keeps its detailed agent guidance in `AGENTS.md`.

Claude Code agents should read and follow `AGENTS.md` as the source of truth for commands, architecture, workflow, commit policy, TypeScript rules, testing, and model credential handling.

To keep guidance synchronized, update `AGENTS.md` first and keep this file as a thin pointer rather than duplicating the full instructions.
```

