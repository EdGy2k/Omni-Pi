---
name: find-skills
description: "Discover external skills during GedPi's skill-fit checkpoint. When the current bundled, project, and user skills don't cover a task's needs, search the open ecosystem via npx skills, evaluate candidates, and install through GedPi's project-skill mechanism. Triggers include \"how do I do X\", \"find a skill for X\", \"is there a skill for X\", \"skill for\", \"need a skill\", \"search for skills\", \"skill-fit\", \"ecosystem\""
---

# Find Skills: Ecosystem Discovery for GedPi's Skill-Fit Checkpoint

Part of GedPi's skill-fit workflow. In subagent-enabled workflows, `ged-explorer` normally performs the read-only inventory/evaluation/search and reports findings to the main brain; the main brain then decides whether to install or create project skills. In solo/no-subagent workflows, the main brain performs the whole checkpoint itself.

Use **after** `grill-me` (if needed) and **before** `skill-creator`. The flow is:

```
clarify → explorer read-only inventory/search (or main brain in solo mode) → main-agent install/create decisions → plan
```

Resist the urge to skip straight to `skill-creator` when an off-the-shelf skill exists. Conversely, don't exhaustively search when the gap is narrow and project-specific — go straight to `skill-creator`.

## When to Use

### During the skill-fit checkpoint (planned-change work)

When the inventory of bundled/project/user skills doesn't cover the clarified task, search the ecosystem for an existing skill before creating one from scratch.

### When the user asks directly

Use this when the user asks for help with a specific domain or capability — anything from "how do I write tests for this" to "I need a skill for React patterns."

## How GedPi Discovers Skills

GedPi loads skills from three tiers, in this priority order (last wins on name conflicts):

| Tier | Location | Source |
|---|---|---|
| Bundled | `skills/<name>/SKILL.md` | Shipped with GedPi |
| Project | `.ged/project-skills/<name>/SKILL.md` | Managed per-project via GedPi workflow |
| User | `~/.agents/skills/<name>/SKILL.md` | `npx skills add -g` or manual |

Use `npx skills list` to see what's globally available, and check `.ged/SKILLS.md` for what's currently installed/recommended in the project.

## The Skill-Fit Checkpoint

During planned-change work, before drafting the plan:

1. **Clarify** the task enough to judge skill needs.
2. **Inventory and select** what's available — bundled, project-scoped, and user skills. With subagents enabled, `ged-explorer` should do this read-only reconnaissance.
3. **Search** with this skill if coverage has gaps — search only for the missing capability. With subagents enabled, `ged-explorer` may run `npx skills find` and report candidates, but must not install anything.
4. **Decide/install/create** in the main brain: install project-scoped external skills if warranted, or create with `skill-creator` if no adequate skill exists and the gap is reusable at the project level.
5. **Proceed** to planning.

**Never install global/user skills automatically.** The GedPi workflow installs skills into `.ged/project-skills/` (project-scoped, cleaned up when tasks are done). External installation requires user consent.

## How to Search the Ecosystem

### 1. Check the leaderboard first

Browse [skills.sh](https://skills.sh/) to see top-ranked skills. High install counts (>1K) signal battle-tested packages.

### 2. Run the CLI search

```bash
npx skills find [query]
```

Queries should focus on the **missing capability**, not the general domain:

| Too broad | Better |
|---|---|
| `npx skills find react` | `npx skills find react performance` |
| `npx skills find testing` | `npx skills find playwright e2e` |
| `npx skills find python` | `npx skills find python testing` |

### 3. Evaluate each result

| Check | What to look for |
|---|---|
| Install count | ≥1K is solid, <100 is risky |
| Source reputation | Vercel Labs, established OSS authors |
| GitHub stars on source repo | <100 stars → skepticism |
| Content quality | Does the SKILL.md describe concrete patterns or vague advice? |

Only flag a skill as viable if its SKILL.md content meaningfully fills the gap. A skill that's tangentially related but doesn't actually help with the task at hand is noise.

## How to Install

There are three paths depending on context:

### A. Project-scoped install (GedPi workflow)

When the skill fits a task in the current plan, GedPi's `ensureTaskSkillDependencies()` copies the skill's content into `.ged/project-skills/<name>/SKILL.md` and tracks it in `SKILLS-STATE.json`. The skill is automatically cleaned up when no open task depends on it.

This is the **primary path** — it keeps skills scoped to the project that needs them.

### B. User-global install (explicit user consent only)

```bash
npx skills add <owner/repo>@<skill> -g -y
```

Installs to `~/.agents/skills/<name>/` where Pi discovers it across all projects. Only use this when:
- The user explicitly asks to install globally
- The skill is general-purpose (e.g., language patterns, testing frameworks)
- You've presented the option and the user approved

**Do not auto-install globally during the Ged workflow.**

### C. Project-local creation (no adequate external skill)

When the search turns up nothing suitable and the gap is reusable within the project, use `skill-creator` to author a narrow project-local skill. This keeps the knowledge scoped to `.ged/project-skills/` without polluting the global namespace.

## Common Search Categories

| Category | Example queries |
|---|---|
| Web Development | `react nextjs`, `typescript css`, `tailwind design` |
| Testing | `playwright e2e`, `vitest`, `jest mocking` |
| DevOps | `docker compose`, `ci-cd github actions` |
| Documentation | `api docs`, `changelog`, `readme` |
| Code Quality | `code review`, `lint`, `refactoring` |
| Design | `ui ux`, `accessibility`, `design-system` |
| Productivity | `git workflow`, `automation`, `project setup` |

## Presenting Results to the User

When you find relevant skills, present them clearly:

```
Found a skill that fits: "react-performance" from vercel-labs/agent-skills
- Install count: 185K
- Covers: React rendering optimization, memo patterns, bundle analysis
- Source: github.com/vercel-labs/agent-skills

Two install options:
1. Project-scoped (recommended): I'll set it up in .ged/project-skills/
2. Global (npx): npx skills add vercel-labs/agent-skills@react-performance -g
```

Let the user decide. If they choose project-scoped, GedPi handles the install.

## When No Skills Are Found

If the search returns nothing useful:

1. Acknowledge the gap clearly
2. Assess whether it's a one-off task (just do it with general capabilities) or a reusable pattern
3. If reusable, offer to create a project-local skill via `skill-creator`

```
I searched for "rust embedded no-std patterns" and didn't find a match.
This looks like a one-off task — I can handle it directly.
If it comes up again, I can create a project-local skill for it.
```

## Guiding principles

- **Search narrow, not broad** — query for the missing capability, not the whole domain
- **Prefer project-scoped installs** — keeps skills tied to the projects that need them
- **Don't auto-install globally** — user consent required for `npx skills add -g`
- **`skill-creator` is the fallback** — when no external skill fits, create a project-local one
- **YAGNI for skills too** — don't install skills for hypothetical future needs
