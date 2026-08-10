# Architecture

## Current components

- `extensions/ged-core/`: Pi lifecycle hooks, workflow prompt injection,
  mutation/commit guards, runtime UI, and project bootstrap.
- `src/brain.ts`: main-agent system prompt and durable project context assembly.
- `src/orchestration.ts` + `src/vendor/shared-checkpoints.js`: current workflow
  checks and subagent completion projection.
- `src/agent-settings.ts` + `src/commands.ts`: role/model settings and runtime
  agent generation.
- `src/workflow.ts`, `src/work.ts`, `src/skills.ts`, `src/templates.ts`: durable
  memory, task artifacts, and project skill lifecycle.
- `pi-subagents`: optional child runtime; `pi-intercom`: optional independent
  session messaging. Native child-supervisor messaging is owned by
  `pi-subagents`.

## Approved target shape

GedPi has two orthogonal planes:

1. **Governance** selects `read-only`, `direct-change`, or `planned-change` from
   mutation intent, ambiguity, and risk. It owns task identity, approval,
   evidence, mutation, commit, and lifecycle rules and runs even without agents.
2. **Execution staffing** selects `solo`, `assisted`, `coordinated`, or
   `high-stakes` from decomposability, context spread, difficulty, and budget.
   Scouts/workers/verifiers produce capacity and evidence but never authorize
   work merely by running.

One versioned structured runtime record is authoritative per work item. Markdown
status/handoff files are projections. Branch is metadata, never task identity.
